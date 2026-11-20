import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { captureLocalSession, decodeLocalLog, decodeZstdFrames, findLocalSessions } from '../packages/plugin/src/local-reader.mjs';
import { DesktopService } from '../packages/desktop/src/service.mjs';
import { fixture, mockClient } from './fixture.mjs';
const log = session => [{ type: 'session', ...session.header, delegationDepth: 0 }, ...session.events].map(x => JSON.stringify(x)+'\n');
async function setup(t, makeClient) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-quick-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); await mkdir(home);
  const clients = new Map();
  makeClient ??= async config => { if (!clients.has(config.directory)) clients.set(config.directory, { ...mockClient('v2'), version: 'opencode v2.3.2', identity: config.directory }); return clients.get(config.directory); };
  const app = await new DesktopService({ root: path.join(root, 'app'), home, candidates: ['fixture-gui'], makeClient }).init();
  const source = path.join(home, '.dsh/sessions');
  async function add(name, session = fixture({ compact: true, id: name }).sessions[0], compressed = false) {
    const dir = path.join(source, 'project', name); await mkdir(dir, { recursive: true });
    const rows = log(session), bytes = compressed ? Buffer.concat(rows.map(x => zstdCompressSync(x))) : Buffer.from(rows.join(''));
    const file = path.join(dir, `session.v4.jsonl${compressed ? '.zstd' : ''}`); await writeFile(file, bytes); return { file, bytes };
  }
  return { root, home, source, app, add, clients, makeClient };
}
test('DSH 直读处理每个 Zstd 帧，保留全部事件、压缩前全文和原生 append', async t => {
  const { add, source } = await setup(t); const { file, bytes } = await add('compressed', undefined, true);
  const item = (await findLocalSessions(source)).files[0]; const captured = await captureLocalSession(item);
  assert.equal(captured.session.events.length, fixture({ compact: true }).sessions[0].events.length);
  assert(captured.session.events.some(x => x.surfaceOp === 'append'));
  assert.equal(captured.session.surfaceEventSeqs.length, 4);
  assert.deepEqual(await readFile(file), bytes);
  assert.throws(() => decodeZstdFrames(bytes.subarray(0, -1)), /尚未写完/);
  assert.throws(() => decodeZstdFrames(bytes, 10));
});
test('本地扫描选择最新格式，不偷偷用旧副本；双编码不一致会报告', async t => {
  const { add, source } = await setup(t); const { file } = await add('latest');
  await writeFile(file.replace('v4', 'v5'), '{}\n');
  let scan = await findLocalSessions(source); assert.equal(scan.files[0].version, 5);
  await assert.rejects(captureLocalSession(scan.files[0]), /v4 日志/);
  await rm(file.replace('v4', 'v5'));
  const other = fixture({ compact: false, id: 'different' }).sessions[0];
  await writeFile(file+'.zstd', zstdCompressSync(log(other).join('')));
  scan = await findLocalSessions(source);
  await assert.rejects(captureLocalSession(scan.files[0]), /两份不一致/);
});
test('未完成尾巴、坏 seq 与继承边界不会被当成完整对话', () => {
  const session = fixture({ compact: true }).sessions[0]; const rows = log(session);
  assert.throws(() => decodeLocalLog(Buffer.from(rows.join('').trimEnd())), /尚未写完/);
  const bad = structuredClone(session); bad.events[1].seq = 90;
  assert.throws(() => decodeLocalLog(Buffer.from(log(bad).join(''))), /seq 不连续/);
  const seeded = structuredClone(session); seeded.header.isSeeded = true;
  assert.throws(() => decodeLocalLog(Buffer.from(log(seeded).join(''))), /继承边界/);
  seeded.events.push({ type: 'session/end-seed', seq: seeded.events.length, time: 1795132800999, data: { inherited: true } });
  assert.equal(decodeLocalLog(Buffer.from(log(seeded).join(''))).inheritedEventCount, session.events.length);
});
test('零配置一键迁移：自动发现、逐对话回读、原件备份、重复去重、按原目标回滚', async t => {
  const { app, add, root, clients } = await setup(t); const { file, bytes } = await add('one', undefined, true);
  const plan = await app.request('discoverQuick'); assert.equal(plan.total, 1); assert.equal(plan.target.binary, 'fixture-gui');
  const started = await app.request('startQuick'); assert.equal(started.status, 'running');
  await app.quick.done;
  let run = (await app.snapshot()).quick; assert.equal(run.status, 'completed'); assert.equal(run.imported, 1); assert.equal(run.nativeSessions, 2);
  assert.equal(run.preserveProjects, true); assert.equal(run.jobs.length, 1);
  assert.deepEqual(await readFile(path.join(root, 'app/quick-runs', run.id, 'sources', run.jobs[0].original)), bytes);
  assert.deepEqual(await readFile(file), bytes);
  const id = run.jobs[0].id; await app.request('startQuick'); await app.quick.done;
  assert.equal((await app.snapshot()).jobs.length, 1); assert.equal([...clients.values()].reduce((n, c) => n + c.sessions.size, 0), 2);
  await app.request('rollback', { id }); assert.equal([...clients.values()].reduce((n, c) => n + c.sessions.size, 0), 0);
});
test('一键迁移隔离坏对话，保留有效项目；空记录留存但不制造空聊天', async t => {
  const { app, add, root, source } = await setup(t);
  const session = fixture({ id: 'good' }).sessions[0]; session.header.cwd = root;
  await add('good', session);
  const empty = fixture({ id: 'empty' }).sessions[0]; empty.events = []; await add('empty', empty);
  const { file } = await add('bad'); await writeFile(file, '{\n');
  await app.request('startQuick'); await app.quick.done; const run = app.quick.current;
  assert.equal(run.status, 'partial'); assert.equal(run.imported, 1); assert.equal(run.skipped, 1); assert.equal(run.finished, 3); assert.equal(run.errors.length, 1);
  assert.equal(run.jobs.find(x => x.sourceID === 'good').directory, root);
  assert.equal((await readdir(path.join(root, 'app/quick-runs', run.id, 'sources'))).length, 2);
  assert.equal((await findLocalSessions(source)).files.length, 3);
});
test('一键任务可停止，执行时禁止并发改目标，重开显式记录中断', async t => {
  const { app, add, root, home, makeClient } = await setup(t); await add('one'); await add('two');
  await app.request('startQuick'); await assert.rejects(app.request('connect', { directory: root }), /等待一键/);
  await app.request('cancelQuick'); await app.quick.done; assert.equal(app.quick.current.status, 'cancelled');
  app.quick.current.status = 'running'; await app.quick.save();
  const reopened = await new DesktopService({ root: path.join(root, 'app'), home, makeClient }).init();
  assert.equal(reopened.quick.current.status, 'interrupted');
});
test('没有 OpenCode 或源目录时报告实际问题，不创建迁移任务', async t => {
  const { app, add } = await setup(t, async () => { throw Error('not installed'); });
  await add('one'); assert.equal((await app.request('discoverQuick')).target, null);
  await assert.rejects(app.request('startQuick'), /未找到可用/);
  assert.equal((await app.snapshot()).jobs.length, 0);
  await assert.rejects(app.request('startQuick', { sourceRoot: 'relative' }), /绝对路径/);
});
