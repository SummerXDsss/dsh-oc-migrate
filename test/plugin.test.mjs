import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply, captureSession, sendBundle, inject, Config } from '../packages/plugin/src/index.mjs';
import { fixture, mockClient } from './fixture.mjs';
import { MigrationStore } from '../packages/middleware/src/store.mjs';
import { createReceiver } from '../packages/middleware/src/server.mjs';

function queryFor(bundles) {
  const sessions = bundles.flatMap(b => b.sessions);
  return {
    async listSessions() { return sessions.map(source => ({ header: source.header, live: false, persisted: true })); },
    async readSession(id) { const s = sessions.find(s => s.header.id === id); return { session: s.header, events: s.events, inheritedEventCount: 0 }; },
    async readSurface(id) { const s = sessions.find(s => s.header.id === id); return { session: s.header, events: s.surfaceEventSeqs.map(seq => s.events[seq]), capturedThroughSeq: s.events.at(-1).seq }; },
  };
}
test('真实插件入口声明 commands/sessionQuery，截面读取保留全部 raw log', async () => {
  assert.deepEqual(inject, ['commands', 'sessionQuery']); assert.ok(Config);
  const bundle = fixture({ compact: true });
  const captured = await captureSession(queryFor([bundle]), bundle.sessions[0].header.id);
  assert.equal(captured.events.length, bundle.sessions[0].events.length);
  assert.deepEqual(captured.surfaceEventSeqs, bundle.sessions[0].surfaceEventSeqs);
});
test('读取时增长会重试，持续增长则明确报错', async () => {
  const bundle = fixture(), query = queryFor([bundle]);
  const read = query.readSurface; let calls = 0;
  query.readSurface = async id => { const surface = await read(id); if (++calls === 1) surface.capturedThroughSeq++; return surface; };
  await captureSession(query, bundle.sessions[0].header.id); assert.equal(calls, 2);
  query.readSurface = async id => ({ ...await read(id), capturedThroughSeq: 999 });
  await assert.rejects(captureSession(query, bundle.sessions[0].header.id), /持续增长/);
});
test('插件 all 分批覆盖 live / persisted 会话，发送到真实本地中间件', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = 'x'.repeat(64), tokenFile = path.join(root, 'token'); await writeFile(tokenFile, token);
  const store = new MigrationStore({ state: path.join(root, 'jobs'), directory: '/target', client: mockClient() });
  const server = createReceiver({ store, token, autoImport: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let command;
  const first = fixture({ id: 'a', compact: true }), second = fixture({ id: 'b' });
  apply({ sessionQuery: queryFor([first, second]), commands: { register(def) { command = def; } } }, { tokenFile, receiver: `http://127.0.0.1:${server.address().port}`, batchSize: 1 });
  assert.equal(command.recordInput, false);
  const invocation = { rawInput: 'all', agent: { session: { id: 'a' } }, signal: new AbortController().signal };
  const result = await command.handler(invocation);
  assert.equal(result.kind, 'success'); assert.match(result.text, /已接收 2 个会话/);
  assert.equal((await store.list()).length, 2);
  const list = await command.handler({ ...invocation, rawInput: 'list' }); assert.match(list.text, /persisted/);
});
test('导出传输拒绝非 loopback 及取消信号', async () => {
  await assert.rejects(sendBundle('http://example.org', 'x'.repeat(64), fixture().sessions), /loopback/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(captureSession(queryFor([fixture()]), 'a', controller.signal), /abort/i);
});
test('标题从原始日志同一截面读取', async () => {
  const bundle = fixture(), source = bundle.sessions[0];
  source.events.push({ seq: source.events.length, type: 'session/title', time: 1795132801000, data: { title: '用户重命名标题' } });
  const captured = await captureSession(queryFor([bundle]), source.header.id);
  assert.equal(captured.title, '用户重命名标题');
});
test('all 会继续导出其他会话并明确报告坏会话', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = 'x'.repeat(64), tokenFile = path.join(root, 'token'); await writeFile(tokenFile, token);
  const store = new MigrationStore({ state: root + '/jobs', directory: '/target', client: mockClient() });
  const server = createReceiver({ store, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const query = queryFor([fixture({ id: 'bad' }), fixture({ id: 'good' })]);
  const read = query.readSession;
  query.readSession = async id => { if (id === 'bad') throw new Error('模拟损坏'); return read(id); };
  let command;
  apply({ sessionQuery: query, commands: { register(def) { command = def; } } }, { tokenFile, receiver: `http://127.0.0.1:${server.address().port}` });
  const result = await command.handler({ rawInput: 'all', signal: new AbortController().signal });
  assert.equal(result.kind, 'error'); assert.match(result.text, /已接收 1 个会话/); assert.match(result.text, /bad.*模拟损坏/);
  assert.equal((await store.list()).length, 1);
});
