import { createHash } from 'node:crypto';

export const FORMAT = 'dsh-oc-migrate';
export const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
export const canonical = value => JSON.stringify(value, function (_key, item) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  }
  return item;
});
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const contentDigest = bundle => digest({ format: bundle.format, version: bundle.version, sessions: bundle.sessions });
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Surface 的位置替换，而不是“挑出所有 user / assistant 事件”。
export function foldSurface(events) {
  const nodes = [];
  for (const event of events) {
    if (!event.surfaceOp) {
      if (SURFACE_TYPES.has(event.type)) fail(`消息事件 seq=${event.seq} 缺少 surfaceOp；请用当前 sessionQuery 导出`);
      continue;
    }
    if (!SURFACE_TYPES.has(event.type)) fail(`非消息事件 seq=${event.seq} 含 surfaceOp`);
    const op = event.surfaceOp;
    if (op.op === 'append') nodes.push(event.seq);
    else if (op.op === 'replace') {
      const start = nodes.indexOf(op.startSeq), end = nodes.indexOf(op.endSeq);
      if (start < 0 || end < start) fail(`surface 替换范围无效：seq=${event.seq}`);
      nodes.splice(start, end - start + 1, event.seq);
    } else fail(`未知 surfaceOp：seq=${event.seq}`);
  }
  return nodes;
}

export function validateBundle(bundle) {
  if (bundle?.format !== FORMAT || bundle.version !== 1) fail('迁移包格式或版本无效');
  if (!Array.isArray(bundle.sessions) || !bundle.sessions.length || bundle.sessions.length > 1000) fail('sessions 数量应为 1–1000');
  const ids = new Set();
  for (const session of bundle.sessions) {
    const header = session.header;
    if (!header || typeof header.id !== 'string' || !header.id || !integer(header.createdAt)) fail('session header 无效');
    if (ids.has(header.id)) fail('迁移包含重复 session id');
    ids.add(header.id);
    if (!Array.isArray(session.events)) fail('events 应为数组');
    if (session.title !== undefined && typeof session.title !== 'string') fail('title 应为字符串');
    for (const [index, event] of session.events.entries()) {
      if (event?.seq !== index || !integer(event.time) || typeof event.type !== 'string' || !Object.hasOwn(event, 'data')) fail(`事件无效或 seq 不连续：${header.id} #${index}`);
      if (SURFACE_TYPES.has(event.type)) {
        const message = event.type === 'user/message' ? event.data : event.data?.message;
        if (!message || !Array.isArray(message.content)) fail(`消息缺少 content：seq=${index}`);
      }
    }
    const folded = foldSurface(session.events);
    if (canonical(folded) !== canonical(session.surfaceEventSeqs)) fail('raw log 与 surfaceEventSeqs 不一致');
  }
  return bundle;
}
