// OpenCode 1.x / 2.x -> DSH native v4. Never schedules or executes historical tools.
import path from 'node:path';
import { openCodeLabel } from './labels.mjs';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { digest, foldSurface } from './protocol.mjs';

const json = value => JSON.stringify(value, null, 2);
const text = value => typeof value === 'string' ? value : json(value);
const millis = (value, fallback) => {
  const n = typeof value === 'string' ? Date.parse(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
};
export function encodeDshSession(session) {
  const header = sessionFormatCatalog.encodeCurrentHeader(session.header, 0);
  const rows = session.events.map(event => sessionFormatCatalog.encodeCurrentEvent(event));
  // The owning DSH codec checks lifecycle, tools, titles and native message schemas.
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' });
  for (const row of rows) restore.decodeRow(row);
  restore.finish();
  return Buffer.from([header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n');
}
export function convertOpenCode(transcript) {
  if (!transcript?.info || typeof transcript.info.id !== 'string' || !Array.isArray(transcript.messages)) throw new Error('需要完整的 OpenCode 原生 export JSON');
  const revision = digest({ converter: 'oc-to-dsh-v4-1', transcript }), id = `ocm-${revision.slice(0, 48)}`;
  const createdAt = millis(transcript.info.time?.created, 0);
  const cwd = transcript.info.location?.directory ?? transcript.info.directory;
  const header = { id, version: 4, createdAt, isSeeded: false, delegationDepth: 0,
    ...(typeof cwd === 'string' && path.isAbsolute(cwd) ? { cwd: path.normalize(cwd) } : {}) };
  const events = [], warnings = [], textBlock = value => ({ type: 'text', text: value });
  let time = createdAt, turn = 0;
  function event(type, data, surface = false) {
    events.push({ seq: events.length, time, type, data, ...(surface ? { surfaceOp: 'append' } : {}) });
  }
  function user(content, key, source = { kind: 'user' }) {
    event('user/message', { id: `ocm-msg-${digest([id, key]).slice(0, 40)}`, role: 'user', source, content }, true);
  }
  for (const [index, record] of transcript.messages.entries()) {
    const info = record.info ?? record, role = record.info?.role ?? record.type;
    time = Math.max(time, millis(info.time?.created, time));
    turn++; const step = 1;
    event('turn/start', { turn }); event('step/start', { turn, step });
    const parts = record.parts ?? record.content ?? (typeof record.text === 'string' ? [textBlock(record.text)] : []);
    if (!Array.isArray(parts)) throw new Error(`OpenCode 消息 ${index} content 格式错误`);
    if (role !== 'assistant') {
      const content = parts.map(part => part.type === 'text' ? textBlock(part.text ?? '') : textBlock(`[OpenCode ${part.type ?? '未知内容'}]\n${json(part)}`));
      if (role !== 'user') {
        content.unshift(textBlock(`[OpenCode ${role ?? '未知事件'} 历史快照]\n${json(record)}`));
        warnings.push(`${info.id ?? index}: ${role} 保存为上下文快照`);
      } else if (record.files?.length || record.agents?.length || record.skills?.length) {
        content.push(textBlock(`[OpenCode 附件与引用]\n${json({ files: record.files, agents: record.agents, skills: record.skills })}`));
        warnings.push(`${info.id ?? index}: 附件引用保留，字节保存在原始 export 中（若原件包含）`);
      }
      user(content, index, role === 'user' ? { kind: 'user' } : { kind: 'oc-migrate', form: 'snapshot', summary: `OpenCode ${role} 历史` });
    } else {
      const tools = [], content = [];
      for (const [partIndex, part] of parts.entries()) {
        if (['text', 'reasoning'].includes(part.type)) content.push({ type: part.type, text: part.text ?? '' });
        else if (part.type === 'tool') {
          const callId = `ocm-call-${index}-${partIndex}`;
          const name = part.tool ?? part.name ?? 'unknown';
          const state = part.state ?? {};
          const args = JSON.stringify(state.input ?? part.input ?? {});
          content.push({ type: 'tool-call', id: callId, name, arguments: args });
          tools.push({ part, state, callId, name, args });
        } else { content.push(textBlock(`[OpenCode ${part.type ?? '未知内容'}]\n${json(part)}`)); warnings.push(`${info.id ?? index}: ${part.type} 保存为文本快照`); }
      }
      const model = { provider: info.providerID ?? info.model?.providerID ?? 'opencode', model: info.modelID ?? info.model?.id ?? 'historical' };
      if (info.error) content.push(textBlock(`[OpenCode 响应错误]\n${json(info.error)}`));
      event('assistant/message', { turn, step, message: { id: `ocm-msg-${digest([id, index]).slice(0, 40)}`, role: 'assistant', source: { kind: 'model', ...model }, content }, stream: [] }, true);
      for (const { part, state, callId, name, args } of tools) {
        event('tool/call', { turn, step, callId, name, arguments: args });
        const completed = state.status === 'completed', failed = !completed;
        const result = record.info ? state.output ?? state.error : state.content ?? state.error;
        const output = Array.isArray(result) ? result.map(block => block.type === 'text' ? textBlock(block.text) : textBlock(`[OpenCode 工具内容]\n${json(block)}`)) : [textBlock(result === undefined ? `[OpenCode 历史工具 ${state.status ?? '未完成'}；迁移未执行]` : text(result))];
        // Settle pending/running calls as historical errors, never leave replayable work.
        if (!completed && state.status !== 'error') warnings.push(`${info.id ?? index}: 未完成工具已关闭为历史错误`);
        event('tool/result', { turn, step, message: { id: `${callId}-result`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: output, ...(failed ? { isError: true } : {}) }, meta: { opencodeHistorical: true, originalCallID: part.callID ?? part.id, originalState: state.status ?? 'unknown' } }, true);
      }
    }
    event('step/end', { turn, step }); event('turn/end', { turn, reason: { kind: 'completed' } });
  }
  event('session/title', { title: openCodeLabel(transcript).title, messageSeqs: [], source: { kind: 'user' } });
  const session = { header, inheritedEventCount: 0, title: events.at(-1).data.title, events, surfaceEventSeqs: foldSurface(events) };
  const bytes = encodeDshSession(session);
  return { sourceID: transcript.info.id, sessionID: id, revision, session, bytes, warnings };
}
