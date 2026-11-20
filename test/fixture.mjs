import { FORMAT, foldSurface } from '../packages/core/src/protocol.mjs';

export function fixture({ compact = false, id = 'dsh-example-中文' } = {}) {
  const events = [];
  const message = (role, content, extra = {}) => ({ id: `dsh-message-${events.length}`, role, source: role === 'assistant' ? { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } : { kind: role === 'system' ? 'system-prompt' : 'user' }, content, ...extra });
  const event = (type, data, surfaceOp) => {
    const seq = events.length;
    events.push({ seq, time: 1795132800000 + seq, type, data, ...(surfaceOp ? { surfaceOp: surfaceOp.op === 'append' ? 'append' : surfaceOp } : {}) });
  };
  event('turn/start', { turn: 1 });
  event('step/start', { turn: 1, step: 1 });
  event('system/message', { turn: 1, step: 1, message: message('system', [{ type: 'text', text: 'DSH 原始系统提示' }]) }, { op: 'append' });
  event('user/message', message('user', [{ type: 'text', text: '请检查迁移链路，保留中文。' }]), { op: 'append' });
  event('assistant/message', { turn: 1, step: 1, message: message('assistant', [
    { type: 'reasoning', text: '先核对已有文件。' },
    { type: 'text', text: '正在检查。' },
    { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' },
  ]), stream: [], usage: { inputTokens: 10, outputTokens: 8, reasoningTokens: 3, cacheReadTokens: 2 } }, { op: 'append' });
  event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' });
  event('tool/result', { turn: 1, step: 1, message: message('tool', [{ type: 'text', text: '# 项目已准备好\n原始文件内容' }], { toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' } }) }, { op: 'append' });
  event('step/end', { turn: 1, step: 1 });
  event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  event('todo/write', { todos: [{ text: '继续迁移', status: 'in_progress' }] });
  if (compact) {
    event('user/message', message('user', [{ type: 'text', text: '[压缩总结] 已检查迁移链路，下一步运行测试。' }]), { op: 'replace', startSeq: 3, endSeq: 6 });
    event('turn/start', { turn: 2 });
    event('step/start', { turn: 2, step: 1 });
    event('user/message', message('user', [{ type: 'text', text: '现在运行测试。' }]), { op: 'append' });
    event('assistant/message', { turn: 2, step: 1, message: message('assistant', [{ type: 'text', text: '测试已完成。' }]), stream: [] }, { op: 'append' });
    event('step/end', { turn: 2, step: 1 });
    event('turn/end', { turn: 2, reason: { kind: 'completed' } });
  }
  const header = { id, version: 4, createdAt: 1795132800000, isSeeded: false, cwd: '/original/dsh-project' };
  return { format: FORMAT, version: 1, exportedAt: '2026-11-20T00:00:00.000Z', sessions: [{ header, title: '中文迁移示例', inheritedEventCount: 0, events, surfaceEventSeqs: foldSurface(events) }] };
}

export function mockClient(generation = 'v1') {
  const sessions = new Map();
  return {
    generation, version: 'fixture', identity: `fixture-${generation}`, sessions,
    async export(id) { return sessions.get(id) ?? null; },
    async import(_file, transcript) { sessions.set(transcript.info.id, structuredClone(transcript)); return { status: 'imported-verified' }; },
    async remove(id) { sessions.delete(id); },
  };
}
