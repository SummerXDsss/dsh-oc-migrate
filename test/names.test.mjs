import {test} from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';import {convertBundle} from '../packages/core/src/convert.mjs';import {convertOpenCode} from '../packages/core/src/reverse.mjs';import {verifyTranscript} from '../packages/opencode-client/src/index.mjs';import {decodeLocalLog} from '../packages/plugin/src/local-reader.mjs';
test('同一原件的扫描标签、迁入 OpenCode 标题、DSH 往返标题一致，旧日志首条提示不丢失',()=>{
 const bundle=fixture(),s=bundle.sessions[0];delete s.title;const bytes=Buffer.from([{type:'session',...s.header},...s.events].map(JSON.stringify).join('\n')+'\n');const decoded=decodeLocalLog(bytes);
 assert.equal(decoded.titleOrigin,'first-message');assert.equal(decoded.title,'请检查迁移链路，保留中文。');
 for(const generation of ['v1','v2']){const raw=convertBundle(bundle,{directory:'/tmp/project',generation})[0].transcript;assert.equal(raw.info.title,decoded.title);assert.equal(convertOpenCode(raw).session.title,decoded.title);}
});
test('原生回读也核对标题；同正文但标题不同不能报告验证通过或回滚删除',()=>{
 const expected=convertBundle(fixture(),{directory:'/tmp/project',generation:'v2'})[0].transcript;const changed=structuredClone(expected);changed.info.title='用户后续改名';assert.throws(()=>verifyTranscript(expected,changed),/回读不匹配/);
});

import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {mockClient} from './fixture.mjs';import {MigrationStore} from '../packages/middleware/src/store.mjs';import {ReverseStore} from '../packages/middleware/src/reverse.mjs';
async function setup(t){const root=await mkdtemp(path.join(os.tmpdir(),'native-names-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function namedClient(directory){const client=mockClient('v2'),project={id:'project',canonical:directory};const save=client.import;client.listProjects=async()=>[structuredClone(project)];client.updateProjectName=async(id,name)=>{assert.equal(id,'project');project.name=name;};client.updateSessionTitle=async(id,title)=>{client.sessions.get(id).info.title=title;};client.import=async(f,tr)=>{const r=await save(f,tr);client.sessions.get(tr.info.id).info.projectID='project';return r;};return {client,project};}
test('项目正式名称传到原生目标，两个任务共享名称，最后回滚恢复默认且原件不变',async t=>{
 const root=await setup(t),{client,project}=namedClient(root),store=new MigrationStore({state:root+'/jobs',directory:root,client});const a=fixture({id:'a'}),b=fixture({id:'b'});for(const bundle of [a,b])bundle.sessions[0].project={name:'项目中文名称',directory:root};const original=JSON.stringify(a);
 const one=await store.receive(a,{importNow:true}),two=await store.receive(b,{importNow:true});assert.equal(one.status,'imported',one.error);assert.equal(two.status,'imported',two.error);assert.equal(project.name,'项目中文名称');assert.equal(JSON.stringify(a),original);
 await store.rollback(one.id);assert.equal(project.name,'项目中文名称');await store.rollback(two.id);assert.equal(project.name,'');assert.equal(client.sessions.size,0);
});
test('项目名冲突或用户随后改名时不覆盖；失败任务仍可回滚原生会话',async t=>{
 const root=await setup(t),{client,project}=namedClient(root),store=new MigrationStore({state:root+'/jobs',directory:root,client}),b=fixture();b.sessions[0].project={name:'源项目名',directory:root};project.name='用户项目';const failed=await store.receive(b,{importNow:true});assert.equal(failed.status,'failed');assert.match(failed.error,/项目名冲突/);assert.equal(project.name,'用户项目');await store.rollback(failed.id);assert.equal(client.sessions.size,0);
 project.name='';const ok=await store.receive(b,{importNow:true});assert.equal(ok.status,'imported');project.name='用户后续项目名';await store.rollback(ok.id);assert.equal(project.name,'用户后续项目名');
});
test('旧迁移默认 ID 标题按原件修复，回滚恢复原标题而非删除原有会话',async t=>{
 const root=await setup(t),{client}=namedClient(root),store=new MigrationStore({state:root+'/jobs',directory:root,client}),b=fixture(),raw=convertBundle(b,{directory:root,generation:'v2'})[0].transcript;const existing=structuredClone(raw);existing.info.title='DeepSeek · '+b.sessions[0].header.id;client.sessions.set(raw.info.id,existing);
 const beforeTitle=existing.info.title;const report=await store.receive(b,{importNow:true});assert.equal(report.status,'imported',report.error);assert.equal((await client.export(raw.info.id)).info.title,b.sessions[0].title);await store.rollback(report.id);assert.equal(client.sessions.size,1);assert.equal((await client.export(raw.info.id)).info.title,beforeTitle);
});
test('DSH 反向登记原生项目名称与成员，单任务回滚恢复注册表原始字节',async t=>{
 const root=await setup(t);await mkdir(root+'/storages');const before=JSON.stringify({unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:[],archivedSessionIds:[],pinnedSessionIds:[]},tables:{workspaces:{}}});await writeFile(root+'/storages/workspace.json',before);
 const raw=convertBundle(fixture(),{directory:root,generation:'v2'})[0].transcript;raw.migrationProject={name:'原生中文项目',directory:root};const store=new ReverseStore({state:root+'/jobs',dshRoot:root+'/sessions'});const report=await store.receive(raw,{importNow:true});assert.equal(report.status,'imported',report.error);
 const data=JSON.parse(await readFile(root+'/storages/workspace.json'));const record=Object.values(data.tables.workspaces)[0];assert.equal(record.title,'原生中文项目');assert(record.sessionIds.includes(report.sessions[0].sessionID));assert.equal(await store.receive(raw,{importNow:true}).then(r=>r.id),report.id);
 await store.rollback(report.id);assert.equal(await readFile(root+'/storages/workspace.json','utf8'),before);
});
test('DSH 项目并发式多任务回滚只移除自己成员，不覆盖后续新增项目',async t=>{
 const root=await setup(t),store=new ReverseStore({state:root+'/jobs',dshRoot:root+'/sessions'});const make=id=>{const raw=convertBundle(fixture({id}),{directory:root,generation:'v2'})[0].transcript;raw.migrationProject={name:'共享中文项目',directory:root};return raw;};const one=await store.receive(make('1'),{importNow:true}),two=await store.receive(make('2'),{importNow:true});assert.equal(two.status,'imported',two.error);
 const file=root+'/storages/workspace.json',data=JSON.parse(await readFile(file));data.tables.workspaces.user={path:'/user',title:'保留用户项目',sessionIds:[],createdAt:'x',updatedAt:'x'};data.global.workspaceIds.push('user');await writeFile(file,JSON.stringify(data));await store.rollback(one.id);let after=JSON.parse(await readFile(file));assert(Object.values(after.tables.workspaces).some(r=>r.sessionIds.includes(two.sessions[0].sessionID)));await store.rollback(two.id);after=JSON.parse(await readFile(file));assert.deepEqual(Object.keys(after.tables.workspaces),['user']);assert.equal(after.tables.workspaces.user.title,'保留用户项目');
});
test('反向项目元数据必须匹配原件 cwd；拒绝空白名称，未写入日志',async t=>{
 const root=await setup(t),store=new ReverseStore({state:root+'/jobs',dshRoot:root+'/sessions'}),raw=convertBundle(fixture(),{directory:root,generation:'v2'})[0].transcript;
 for(const project of [{name:'名称',directory:root+'/other'},{name:' ',directory:root},{name:'x'.repeat(501),directory:root}])await assert.rejects(store.receive({...raw,migrationProject:project},{importNow:true}),/项目名称或目录/);
 await assert.rejects(access(root+'/sessions'));
});
test('原生 DSH 日志已被移除时，回滚仍清理本任务拥有的工作区成员',async t=>{
 const root=await setup(t),store=new ReverseStore({state:root+'/jobs',dshRoot:root+'/sessions'}),raw=convertBundle(fixture(),{directory:root,generation:'v2'})[0].transcript;raw.migrationProject={name:'中文项目',directory:root};const report=await store.receive(raw,{importNow:true});assert.equal(report.status,'imported',report.error);await rm(report.sessions[0].file);await store.rollback(report.id);await assert.rejects(access(root+'/storages/workspace.json'));
});
test('DSH 首次冷列表即有标题缓存，仅含 title 投影，回滚一并移除',async t=>{
 const root=await setup(t),store=new ReverseStore({state:root+'/jobs',dshRoot:root+'/sessions'}),raw=convertBundle(fixture(),{directory:root,generation:'v2'})[0].transcript;const report=await store.receive(raw,{importNow:true});assert.equal(report.status,'imported',report.error);
 const file=report.titleCache.file,cache=JSON.parse(await readFile(file)),captured=await (await import('../packages/plugin/src/local-reader.mjs')).captureLocalSession({file:report.sessions[0].file});
 assert.equal(cache.version,7);assert.equal(cache.record.identity.cwd,root);assert.equal(cache.record.identity.formatVersion,4);assert.deepEqual(Object.keys(cache.record.rows),['title']);assert.equal(cache.record.rows.title.ver,1);assert.equal(cache.record.rows.title.val,raw.info.title);assert.equal(cache.record.rows.title.seq,captured.session.events.at(-1).seq);
 await store.receive(raw,{importNow:true});await store.rollback(report.id);await assert.rejects(access(file));
});
