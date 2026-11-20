import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { convertOpenCode } from '../packages/core/src/reverse.mjs';
import { convertBundle } from '../packages/core/src/convert.mjs';
import { fixture } from './fixture.mjs';
import { ReverseStore, detectDshEncoding, dshProjectKey } from '../packages/middleware/src/reverse.mjs';
import { listSessionPages } from '../packages/opencode-client/src/index.mjs';
import { decodeZstdFrames } from '../packages/plugin/src/local-reader.mjs';
import { zstdDecompressSync } from 'node:zlib';
import { captureLocalSession } from '../packages/plugin/src/local-reader.mjs';
import { DesktopService } from '../packages/desktop/src/service.mjs';
const makeTranscript = generation => convertBundle(fixture(), { generation, directory: '/tmp/迁移项目' })[0].transcript;
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-reverse-')); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new ReverseStore({ state: path.join(root, 'jobs'), dshRoot: path.join(root, 'sessions') }) };
}
for (const generation of ['v1', 'v2']) test(`${generation} → DSH 原生 v4：正文、思考、工具配对及项目路径`, () => {
  const transcript = makeTranscript(generation), c = convertOpenCode(transcript);
  assert.equal(c.session.header.cwd, '/tmp/迁移项目'); assert.equal(c.session.header.version, 4);
  assert.ok(c.bytes.includes(Buffer.from('原始文件内容')));
  assert.ok(c.bytes.includes(Buffer.from('先核对已有文件')));
  assert.equal(c.session.events.filter(e => e.type === 'tool/call').length, 1);
  assert.equal(c.session.events.filter(e => e.type === 'tool/result').length, 1);
  assert.equal(c.revision, convertOpenCode(structuredClone(transcript)).revision);
  const [back] = convertBundle({ format: 'dsh-oc-migrate', version: 1, sessions: [c.session] }, { generation, directory: c.session.header.cwd });
  assert.ok(JSON.stringify(back.transcript).includes('原始文件内容'));
});
test('反向原件、幂等导入、回滚、重试和明文/压缩编码', async t => {
  const { root, store } = await setup(t), transcript = makeTranscript('v2');
  const first = await store.receive(transcript, { importNow: true }); assert.equal(first.status, 'imported', first.error);
  assert.equal(first.encoding, 'zstd');
  const compressed = await readFile(first.sessions[0].file);
  assert.ok(compressed.length);
  // Node stops at the first frame: it must be a single parseable header row.
  const firstFrame = zstdDecompressSync(compressed).toString('utf8');
  assert.equal(JSON.parse(firstFrame).type, 'session');
  assert.equal(firstFrame.split('\n').length, 2);
  assert.ok(decodeZstdFrames(compressed).includes(Buffer.from('原始文件内容')));
  const read = await captureLocalSession({ file: first.sessions[0].file }); assert.equal(read.session.header.id, first.sessions[0].sessionID);
  assert.deepEqual(JSON.parse(await readFile(path.join(store.jobPath(first.id), 'source.json'), 'utf8')), transcript);
  assert.equal((await store.receive(transcript, { importNow: true })).id, first.id);
  assert.equal((await store.rollback(first.id)).status, 'rolled-back');
  assert.equal((await store.import(first.id)).status, 'imported');
  const plain = new ReverseStore({ state: path.join(root, 'plain-jobs'), dshRoot: path.join(root, 'plain'), encoding: 'none' });
  const report = await plain.receive(transcript, { importNow: true }); assert.equal(report.status, 'imported', report.error); assert.equal(report.encoding, 'none');
  assert.equal(await detectDshEncoding(path.join(root, 'plain')), 'none');
  assert.match(dshProjectKey('/tmp/项目'), /^--tmp-~9879~76EE--$/);
});
test('DSH 已修改、已由客户端打开或存在分支时，回滚保留历史', async t => {
  const { store } = await setup(t), report = await store.receive(makeTranscript('v1'), { importNow: true });
  const file = report.sessions[0].file, original = await readFile(file);
  await writeFile(file, Buffer.concat([original, Buffer.from('changed')]));
  await assert.rejects(store.rollback(report.id)); assert.ok((await readFile(file)).includes(Buffer.from('changed')));
  await writeFile(file, original); await writeFile(path.join(path.dirname(file), 'session.lock'), '');
  await assert.rejects(store.rollback(report.id), /已打开/); assert.deepEqual(await readFile(file), original);
});
test('完整分页包括根、分支、归档；重复游标或重复会话必须报错', async () => {
  const calls = [];
  const rows = await listSessionPages(async cursor => { calls.push(cursor); return cursor ? { data: [{ id: 'child', parentID: 'root', time: { archived: 1 } }], cursor: {} } : { data: [{ id: 'root' }], cursor: { next: 'next page' } }; });
  assert.deepEqual(calls, [undefined, 'next page']); assert.equal(rows.length, 2);
  await assert.rejects(listSessionPages(async () => ({ data: [], cursor: { next: 'repeat' } })), /重复/);
  await assert.rejects(listSessionPages(async () => ({ data: [{ id: 'same' }], cursor: { next: 'next' } })), /变化/);
});
test('未知事件、附件、错误及未完成工具保留快照，不恢复待执行工作', () => {
  const source = makeTranscript('v2'); source.messages.push({ id: 'sys', type: 'system', text: '上下文', custom: { future: true }, time: { created: 1 } });
  source.messages[0].files = [{ url: 'file:///tmp/a.png', mime: 'image/png' }];
  const tool = source.messages.find(m => m.type === 'assistant').content.find(p => p.type === 'tool'); tool.state = { status: 'running', input: { command: 'never run' } };
  const c = convertOpenCode(source);
  assert.ok(c.bytes.includes(Buffer.from('future'))); assert.ok(c.bytes.includes(Buffer.from('file:///tmp/a.png')));
  assert.equal(c.session.events.find(e => e.type === 'tool/result').data.message.isError, true);
  assert.ok(c.warnings.length >= 3);
});
test('桌面反向一键：全部项目、导出变化保护、记录重开及原目标回滚', async t => {
  const { root } = await setup(t); const a = makeTranscript('v1'), b = makeTranscript('v2'); b.info.id = 'another-project'; b.info.location.directory = '/tmp/another-project';
  const sessions = [a, b], client = { version: '2.3.2', generation: 'v2', listAll: async () => sessions.map(s => s.info), export: async id => structuredClone(sessions.find(s => s.info.id === id)) };
  const service = await new DesktopService({ root: path.join(root, 'desktop'), home: root, candidates: ['fixture'], makeClient: async () => client }).init();
  const plan = await service.request('discoverQuick', { direction: 'oc-to-dsh' }); assert.equal(plan.total, 2);
  await service.request('startQuick', { direction: 'oc-to-dsh' }); await service.quick.done;
  const snapshot = await service.snapshot(); assert.equal(snapshot.quick.status, 'completed', JSON.stringify(snapshot.quick.errors)); assert.equal(snapshot.quick.imported, 2);
  assert.equal(snapshot.jobs.length, 2); assert.ok(snapshot.jobs.every(job => job.direction === 'oc-to-dsh'));
  for (const job of snapshot.jobs) assert.equal((await service.request('rollback', { id: job.id })).status, 'rolled-back');
  assert.equal(sessions.length, 2); // Original OpenCode history unchanged.
  const changed = { ...client, export: async id => ({ ...await client.export(id), changing: Math.random() }) };
  service.makeClient = service.quick.makeClient = async () => changed;
  await service.request('startQuick', { direction: 'oc-to-dsh' }); await service.quick.done;
  assert.equal(service.quick.current.status, 'partial'); assert.equal(service.quick.current.imported, 0);
  assert.equal(service.quick.current.errors.length, 2);
});

test('Bun 编译仅嵌入 DSH 包版本；依赖表达式漂移时阻止发布', async () => {
  const { embedDshVersion } = await import('../scripts/bun-compat.mjs');
  const input = 'const { version } = createRequire(import.meta.url)("../package.json");';
  assert.equal(embedDshVersion(input, '0.2.1-rc.2'), 'const { version } = {"version":"0.2.1-rc.2"};');
  assert.throws(() => embedDshVersion('changed upstream', '0.2.1-rc.2'));
});

test('DSH 不混写两种编码，也不绕过旧代编码冲突', async t => {
  const { root, store } = await setup(t), report = await store.receive(makeTranscript('v1'), { importNow: true });
  await writeFile(path.join(path.dirname(report.sessions[0].file), 'session.v3.jsonl'), 'older generation');
  await assert.rejects(detectDshEncoding(path.join(root, 'sessions')), /混用/);
});
