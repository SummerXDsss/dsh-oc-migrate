import z from '@deepseek-ai/schemastery';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { FORMAT, digest, validateBundle } from '../../core/src/protocol.mjs';

export const name = 'dsh-oc-migrate';
export const inject = ['commands', 'sessionQuery'];
export const Config = z.object({
  receiver: z.string().default('http://127.0.0.1:48765'),
  tokenFile: z.string().required(),
  batchSize: z.number().default(20),
});

export async function captureSession(query, id, signal) {
  for (let attempt = 0; attempt < 4; attempt++) {
    signal?.throwIfAborted();
    const raw = await query.readSession(id);
    const surface = await query.readSurface(id);
    if (surface.capturedThroughSeq !== (raw.events.at(-1)?.seq ?? null)) continue;
    if (JSON.stringify(raw.session) !== JSON.stringify(surface.session)) continue;
    const session = { header: raw.session, inheritedEventCount: raw.inheritedEventCount, events: raw.events, surfaceEventSeqs: surface.events.map(event => event.seq) };
    const title = raw.events.findLast(event => event.type === 'session/title')?.data?.title;
    if (typeof title === 'string') session.title = title;
    validateBundle({ format: FORMAT, version: 1, sessions: [session] });
    return session;
  }
  throw new Error(`会话 ${id} 在读取时持续增长，请在响应结束后重试`);
}

export async function sendBundle(receiver, token, sessions, signal) {
  const url = new URL(receiver);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('receiver 应为 loopback HTTP origin；远程 DSH 请使用 SSH 转发');
  const body = Buffer.from(JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), sessions }));
  if (body.length > 64 * 1024 * 1024) throw new Error('单批超过 64 MiB，请减小 batchSize；单会话超大日志需要后续流式分片');
  const wire = gzipSync(body);
  if (wire.length > 16 * 1024 * 1024) throw new Error('压缩单批超过 16 MiB，请减小 batchSize');
  const response = await fetch(new URL('/v1/migrations', url), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-bundle-sha256': digest(body) },
    body: wire, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
  });
  const result = await response.json();
  if (!response.ok || result.status === 'failed') throw new Error(`中间件 HTTP ${response.status}：${result.error ?? result.status}；任务 ${result.id ?? '(未创建)'}`);
  return result;
}

export function apply(ctx, config) {
  ctx.commands.register({
    name: 'oc-migrate', description: '导出完整历史到本地 OpenCode 迁移中间件', recordInput: false,
    input: { hint: '[current|list|all|session-id]' },
    async handler(invocation) {
      let completed = 0;
      const jobs = [];
      const errors = [];
      try {
        const input = invocation.rawInput.trim() || 'current';
        if (input === 'list') {
          const list = await ctx.sessionQuery.listSessions(invocation.signal);
          return { kind: 'success', text: list.map(item => `${item.header.id}  ${item.live ? 'live' : 'persisted'}  ${item.header.cwd ?? ''}`).join('\n') || '暂无会话' };
        }
        const token = (await readFile(config.tokenFile, 'utf8')).trim();
        if (token.length < 32) throw new Error('tokenFile 中的令牌至少 32 字符');
        const ids = input === 'all'
          ? (await ctx.sessionQuery.listSessions(invocation.signal)).map(item => item.header.id)
          : [input === 'current' ? invocation.agent.session.id : input];
        const size = config.batchSize ?? 20;
        if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('batchSize 应为 1–1000');
        let batch = [];
        const flush = async () => {
          if (!batch.length) return;
          const result = await sendBundle(config.receiver ?? 'http://127.0.0.1:48765', token, batch, invocation.signal);
          jobs.push(`${result.id} (${result.status})`); completed += batch.length; batch = [];
        };
        for (const id of ids) {
          invocation.signal?.throwIfAborted();
          try { batch.push(await captureSession(ctx.sessionQuery, id, invocation.signal)); }
          catch (error) {
            invocation.signal?.throwIfAborted();
            if (input !== 'all') throw error;
            errors.push(`${id}: ${error.message}`);
            continue;
          }
          if (batch.length >= size) await flush();
        }
        await flush();
        if (errors.length) return { kind: 'error', text: `已接收 ${completed} 个会话；${errors.length} 个读取失败，可修复后重试。\n${jobs.join('\n')}\n${errors.join('\n')}` };
        return { kind: 'success', text: `已接收 ${completed} 个会话的完整事件日志（含压缩前历史）。\n${jobs.join('\n')}` };
      } catch (error) {
        return { kind: 'error', text: `已完成 ${completed} 个会话；${error.message}\n${jobs.join('\n')}`.trim() };
      }
    },
  });
}
