import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { DesktopService } from '../../packages/desktop/src/service.mjs';
import { createCliClient } from '../../packages/opencode-client/src/index.mjs';
import { fixture } from '../fixture.mjs';
const exec=promisify(execFile);
test('并存的真实 1.x CLI / 2.x：指定项目各自原生列表可见、正文可读、去重与撤销', {skip:!process.env.OPENCODE_V1_BIN||!process.env.OPENCODE_V2_BIN,timeout:300000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-both-visible-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const env={...process.env,HOME:root,DSH_HOME:path.join(root,'.dsh'),USERPROFILE:root,APPDATA:path.join(root,'roaming'),LOCALAPPDATA:path.join(root,'local'),XDG_DATA_HOME:path.join(root,'data'),XDG_STATE_HOME:path.join(root,'state'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_CACHE_HOME:path.join(root,'cache'),OPENCODE_DB:path.join(root,'opencode.db'),OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_CONFIG_CONTENT:'{}'};
 const project=path.join(root,'project'),sources=path.join(root,'sources');await mkdir(project);await exec('git',['init','-q'],{cwd:project});
 for(const id of ['chosen','unselected']){const s=fixture({id}).sessions[0];s.header.cwd=await realpath(project);const dir=path.join(sources,id);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'session.v4.jsonl'),[{type:'session',...s.header,delegationDepth:0},...s.events].map(e=>JSON.stringify(e)+'\n').join(''));}
 const makeClient=config=>createCliClient({...config,env});const bins=[process.env.OPENCODE_V2_BIN,process.env.OPENCODE_V1_BIN];
 const app=await new DesktopService({root:path.join(root,'app'),home:root,candidates:bins,makeClient}).init();t.after(()=>app.stop());
 const c=await app.request('scanCatalog',{sourceRoot:sources});assert.equal(c.plan.targets.length,2);const chosen=c.entries.find(e=>e.sourceID==='chosen');
 await app.request('startSelected',{scanID:c.id,ids:[chosen.id]});await app.quick.done;const run=app.quick.current;assert.equal(run.status,'completed',JSON.stringify(run.errors));assert.equal(run.imported,1);assert.equal(run.nativeSessions,2);
 const rows=async(bin,gen)=>JSON.parse((await exec(bin,['session','list','--format','json','--max-count','100',gen==='v1'?'--pure':'--standalone'],{cwd:project,env,timeout:60000})).stdout.trim()||'[]');
 for(const job of run.jobs){const report=await app.jobs.read(job.id),target=run.targets.find(x=>x.generation===report.generation),client=await makeClient({...target,directory:project});
   const list=await rows(target.binary,target.generation);assert(list.some(s=>s.id===report.sessions[0].sessionID),JSON.stringify({generation:target.generation,list}));
   const actual=await client.export(report.sessions[0].sessionID);assert.match(JSON.stringify(actual.messages),/原始文件内容/);assert.equal(actual.info.location?.directory??actual.info.directory,await realpath(project));
 }
 await app.request('startSelected',{scanID:c.id,ids:[chosen.id]});await app.quick.done;
 for(const target of run.targets)assert.equal((await rows(target.binary,target.generation)).length,1,'second import must not duplicate or include unselected source');
 for(const job of run.jobs)assert.equal((await app.request('rollback',{id:job.id})).status,'rolled-back');
 for(const target of run.targets)assert.equal((await rows(target.binary,target.generation)).length,0);
 t.diagnostic('two native project lists PASS; selected=1; two histories readable; no unselected/duplicate; rollback both=empty');
});
