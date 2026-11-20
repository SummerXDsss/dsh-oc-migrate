import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { digest, fail } from '../../core/src/protocol.mjs';

export function createReceiver({ store, token, autoImport = false, maxBytes = 64 * 1024 * 1024, maxWireBytes = 16 * 1024 * 1024 }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('接收令牌至少 32 字符');
  return http.createServer({ requestTimeout: 120000, headersTimeout: 15000 }, async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      // 不提供 CORS；拒绝带 Origin 的浏览器请求。插件在 DSH Host 中运行。
      if (request.headers.origin) fail('接收端仅接受 Host 客户端请求', 403);
      const supplied = request.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) fail('接收令牌不匹配', 401);
      const route = new URL(request.url, 'http://localhost').pathname;
      let result, status = 200;
      if (request.method === 'GET' && route === '/healthz') result = { ok: true, version: 1 };
      else if (request.method === 'GET' && route === '/v1/jobs') result = await store.list();
      else if (request.method === 'POST' && route === '/v1/migrations') {
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) fail('需要 application/json', 415);
        const encoding = request.headers['content-encoding'] ?? 'identity';
        if (!['gzip', 'identity'].includes(encoding)) fail('仅支持 gzip 或 identity', 415);
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > maxWireBytes) fail('压缩传输体超出上限', 413);
          chunks.push(chunk);
        }
        const wire = Buffer.concat(chunks);
        let body;
        try { body = encoding === 'gzip' ? gunzipSync(wire, { maxOutputLength: maxBytes }) : wire; }
        catch { fail('gzip 无效或解压后超出上限', 413); }
        if (body.length > maxBytes) fail('迁移包超出上限', 413);
        if (request.headers['x-bundle-sha256'] !== digest(body)) fail('SHA-256 校验失败');
        let bundle;
        try { bundle = JSON.parse(body.toString('utf8')); } catch { fail('JSON 解析失败'); }
        result = await store.receive(bundle, { importNow: autoImport });
        status = result.status === 'failed' ? 502 : 201;
      } else {
        const match = route.match(/^\/v1\/jobs\/([a-f0-9]{64})(?:\/(import|rollback))?$/);
        if (!match) fail('路由不存在', 404);
        if (request.method === 'GET' && !match[2]) result = await store.read(match[1]);
        else if (request.method === 'POST' && match[2]) result = await store[match[2]](match[1]);
        else fail('方法不匹配', 405);
        if (result.status === 'failed') status = 502;
      }
      response.writeHead(status); response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error.status ?? (error.code === 'ENOENT' ? 404 : 500));
      response.end(JSON.stringify({ error: error.message }));
    }
  });
}
