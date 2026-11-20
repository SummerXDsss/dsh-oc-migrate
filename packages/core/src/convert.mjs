import path from 'node:path';
import { dshLabel } from './labels.mjs';
import { attachDshEnvelope, nativeBridge } from './message-format.mjs';
import { transcodeNativeRecord } from './native-format.mjs';
import { digest, validateBundle, SURFACE_TYPES } from './protocol.mjs';

// Version both the converted session IDs and middleware jobs when projection changes.
export const CONVERTER_REVISION = 'dsh-to-oc-format-v3';

const zeros = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
function usage(value = {}) {
  const n = key => Number.isFinite(value[key]) ? value[key] : 0;
  return { input: n('inputTokens'), output: n('outputTokens'), reasoning: n('reasoningTokens'), cache: { read: n('cacheReadTokens'), write: n('cacheWriteTokens') } };
}
const blockText = block => typeof block.text === 'string' ? block.text : `[DSH ${block.type ?? 'unknown'} 原始记录] ${JSON.stringify(block)}`;
const textContent = content => content.map(blockText).join('\n');
function argumentsObject(raw, warnings) {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* 原始参数仍被保留，不执行 */ }
  warnings.push('工具参数不是 JSON 对象，保留为 _dshRawArguments');
  return { _dshRawArguments: raw };
}

/** raw log 全量留在迁移包；仅有效 surface 成为下一轮模型上下文。 */
export function convertBundle(bundle, options) {
  validateBundle(bundle);
  if (!options || !path.isAbsolute(options.directory)) throw new Error('目标 directory 必须为本机绝对路径');
  const generation = options.generation ?? 'v1';
  if (!['v1', 'v2'].includes(generation)) throw new Error('generation 应为 v1 或 v2');
  return bundle.sessions.flatMap(session => {
    const config = { ...options, generation };
    const active = convertSession(session, config);
    const allMessages = session.events.filter(event => SURFACE_TYPES.has(event.type));
    return options.includeArchive !== false && allMessages.length > session.surfaceEventSeqs.length
      ? [active, convertSession(session, { ...config, archive: true })] : [active];
  });
}

function convertSession(source, options) {
  const { directory, generation } = options;
  const sourceTitle = dshLabel(source).title;
  const target = { providerID: options.provider ?? 'deepseek', modelID: options.model ?? 'deepseek-chat' };
  const events = options.archive ? source.events.filter(event => SURFACE_TYPES.has(event.type)) : source.surfaceEventSeqs.map(seq => source.events[seq]);
  const states = new Map();
  if (options.stateSnapshots !== false) for (const event of source.events) if (/^(todo|goal)[/]/.test(event.type)) states.set(event.type.split('/')[0], event);
  // /oc-migrate 本身也会记 command/run/done；仅原始审计尾巴变化不应复制聊天。
  const revision = digest({ converter: CONVERTER_REVISION, header: source.header, title: sourceTitle, inheritedEventCount: source.inheritedEventCount ?? 0, events, formats: source.events.filter(event => event.type === 'migration/opencode-message').map(event => event.data), states: [...states.values()], directory, generation, target, archive: !!options.archive });
  const sessionID = `ses_${revision.slice(0, 26)}`;
  const warnings = [];
  // 先配对结果再转换 assistant；不把 tool/result 重复写成用户消息。
  const results = new Map();
  for (const event of events.filter(event => !options.archive && event.type === 'tool/result')) {
    const id = event.data.message.toolCallId;
    if (results.has(id)) throw new Error(`重复工具结果：${id}`);
    results.set(id, event);
  }
  const bridges = new Map();
  if (!options.archive && !options.provider && !options.model) for (const event of source.events) {
    const from = event.data?.generation;
    const bridge = nativeBridge(source, event, from);
    if (bridge) bridges.set(bridge.seqs[0], { ...bridge, generation: from });
  }
  const skipped = new Set(), consumed = new Set(), records = [];
  let parentID, outputTime = source.header.createdAt, partSerial = 0;
  const makeID = (prefix, index) => `${prefix}_${source.header.createdAt.toString(16).padStart(12, '0')}${index.toString(16).padStart(6, '0')}${revision.slice(0, 12)}`;
  function add(role, parts, event, model = target) {
    const interrupted = !!event.data.interrupted;
    if (interrupted) warnings.push(`事件 #${event.seq} 为中断响应，已保留中断标记`);
    const terminal = event.data.stream?.findLast(entry => entry.chunk?.type === 'finish')?.chunk.reason;
    const finish = interrupted || ['aborted', 'error'].includes(terminal?.kind) ? 'error' : terminal?.kind === 'max-tokens' ? 'length' : parts.some(p => p.type === 'tool') ? 'tool-calls' : 'stop';
    // surface 替换可以把较晚的事件插回较早位置；保持显示时间非递减，原时间另存。
    const index = records.length, id = makeID('msg', index), time = Math.max(outputTime, event.time);
    outputTime = time;
    const metadata = { dsh: { sessionID: source.header.id, eventSeq: event.seq, eventType: event.type, originalTime: event.time } };
    if (generation === 'v1') {
      const info = role === 'assistant'
        ? { id, sessionID, role, parentID, time: { created: time, completed: time }, modelID: model.modelID, providerID: model.providerID, agent: 'build', mode: 'build', path: { cwd: directory, root: directory }, cost: 0, tokens: usage(event.data.usage), finish }
        : { id, sessionID, role: 'user', time: { created: time }, agent: 'build', model: target };
      const mapped = parts.map((part, pi) => {
        const base = { id: makeID('prt', partSerial++), sessionID, messageID: id, metadata };
        if (part.type === 'reasoning') return { ...base, type: 'reasoning', text: part.text, time: { start: time, end: time } };
        if (part.type !== 'tool') return { ...base, type: 'text', text: part.text, ...(part.snapshot ? { metadata: { ...metadata, dshToolSnapshot: digest(part.text) } } : {}) };
        const state = { input: part.input, metadata: { dshHistorical: true }, time: { start: time, end: Math.max(time, part.time) } };
        return { ...base, type: 'tool', callID: part.id, tool: part.name, state: part.error
          ? { ...state, status: 'error', error: part.output }
          : { ...state, status: 'completed', output: part.output, title: part.name } };
      });
      records.push({ info, parts: mapped });
    } else {
      const base = { id, type: role, time: { created: time }, metadata };
      if (role !== 'assistant') records.push({ ...base, type: 'user', text: parts.map(part => part.text).join('') });
      else records.push({ ...base, agent: 'build', model: { providerID: model.providerID, id: model.modelID }, time: { created: time, completed: time }, finish, cost: 0, tokens: usage(event.data.usage), content: parts.map(part => {
        if (part.type !== 'tool') return { type: part.type, text: part.text };
        const content = part.content?.length ? part.content : [{ type: 'text', text: part.output }];
        return { type: 'tool', id: part.id, name: part.name, executed: true, time: { created: time, completed: Math.max(time, part.time) }, state: part.error
          ? { status: 'error', input: part.input, error: { type: 'dsh-historical', message: part.output }, content }
          : { status: 'completed', input: part.input, content } };
      }) });
    }
    const record = records.at(-1);
    if (generation === 'v2') record.metadata.dsh.snapshots = parts.flatMap((part, index) => part.snapshot ? [{ index, hash: digest(part.text) }] : []);
    // Only genuine source messages get an envelope, never archive/state helpers.
    if (!options.archive && ['user/message', 'system/message', 'assistant/message'].includes(event.type)) {
      const toolResults = parts.filter(p => p.type === 'tool').map(p => results.get(p.id)).filter(Boolean).map(e => ({ type: e.type, time: e.time, data: e.data }));
      attachDshEnvelope(record, event, toolResults);
    }
    if (role !== 'assistant') parentID = id;
  }
  for (const event of events) {
    if (skipped.has(event.seq)) continue;
    const bridge = bridges.get(event.seq);
    const projected = bridge && transcodeNativeRecord(bridge.record, bridge.generation, generation, { directory, parentID, warnings });
    if (projected) {
      const record = projected, index = records.length, id = makeID('msg', index);
      if (generation === 'v1') {
        record.info.id = id; record.info.sessionID = sessionID;
        if (record.info.role === 'assistant') { record.info.parentID = parentID; record.info.path = { cwd: directory, root: directory }; }
        else parentID = id;
        record.parts.forEach((part, pi) => {
          Object.assign(part, { id: makeID('prt', partSerial++), sessionID, messageID: id });
          part.state?.attachments?.forEach((file, ai) => Object.assign(file, { id: makeID('prt', partSerial++), sessionID, messageID: id }));
        });
      } else record.id = id;
      for (const e of bridge.events) {
        skipped.add(e.seq);
        if (e.type === 'assistant/message') for (const block of e.data.message.content) if (block.type === 'tool-call') consumed.add(block.id);
      }
      records.push(record);
      outputTime = Math.max(outputTime, (record.info ?? record).time.created);
      continue;
    }
    if (options.archive) {
      const message = event.type === 'user/message' ? event.data : event.data.message;
      const prefix = `[DSH 原始事件 #${event.seq} ${event.type}；${source.surfaceEventSeqs.includes(event.seq) ? '当前有效' : '已被替换'}]\n`;
      if (event.type === 'assistant/message' && !parentID) add('user', [{ type: 'text', text: '[归档全文：仅用于查阅，不恢复执行]' }], event);
      const parts = [{ type: 'text', text: prefix }, ...message.content.map(block => ({ type: block.type === 'reasoning' ? 'reasoning' : 'text', text: blockText(block) }))];
      add(event.type === 'assistant/message' ? 'assistant' : 'user', parts, event);
      continue;
    }
    if (event.type === 'tool/result') continue;
    const message = event.type === 'user/message' ? event.data : event.data.message;
    if (event.type !== 'assistant/message') {
      if (!message.content.length) warnings.push(`事件 #${event.seq} 为空消息，已保留空正文`);
      if (message.content.some(block => !['text'].includes(block.type))) warnings.push(`事件 #${event.seq} 的非文字用户/上下文块已保留原始结构与文字快照；附件字节未复制`);
      if (event.type !== 'user/message') warnings.push(`事件 #${event.seq} 的 ${message.role ?? event.type} 角色保存为历史上下文快照，不替代目标系统配置`);
      const prefix = event.type === 'user/message' ? '' : `[DSH 历史 ${message.role ?? event.type} 上下文快照；非 OpenCode 系统配置]\n`;
      const blocks = message.content.map(block => ({ type: 'text', text: blockText(block) }));
      if (prefix) blocks.unshift({ type: 'text', text: prefix });
      add('user', blocks.length ? blocks : [{ type: 'text', text: '' }], event);
      continue;
    }
    if (generation === 'v1' && !parentID) { warnings.push('原始截面没有前置用户消息，1.x 添加历史说明以满足 parentID'); add('user', [{ type: 'text', text: '[DSH 迁移：原始截面没有前置用户消息，以下为历史响应。]' }], { ...event, type: 'migration/synthetic' }); }
    const parts = message.content.map(block => {
      if (block.type === 'text' || block.type === 'reasoning') return { type: block.type, text: block.text };
      if (block.type !== 'tool-call') {
        warnings.push(`附件或扩展块 ${block.type} 以原始引用文字保留，未复制字节`);
        return { type: 'text', text: blockText(block) };
      }
      const result = results.get(block.id);
      if (consumed.has(block.id)) throw new Error(`重复工具调用 id：${block.id}`);
      consumed.add(block.id);
      if (!result) warnings.push(`工具 ${block.id} 缺少结果，已标记为历史中断`);
      if (generation === 'v1' && result?.data.message.content.length > 1) warnings.push(`工具 ${block.id} 的多段结果合并为 1.x output，分块原件保留`);
      if (result?.data.message.content.some(part => part.type !== 'text')) warnings.push(`工具 ${block.id} 的非文字结果保留为原始结构快照；附件字节未复制`);
      return { type: 'tool', id: block.id, name: block.name, input: argumentsObject(block.arguments, warnings), content: result?.data.message.content.map(part => ({ type: 'text', text: blockText(part) })), output: result ? textContent(result.data.message.content) : '[DSH 历史中断：没有工具结果；迁移未重新执行]', error: !result || !!result.data.message.isError, time: result?.time ?? event.time };
    });
    const original = message.source;
    const model = options.provider || options.model ? target : { providerID: original?.provider ?? target.providerID, modelID: original?.model ?? target.modelID };
    // OpenCode 2.3.2's generic tool renderer doesn't expand DSH tool results.
    // Retain native completed/error tool parts AND a readable historical copy.
    // This is imported content, not a tool execution or a new model response.
    const readable = parts.flatMap(part => part.type !== 'tool' ? [part] : [part, {
      type: 'text', snapshot: true, text: `[DSH 历史工具快照 · ${part.name} · ${part.id} · ${part.error ? '错误/中断' : '已完成'}；未重新执行]\n参数：\n${JSON.stringify(part.input, null, 2)}\n结果：\n${part.output || '(工具返回空结果)'}`,
    }]);
    add('assistant', readable, event, model);
  }
  for (const [id, event] of results) {
    if (!consumed.has(id)) {
      warnings.push(`工具结果 ${id} 没有有效 surface 调用，已保留为文字`);
      add('user', [{ type: 'text', text: `[DSH 孤立工具结果 ${id}]\n${textContent(event.data.message.content)}` }], event);
    }
  }
  if (options.stateSnapshots !== false) {
    if (states.size) add('user', [{ type: 'text', text: '[DSH 状态快照；仅作历史背景，不恢复任务执行]\n' + [...states.values()].map(event => `${event.type}: ${JSON.stringify(event.data)}`).join('\n') }], [...states.values()].at(-1));
  }
  const created = source.header.createdAt, updated = source.events.reduce((time, event) => Math.max(time, event.time), created);
  const metadata = { dshMigration: { revision, view: options.archive ? 'archive' : 'active', sourceID: source.header.id, parentSession: source.header.parentSession ?? null, sourceCwd: source.header.cwd ?? null, rawEventCount: source.events.length, surfaceEventCount: events.length } };
  const title = (options.archive ? '[归档全文] ' : '') + sourceTitle;
  const info = generation === 'v1'
    ? { id: sessionID, slug: `dsh-${revision.slice(0, 12)}`, projectID: 'global', directory, title, version: '1.18.31', time: { created, updated }, metadata }
    : { id: sessionID, projectID: 'global', location: { directory }, title, cost: 0, tokens: zeros(), time: { created, updated }, metadata };
  return { sourceID: source.header.id, sessionID, revision, generation, warnings, transcript: { info, messages: records } };
}
