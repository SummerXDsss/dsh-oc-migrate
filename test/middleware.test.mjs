import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fixture, mockClient } from './fixture.mjs';
import { MigrationStore } from '../packages/middleware/src/store.mjs';
import { createReceiver } from '../packages/middleware/src/server.mjs';
import { digest, contentDigest } from '../packages/core/src/protocol.mjs';
import { atomicJSON } from '../packages/middleware/src/store.mjs';

async function setup(t, config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-migrate-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = mockClient();
  const store = new MigrationStore({ state: root, directory: '/target', client, ...config });
  return { root, client, store };
}
test('持久化原件、幂等接收、回读导入与回滚', async t => {
  const { store, client, root } = await setup(t);
  const bundle = fixture({ compact: true });
  const a = await store.receive(bundle, { importNow: true });
  assert.equal(a.status, 'imported'); assert.equal(client.sessions.size, 2);
  const changedTime = { ...bundle, exportedAt: 'later' };
  const b = await store.receive(changedTime, { importNow: true });
  assert.equal(a.id, b.id); assert.equal((await store.list()).length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, a.id, 'source.json'))), bundle);
  assert.equal((await stat(path.join(root, a.id, 'source.json'))).mode & 0o777, 0o600);
  assert.equal((await store.rollback(a.id)).status, 'rolled-back'); assert.equal(client.sessions.size, 0);
});
test('失败可重试，不把部分导入标记为成功', async t => {
  const { store, client } = await setup(t);
  const original = client.import;
  client.import = async () => { throw new Error('模拟离线'); };
  const report = await store.receive(fixture(), { importNow: true });
  assert.equal(report.status, 'failed'); assert.match(report.error, /模拟离线/);
  client.import = original;
  assert.equal((await store.import(report.id)).status, 'imported');
});
test('GUI 可读工具投影升级不复用旧转换任务，也不覆盖旧会话', async t => {
  const { store, client, root } = await setup(t);
  const bundle = fixture();
  const oldID = digest({ bundle: contentDigest(bundle), target: client.identity ?? '/target', directory: '/target', generation: 'v1', provider: null, model: null, includeArchive: true, stateSnapshots: true });
  await store.locked(oldID, async dir => atomicJSON(path.join(dir, 'report.json'), { id: oldID, status: 'imported', sessions: [{ sessionID: 'old-session' }] }));
  const before = await readFile(path.join(root, oldID, 'report.json'), 'utf8');
  const upgraded = await store.receive(bundle, { importNow: true });
  assert.notEqual(upgraded.id, oldID); assert.equal(upgraded.status, 'imported');
  assert.equal(await readFile(path.join(root, oldID, 'report.json'), 'utf8'), before);
  assert.equal((await store.receive(bundle, { importNow: true })).id, upgraded.id);
  assert.equal(client.sessions.size, 1);
});
test('回滚前阻止删除已继续聊天的会话，保留别的任务已导入会话', async t => {
  const { store, client } = await setup(t);
  const a = await store.receive(fixture(), { importNow: true });
  const actual = client.sessions.get(a.sessions[0].sessionID);
  actual.messages[0].parts[0].text += ' 用户新增';
  await assert.rejects(store.rollback(a.id), /不匹配/);
  assert.equal(client.sessions.size, 1);
});
test('另一个任务的已有会话不归本任务回滚', async t => {
  const { store, client } = await setup(t);
  const first = fixture(); await store.receive(first, { importNow: true });
  const second = fixture({ id: 'second' });
  const report = await store.receive({ ...first, sessions: [...first.sessions, ...second.sessions] }, { importNow: true });
  assert.equal(client.sessions.size, 2);
  assert.equal(report.sessions[0].owned, false);
  await store.rollback(report.id); assert.equal(client.sessions.size, 1);
});
test('回滚预检查保留已有用户分支，且不删除其他拟回滚会话', async t => {
  const { store, client } = await setup(t);
  const report = await store.receive(fixture({ compact: true }), { importNow: true });
  client.assertNoChildren = async id => { if (id === report.sessions[1].sessionID) throw new Error('已有子会话'); };
  await assert.rejects(store.rollback(report.id), /子会话/);
  assert.equal(client.sessions.size, 2);
});
test('并发重复任务返回 409 而不是双重导入', async t => {
  const { store } = await setup(t);
  const report = await store.receive(fixture());
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const first = store.locked(report.id, async () => { entered(); await wait; });
  await ready;
  await assert.rejects(store.import(report.id), error => error.status === 409);
  release(); await first;
});
test('HTTP 接收：鉴权、Origin、gzip、hash、输入上限与任务读取', async t => {
  const { store } = await setup(t);
  const token = 'a'.repeat(64), server = createReceiver({ store, token, autoImport: true, maxBytes: 20000, maxWireBytes: 10000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(url + '/healthz')).status, 401);
  assert.equal((await fetch(url + '/healthz', { headers: { ...headers, origin: 'https://example.org' } })).status, 403);
  assert.equal((await fetch(url + '/healthz', { headers })).status, 200);
  const body = Buffer.from(JSON.stringify(fixture()));
  const send = extra => fetch(url + '/v1/migrations', { method: 'POST', body: gzipSync(body), headers: { ...headers, 'content-encoding': 'gzip', 'x-bundle-sha256': digest(body), ...extra } });
  assert.equal((await send({ 'x-bundle-sha256': 'bad' })).status, 400);
  const response = await send(); assert.equal(response.status, 201);
  const report = await response.json(); assert.equal(report.status, 'imported');
  assert.equal((await fetch(url + '/v1/jobs/' + report.id, { headers })).status, 200);
  const bomb = gzipSync(Buffer.alloc(25000));
  assert.equal((await fetch(url + '/v1/migrations', { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: bomb })).status, 413);
  assert.equal((await fetch(url + '/v1/jobs/not-a-valid-id', { headers })).status, 404);
});
