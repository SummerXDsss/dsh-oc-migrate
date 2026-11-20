import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { DesktopService } from '../packages/desktop/src/service.mjs';
import { fixture, mockClient } from './fixture.mjs';
import { digest } from '../packages/core/src/protocol.mjs';
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const clients = new Map(), events = [];
  const makeClient = async config => {
    if (!clients.has(config.directory)) clients.set(config.directory, { ...mockClient(), identity: config.directory, version: '1.18.31', generation: 'v1' });
    return clients.get(config.directory);
  };
  const app = await new DesktopService({ root, makeClient, emit: e => events.push(e) }).init();
  t.after(() => app.stop());
  return { root, clients, app, events, makeClient };
}
test('桌面设置持久化、私有令牌与未知 RPC 拒绝', async t => {
  const { root, app } = await setup(t);
  assert.equal((await app.snapshot()).jobs.length, 0);
  assert.equal((await readFile(app.tokenFile, 'utf8')).trim().length, 64);
  if (process.platform !== 'win32') assert.equal((await stat(app.tokenFile)).mode & 0o777, 0o600);
  await assert.rejects(app.request('shell', { command: 'x' }), /未知桌面操作/);
  await assert.rejects(app.connect({ directory: 'relative' }), /绝对路径/);
  await app.connect({ directory: root });
  assert.equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).directory, root);
});
test('桌面接收是真实 HTTP 链路；切换目标后重试与回滚仍使用原目标', async t => {
  const { root, app, clients, events, makeClient } = await setup(t);
  await assert.rejects(app.start(), /先检测/);
  await app.connect({ directory: root });
  // Port 0 is deliberately rejected by user-facing API; reserve an ephemeral one for this test.
  const http = await import('node:http'); const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const receiver = await app.start({ port });
  await assert.rejects(app.connect({ directory: root }), /先停止/);
  const token = (await readFile(app.tokenFile, 'utf8')).trim(), body = JSON.stringify(fixture());
  const response = await fetch(receiver.url + '/v1/migrations', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-bundle-sha256': digest(Buffer.from(body)) }, body });
  assert.equal(response.status, 201); const report = await response.json();
  assert.equal(report.status, 'imported');
  assert(events.some(e => e.type === 'jobs-changed'));
  await app.stop();
  const other = await mkdtemp(path.join(os.tmpdir(), 'dsh-other-')); t.after(() => rm(other, { force: true, recursive: true }));
  await app.connect({ directory: other });
  assert.equal((await app.request('retry', { id: report.id })).status, 'imported');
  assert.equal((await app.request('rollback', { id: report.id })).status, 'rolled-back');
  assert.equal(clients.get(root).sessions.size, 0); assert.equal(clients.get(other).sessions.size, 0);
  const reopened = await new DesktopService({ root, makeClient }).init();
  assert.equal((await reopened.snapshot()).jobs[0].status, 'rolled-back');
  assert.equal((await reopened.request('retry', { id: report.id })).status, 'imported');
});
test('桌面文件导入使用同一个迁移内核，失败不冒充成功', async t => {
  const { root, app, clients } = await setup(t);
  await app.connect({ directory: root });
  const file = path.join(root, 'fixture.json'); await writeFile(file, JSON.stringify(fixture()));
  clients.get(root).import = async () => { throw new Error('真实错误传递'); };
  const report = await app.request('importFile', { file });
  assert.equal(report.status, 'failed'); assert.match(report.error, /真实错误传递/);
  await writeFile(file, '{'); await assert.rejects(app.request('importFile', { file }));
  await assert.rejects(app.request('importFile', { file: 'relative' }), /JSON/);
});
test('sidecar JSONL RPC 可运行且 stdin 关闭后退出', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-rpc-')); t.after(() => rm(root, { force: true, recursive: true }));
  const child = spawn(process.env.DSH_OC_TEST_SIDECAR || process.execPath, process.env.DSH_OC_TEST_SIDECAR ? [] : ['packages/desktop/src/service.mjs'], { env: { ...process.env, DSH_OC_SIDECAR: '1', DSH_OC_APP_DATA: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '', error = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => error += c);
  child.stdin.end(JSON.stringify({ id: 1, method: 'snapshot' }) + '\n' + JSON.stringify({ id: 2, method: 'exec' }) + '\n');
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0, error);
  const messages = output.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(messages[0].id, 1); assert.deepEqual(messages[0].result.jobs, []);
  assert.equal(messages[1].id, 2); assert.match(messages[1].error, /未知桌面操作/);
});
