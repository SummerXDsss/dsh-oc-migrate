import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DesktopService } from '../packages/desktop/src/service.mjs';
import { fixture, mockClient } from './fixture.mjs';
async function setup(t, failV1=false) {
  const root=await mkdtemp(path.join(os.tmpdir(),'dsh-visible-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),project=path.join(root,'project'),source=path.join(root,'sessions');await mkdir(home);await mkdir(project);
  const clients=new Map();const makeClient=async config=>{
    const generation=config.binary==='cli1'?'v1':'v2',key=generation+'|'+config.directory;
    if(!clients.has(key)) { const client={...mockClient(generation),version:generation==='v1'?'1.18.31':'opencode v2.3.2',identity:key};if(failV1&&generation==='v1')client.import=async()=>{throw Error('fixture write failed');};clients.set(key,client); }
    return clients.get(key);
  };
  for(const id of ['chosen','unselected']) {const s=fixture({id}).sessions[0];s.header.cwd=project;const dir=path.join(source,id);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'session.v4.jsonl'),[{type:'session',...s.header,delegationDepth:0},...s.events].map(e=>JSON.stringify(e)+'\n').join(''));}
  const app=await new DesktopService({root:path.join(root,'app'),home,candidates:['gui2','another2','cli1'],makeClient}).init();t.after(()=>app.stop());
  return{app,source,project,clients};
}
test('同机 1.x / 2.x 自动各选一个目标，不再只写 GUI 的一代',async t=>{
  const{app,source}=await setup(t);const p=await app.request('discoverQuick',{sourceRoot:source});
  assert.deepEqual(p.targets.map(x=>x.generation),['v2','v1']);assert.equal(p.target.binary,'gui2');assert.equal(p.targets.length,2);
  const one=await app.request('discoverQuick',{sourceRoot:source,binary:'cli1'});assert.equal(one.targets.length,1);assert.equal(one.target.generation,'v1');
});
test('指定一个对话在两代各自核对、去重和按原目标撤销；未选对话不混入',async t=>{
  const{app,source,project,clients}=await setup(t);const c=await app.request('scanCatalog',{sourceRoot:source});const chosen=c.entries.find(x=>x.sourceID==='chosen');
  await app.request('startSelected',{scanID:c.id,ids:[chosen.id]});await app.quick.done;
  const r=app.quick.current;assert.equal(r.status,'completed',JSON.stringify(r.errors));assert.equal(r.imported,1);assert.equal(r.nativeSessions,2);assert.equal(r.jobs.length,2);
  for(const gen of ['v1','v2'])assert.equal(clients.get(gen+'|'+project).sessions.size,1);
  await app.request('startSelected',{scanID:c.id,ids:[chosen.id]});await app.quick.done;
  for(const gen of ['v1','v2'])assert.equal(clients.get(gen+'|'+project).sessions.size,1);
  for(const job of r.jobs)assert.equal((await app.request('rollback',{id:job.id})).status,'rolled-back');
  for(const gen of ['v1','v2'])assert.equal(clients.get(gen+'|'+project).sessions.size,0);
});
test('其中一代失败不能标记全成功；另一代的迁入结果和撤销凭据仍保留',async t=>{
  const{app,source,project,clients}=await setup(t,true);const c=await app.request('scanCatalog',{sourceRoot:source});
  await app.request('startSelected',{scanID:c.id,ids:[c.entries[0].id]});await app.quick.done;
  assert.equal(app.quick.current.status,'partial');assert.equal(app.quick.current.imported,0);assert.match(app.quick.current.errors[0].error,/1.18.31/);assert.equal(clients.get('v2|'+project).sessions.size,1);assert.equal(app.quick.current.jobs.length,2);
});
