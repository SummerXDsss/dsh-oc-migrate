// OpenCode 1.x / 2.x -> native DSH v4. Conversion never dispatches tools.
import path from 'node:path';
import { openCodeLabel } from './labels.mjs';
import { digest, foldSurface } from './protocol.mjs';
import { dshEnvelope, surfaceHash, toDshUsage, withoutGeneratedSnapshots } from './message-format.mjs';
import { convertOpenCode as legacy, encodeDshSession } from './reverse-legacy.mjs';
export { encodeDshSession };
export const REVERSE_CONVERTER_REVISION = 'oc-to-dsh-format-v4-2';
export const LEGACY_REVERSE_REVISION = 'oc-to-dsh-v4-1';
const json = value => JSON.stringify(value, null, 2);
const text = value => typeof value === 'string' ? value : json(value);
const millis = (value, fallback) => {
  const n = typeof value === 'string' ? Date.parse(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
};
const textBlock = value => ({ type: 'text', text: value });

export function convertOpenCode(transcript, { revision: requested = REVERSE_CONVERTER_REVISION } = {}) {
  if (requested === LEGACY_REVERSE_REVISION) return legacy(transcript);
  if (requested !== REVERSE_CONVERTER_REVISION) throw new Error('未知反向格式转换版本，请保留迁移原件');
  if (!transcript?.info || typeof transcript.info.id !== 'string' || !Array.isArray(transcript.messages)) throw new Error('需要完整的 OpenCode 原生 export JSON');
  const generation = transcript.messages.some(record => record.info) ? 'v1' : 'v2';
  const revision = digest({ converter: REVERSE_CONVERTER_REVISION, transcript }), id = `ocm-${revision.slice(0, 48)}`;
  const createdAt = millis(transcript.info.time?.created, 0);
  const cwd = transcript.info.location?.directory ?? transcript.info.directory;
  const header = { id, version: 4, createdAt, isSeeded: false, delegationDepth: 0,
    ...(typeof cwd === 'string' && path.isAbsolute(cwd) ? { cwd: path.normalize(cwd) } : {}) };
  const events = [], warnings = [], callIDs = new Set(), messageIDs = new Set();
  let time = createdAt, turn = 0, protectedHead = false;
  if (transcript.info.parentID) warnings.push('源对话为分支：父会话引用保存在原件，DSH 目标作为独立可读会话，不伪造父子链接');
  function event(type, data, surface = false, originalTime = time) {
    const item = { seq: events.length, time: originalTime, type, data, ...(type === 'migration/opencode-message' ? { ignorable: true } : {}), ...(surface ? { surfaceOp: 'append' } : {}) };
    events.push(item); return item;
  }
  function identify(message, key) {
    let messageID = message.id;
    if (typeof messageID !== 'string' || !messageID || messageIDs.has(messageID)) messageID = `ocm-msg-${digest([id, key]).slice(0, 40)}`;
    messageIDs.add(messageID); return { ...message, id: messageID };
  }
  function user(content, key, source = { kind: 'user' }) {
    return event('user/message', identify({ role: 'user', source, content }, key), true);
  }
  function snapshot(record, key, role) {
    warnings.push(`${key}: ${role} 没有等价 DSH 消息，保存为历史快照及原始结构`);
    user([textBlock(`[OpenCode ${role} 历史快照]\n${json(record)}`)], key, { kind: 'oc-migrate', form: 'recall' });
  }
  for (const [index, record] of transcript.messages.entries()) {
    const info = record.info ?? record, role = record.info?.role ?? record.type;
    if (!info || typeof info.id !== 'string') throw new Error(`OpenCode 消息 ${index} 缺少 id`);
    time = Math.max(time, millis(info.time?.created, time));
    turn++; const step = 1;
    event('turn/start', { turn }); event('step/start', { turn, step });
    const first = events.length, envelope = dshEnvelope(record);
    const parts = record.parts ?? record.content ?? (typeof record.text === 'string' ? [textBlock(record.text)] : []);
    if (!Array.isArray(parts)) throw new Error(`OpenCode 消息 ${index} content 格式错误`);
    const originalEvent = envelope?.event;
    let restored = false;
    // Restore only a content-verified DSH source, not text that merely resembles
    // a migration annotation. Developer tool-definition events remain snapshots.
    if (originalEvent && ['user/message', 'system/message', 'assistant/message'].includes(originalEvent.type)) {
      const original = originalEvent.type === 'user/message' ? originalEvent.data : originalEvent.data.message;
      const blocks = original?.content;
      const calls = Array.isArray(blocks) ? blocks.filter(block => block.type === 'tool-call') : [];
      const canRestoreSystem = originalEvent.type !== 'system/message' || protectedHead || !events.some(e => e.surfaceOp);
      if (original && Array.isArray(blocks) && canRestoreSystem && calls.every(call => !callIDs.has(call.id))) {
        const message = identify(structuredClone(original), index);
        if (originalEvent.type === 'user/message') event('user/message', message, true, originalEvent.time);
        else {
          const data = { ...structuredClone(originalEvent.data), turn, step, message };
          event(originalEvent.type, data, true, originalEvent.time);
          if (originalEvent.type === 'system/message') protectedHead = true;
        }
        for (const call of calls) {
          callIDs.add(call.id);
          event('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments });
          const result = envelope.results?.find(e => e.data?.message?.toolCallId === call.id);
          const data = result ? { ...structuredClone(result.data), turn, step, message: identify(structuredClone(result.data.message), `${index}-${call.id}`) }
            : { turn, step, message: identify({ role: 'tool', source: { kind: 'tool', callId: call.id }, toolCallId: call.id, content: [textBlock('[DSH 历史中断：没有工具结果；迁移未重新执行]')], isError: true }, `${index}-${call.id}`) };
          event('tool/result', data, true, result?.time ?? time);
        }
        restored = true;
      }
    }
    if (!restored && role !== 'assistant') {
      if (role !== 'user') snapshot(record, index, role ?? '未知事件');
      else {
        const content = parts.map(part => part.type === 'text' ? textBlock(part.text ?? '') : textBlock(`[OpenCode ${part.type ?? '未知内容'}]\n${json(part)}`));
        const attachments = record.files?.length || record.agents?.length || record.skills?.length || parts.some(p => !['text'].includes(p.type));
        if (record.files?.length || record.agents?.length || record.skills?.length) content.push(textBlock(`[OpenCode 附件与引用]\n${json({ files: record.files, agents: record.agents, skills: record.skills })}`));
        if (attachments) warnings.push(`${info.id}: 附件/引用保留在原始结构与快照中，未写入 DSH 附件库；引用不代表字节已迁移`);
        user(content, index);
      }
    } else if (!restored) {
      const tools = [], content = [];
      for (const [partIndex, part] of withoutGeneratedSnapshots(record).entries()) {
        if (['text', 'reasoning'].includes(part.type)) content.push({ type: part.type, text: part.text ?? '' });
        else if (part.type === 'tool') {
          const originalID = part.callID ?? part.id;
          const callId = typeof originalID === 'string' && originalID && !callIDs.has(originalID) ? originalID : `ocm-call-${index}-${partIndex}`;
          callIDs.add(callId);
          const name = part.tool ?? part.name ?? 'unknown', state = part.state ?? {};
          const raw = state.input ?? part.input ?? {};
          const args = typeof raw === 'string' ? raw : JSON.stringify(raw);
          content.push({ type: 'tool-call', id: callId, name, arguments: args });
          tools.push({ part, state, callId, name, args });
        } else { content.push(textBlock(`[OpenCode ${part.type ?? '未知内容'}]\n${json(part)}`)); warnings.push(`${info.id}: ${part.type} 保存为文本快照及原始结构`); }
      }
      const model = { provider: info.providerID ?? info.model?.providerID ?? 'opencode', model: info.modelID ?? info.model?.id ?? 'historical' };
      if (info.error) content.push(textBlock(`[OpenCode 响应错误]\n${json(info.error)}`));
      const usage = toDshUsage(info.tokens);
      event('assistant/message', { turn, step, message: identify({ role: 'assistant', source: { kind: 'model', ...model }, content }, index), stream: [], ...(usage ? { usage } : {}), ...(info.error || info.finish === 'error' || info.time?.completed === undefined ? { interrupted: true } : {}) }, true);
      for (const { part, state, callId, name, args } of tools) {
        const toolTime = millis(part.time?.completed ?? state.time?.end, time);
        event('tool/call', { turn, step, callId, name, arguments: args }, false, millis(part.time?.created ?? state.time?.start, time));
        const completed = state.status === 'completed', failed = !completed;
        const result = record.info ? state.output ?? state.error : state.content ?? state.error;
        const output = Array.isArray(result) ? result.map(block => block.type === 'text' ? textBlock(block.text) : textBlock(`[OpenCode 工具内容]\n${json(block)}`)) : [textBlock(result === undefined ? `[OpenCode 历史工具 ${state.status ?? '未完成'}；迁移未执行]` : text(result))];
        if (Array.isArray(result) && result.some(block => block.type !== 'text')) warnings.push(`${info.id}: 工具附件保留原始结构与引用，未写入 DSH 附件库`);
        if (!completed && state.status !== 'error') warnings.push(`${info.id}: 未完成工具已关闭为历史错误，原始状态保留`);
        event('tool/result', { turn, step, message: identify({ role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: output, ...(failed ? { isError: true } : {}) }, `${index}-${callId}`), meta: { opencodeHistorical: true, originalCallID: part.callID ?? part.id, originalState: state.status ?? 'unknown', ...(state.error ? { originalError: state.error } : {}), ...(state.metadata ? { originalMetadata: state.metadata } : {}) } }, true, toolTime);
      }
    }
    const surface = events.slice(first).filter(e => e.surfaceOp);
    // Explicitly ignorable extension: the official DSH codec preserves this while
    // deriving only the native surface. It enables exact same-generation return.
    event('migration/opencode-message', { version: 1, generation, record, surfaceEventSeqs: surface.map(e => e.seq), projectionHash: surfaceHash(surface) });
    event('step/end', { turn, step }); event('turn/end', { turn, reason: { kind: 'completed' } });
  }
  event('session/title', { title: openCodeLabel(transcript).title, messageSeqs: [], source: { kind: 'user' } });
  const session = { header, inheritedEventCount: 0, title: events.at(-1).data.title, events, surfaceEventSeqs: foldSurface(events) };
  const bytes = encodeDshSession(session);
  return { sourceID: transcript.info.id, sessionID: id, revision, session, bytes, warnings, converterRevision: REVERSE_CONVERTER_REVISION };
}
