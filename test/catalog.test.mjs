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
    s.events.push({seq:s.events.length,time:s.header.createdAt+100,type:'session/title',data:{title:s.title,messageSeqs:[],source:{kind:'user'}}});
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
  assert.equal(e.title, '中文 压缩对话');
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

test('管理器模板：搜索/收藏/项目组合筛选，分页保留全局选择，源内容与名称转义', async t => {
  const { transpileModule, ModuleKind } = await import('typescript');
  const source = await readFile(new URL('../desktop/src/catalog.ts', import.meta.url), 'utf8');
  const output = transpileModule(source, { compilerOptions: { module: ModuleKind.ES2022 } }).outputText;
  const { catalogHTML, newCatalogView, filteredEntries } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));
  const c = { id: 'scan', direction: 'dsh-to-oc', input: {}, scannedAt: '2026-11-20T00:00:00Z', plan: { target: {version:'fixture'} }, errors: [], projects: [{id:'A',name:'项目甲',directory:'/A',count:45},{id:'B',name:'项目乙',directory:'/B',count:1}], entries: Array.from({length:46},(_,i)=>({id:String(i),sourceID:'s'+i,title:i===0?'<script>alert(1)</script>':'中文对话'+i,directory:i===45?'/B':'/A',projectID:i===45?'B':'A',starred:i===0,messageCount:3,updated:i})) };
  const v=newCatalogView();c.projects[0].alias='项目别名';v.query='项目别名';assert.equal(filteredEntries(c,v).length,45);v.query='';v.project='A';v.onlyStarred=true;
  assert.equal(filteredEntries(c,v).length,1);v.query='中文';assert.equal(filteredEntries(c,v).length,0);
  v.query='';v.onlyStarred=false;v.selected.add('45');
  let html=catalogHTML(c,v);assert.equal((html.match(/data-catalog-select=/g)||[]).length,40);assert.match(html,/已选 1 个对话/);assert.match(html,/1 \/ 2/);
  v.page=1;html=catalogHTML(c,v);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>alert/);
  v.focused='0';v.preview={id:'0',offset:0,total:1,messages:[{role:'assistant',active:false,text:'<img src=x onerror=alert(1)>'}]};
  html=catalogHTML(c,v);assert.match(html,/&lt;img/);assert.match(html,/已被替换 · 全文保留/);assert.match(html,/不改源标题/);
  assert.match(catalogHTML(c,v,true),/data-action="startSelected" disabled/);
});

test('同一项目的符号链接路径合并；长消息预览截断有标识，原件不截断', async t => {
  const { app, add, home } = await setup(t);
  const first = await add('甲','ALPHA'); const second = await add('乙','BETA');
  const { symlink } = await import('node:fs/promises'); const alias = path.join(home,'ALPHA-LINK');
  await symlink(path.join(home,'ALPHA'),alias,'dir');
  const rows=(await readFile(second.file,'utf8')).trim().split('\n').map(JSON.parse);rows[0].cwd=alias;rows.find(e=>e.type==='user/message').data.content[0].text='长'.repeat(15000);
  await writeFile(second.file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const c=await app.request('scanCatalog');assert.equal(c.projects.length,1);assert.equal(c.projects[0].count,2);
  const e=c.entries.find(e=>e.sourceID==='乙');
  const p=await app.request('catalogPreview',{scanID:c.id,id:e.id,offset:1,limit:1});assert.equal(p.total,4);assert.equal(p.messages[0].text.length,12000);assert.equal(p.messages[0].truncated,true);
  assert.match(await readFile(second.file,'utf8'),new RegExp('长'.repeat(15000)));
  for(const args of [{offset:-1},{limit:0},{limit:51}])await assert.rejects(app.request('catalogPreview',{scanID:c.id,id:e.id,...args}),/分页参数无效/);
  assert.deepEqual(await readFile(first.file),first.bytes);
});

test('名称识别读取 DSH 工作区注册表，而非仅显示目录末段；旧日志无标题时标明首条消息', async t => {
  const {app,add,home,client}=await setup(t);const source=await add('registry-name','folder-slug');
  const lines=(await readFile(source.file,'utf8')).trimEnd().split('\n').map(JSON.parse);lines.pop();await writeFile(source.file,lines.map(JSON.stringify).join('\n')+'\n');
  const storage=path.join(home,'.dsh/storages');await mkdir(storage,{recursive:true});
  const bytes=JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:{w:{path:path.join(home,'folder-slug'),title:'正式项目中文名',sessionIds:['registry-name']}}}});
  await writeFile(path.join(storage,'workspace.json'),bytes);
  const c=await app.request('scanCatalog');assert.equal(c.projects[0].name,'正式项目中文名');assert.equal(c.projects[0].nameOrigin,'dsh-workspace');
  assert.equal(c.entries[0].title,'请检查迁移链路，保留中文。');assert.equal(c.entries[0].titleOrigin,'first-message');assert.equal(client.sessions.size,0);
  assert.equal(await readFile(path.join(storage,'workspace.json'),'utf8'),bytes);
  await writeFile(path.join(storage,'workspace.json'),'{');const fallback=await app.request('scanCatalog');assert.equal(fallback.entries.length,1);assert.equal(fallback.projects[0].name,'folder-slug');assert.match(fallback.errors[0].error,/项目暂按原始路径显示/);
});
test('OpenCode 项目自定义名及导出标题优先，不把 global 项目合并为根目录', async t => {
  const {app,add,client,home}=await setup(t,'oc-to-dsh');await add('native-names','folder-slug');
  const transcript=[...client.sessions.values()][0];transcript.info.projectID='native-project';transcript.info.title='原生对话中文标题';
  client.listProjects=async()=>[{id:'native-project',name:'原生项目自定义名',canonical:path.join(home,'folder-slug')}];
  let c=await app.request('scanCatalog',{direction:'oc-to-dsh'});assert.equal(c.entries[0].title,'原生对话中文标题');assert.equal(c.entries[0].titleOrigin,'source');assert.equal(c.projects[0].name,'原生项目自定义名');
  transcript.info.projectID='global';client.listProjects=async()=>[{id:'global',name:'Global',canonical:'/'}];
  c=await app.request('scanCatalog',{direction:'oc-to-dsh'});assert.equal(c.projects[0].name,'folder-slug');assert.notEqual(c.projects[0].directory,'/');
});
