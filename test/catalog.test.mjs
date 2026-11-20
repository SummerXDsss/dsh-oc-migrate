import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DesktopService } from '../packages/desktop/src/service.mjs';
import { convertBundle } from '../packages/core/src/convert.mjs';
import { fixture, mockClient } from './fixture.mjs';
async function setup(t, direction = 'dsh-to-oc') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-catalog-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); await mkdir(home);
  const client = { ...mockClient('v2'), version: 'opencode v2.3.2', async listAll() { return [...this.sessions.values()].map(x => x.info); } };
  const makeClient = async () => client, events = [];
  const appRoot = path.join(root, 'app'), app = await new DesktopService({ root: appRoot, home, candidates: ['fixture'], makeClient, emit: e => events.push(e) }).init();
  async function add(id, project = 'ALPHA', compact = false) {
    const directory = path.join(home, project); await mkdir(directory, { recursive: true });
    const s = fixture({ id, compact }).sessions[0]; s.header.cwd = directory; s.title = `中文 ${id}`;
    const file = path.join(home, '.dsh/sessions', project, id, 'session.v4.jsonl'); await mkdir(path.dirname(file), { recursive: true });
    const bytes = Buffer.from([{ type: 'session', ...s.header }, ...s.events].map(x => JSON.stringify(x)).join('\n') + '\n');
    await writeFile(file, bytes);
    if (direction === 'oc-to-dsh') for (const x of convertBundle({ ...fixture(), sessions: [s] }, { directory, generation: 'v2' })) client.sessions.set(x.sessionID, x.transcript);
    return { file, bytes };
  }
  return { root, home, appRoot, app, client, makeClient, add, events };
}
test('先扫描：项目分组、分页全文预览、本地名称/收藏、持久化，扫描不导入', async t => {
  const { app, add, client, appRoot, home, makeClient, events } = await setup(t);
  const source = await add('压缩对话', 'ALPHA', true); await add('普通对话', 'BETA');
  const bad = await add('坏日志'); await writeFile(bad.file, '{\n');
  const catalog = await app.request('scanCatalog');
  assert.equal(catalog.entries.length, 2); assert.equal(catalog.projects.length, 2); assert.equal(catalog.errors.length, 1);
  assert.equal((await app.snapshot()).jobs.length, 0); assert.equal(client.sessions.size, 0);
  assert(events.some(e => e.type === 'catalog-progress' && e.finished === 3));
  const e = catalog.entries.find(e => e.sourceID === '压缩对话');
  const preview = await app.request('catalogPreview', { scanID: catalog.id, id: e.id });
  assert.match(JSON.stringify(preview), /先核对已有文件/); assert.match(JSON.stringify(preview), /原始文件内容/); assert(preview.messages.some(m => !m.active));
  assert.equal((await app.request('catalogPreview', { scanID: catalog.id, id: e.id, offset: 1, limit: 1 })).messages.length, 1);
  await app.request('catalogUpdate', { scanID: catalog.id, kind: 'entry', id: e.id, patch: { alias: '我的迁移', starred: true } });
  await app.request('catalogUpdate', { scanID: catalog.id, kind: 'project', id: e.projectID, patch: { alias: '本地项目名' } });
  const reopened = await new DesktopService({ root: appRoot, home, makeClient }).init();
  assert.equal((await reopened.snapshot()).catalog.entries.find(x => x.id === e.id).alias, '我的迁移');
  assert.equal(reopened.catalog.snapshot().projects.find(x => x.id === e.projectID).alias, '本地项目名');
  const rescan = await app.request('scanCatalog'); assert.notEqual(rescan.id, catalog.id); assert.equal(rescan.entries.find(x => x.id === e.id).starred, true);
  assert.deepEqual(await readFile(source.file), source.bytes);
  await assert.rejects(app.request('catalogPreview', { scanID: catalog.id, id: e.id }), /扫描结果已更新/);
  await assert.rejects(app.request('catalogUpdate', { scanID: rescan.id, kind: 'entry', id: e.id, patch: { alias: 'x'.repeat(121) } }), /格式无效/);
});
test('只迁移扫描中明确选中的对话，不把新出现的对话混入；空选和伪造 ID 被拒绝', async t => {
  const { app, add, client } = await setup(t); await add('一'); await add('二', 'BETA');
  const c = await app.request('scanCatalog'); await add('扫描后新增');
  for (const ids of [[], ['unknown'], [c.entries[0].id, c.entries[0].id]]) await assert.rejects(app.request('startSelected', { scanID: c.id, ids }));
  await app.request('startSelected', { scanID: c.id, ids: [c.entries[0].id] }); await app.quick.done;
  assert.equal(app.quick.current.total, 1); assert.equal(app.quick.current.imported, 1); assert.equal(app.quick.current.selected, true);
  assert.equal(client.sessions.size, 1); assert.equal((await app.snapshot()).jobs.length, 1);
  await app.request('rollback', { id: app.quick.current.jobs[0].id }); assert.equal(client.sessions.size, 0);
});
test('扫描后源发生变化时拒绝预览与导入，不重新扫描后偷偷全量迁移', async t => {
  const { app, add, client } = await setup(t); const source = await add('会变化');
  const c = await app.request('scanCatalog');
  const changed = source.bytes.toString().replace('请检查迁移链路', '已变更迁移链路'); await writeFile(source.file, changed);
  await assert.rejects(app.request('catalogPreview', { scanID: c.id, id: c.entries[0].id }), /对话已变化/);
  await app.request('startSelected', { scanID: c.id, ids: [c.entries[0].id] }); await app.quick.done;
  assert.equal(app.quick.current.imported, 0); assert.match(app.quick.current.errors[0].error, /自扫描后已变化/); assert.equal(client.sessions.size, 0);
});
test('OpenCode 扫描跨项目预览并仅选一条导入 DSH；源变更与版本变更均保护', async t => {
  const { app, add, client, home } = await setup(t, 'oc-to-dsh'); await add('一'); await add('二', 'BETA');
  const input = { direction: 'oc-to-dsh', dshRoot: path.join(home, 'target-dsh') };
  const c = await app.request('scanCatalog', input); assert.equal(c.entries.length, 2); assert.equal(c.projects.length, 2);
  const e = c.entries[0]; const p = await app.request('catalogPreview', { scanID: c.id, id: e.id }); assert.match(JSON.stringify(p), /原始文件内容/);
  client.version = 'new-version'; await assert.rejects(app.request('startSelected', { scanID: c.id, ids: [e.id] }), /版本已变化/); client.version = c.plan.target.version;
  await app.request('startSelected', { scanID: c.id, ids: [e.id] }); await app.quick.done;
  assert.equal(app.quick.current.total, 1); assert.equal(app.quick.current.imported, 1); assert.equal(client.sessions.size, 2);
  await app.request('rollback', { id: app.quick.current.jobs[0].id });
  client.sessions.get(e.sourceID).info.title += 'changed';
  await assert.rejects(app.request('catalogPreview', { scanID: c.id, id: e.id }), /对话已变化/);
  await app.request('startSelected', { scanID: c.id, ids: [e.id] }); await app.quick.done;
  assert.equal(app.quick.current.imported, 0); assert.match(app.quick.current.errors[0].error, /自扫描后已变化/);
});
