import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { DesktopService } from '../../packages/desktop/src/service.mjs';
import { createCliClient } from '../../packages/opencode-client/src/index.mjs';
import { convertBundle } from '../../packages/core/src/convert.mjs';
import { captureLocalSession, findLocalSessions } from '../../packages/plugin/src/local-reader.mjs';
import { fixture } from '../fixture.mjs';
for (const [generation, binary] of [['v1', process.env.OPENCODE_V1_BIN], ['v2', process.env.OPENCODE_V2_BIN]]) {
  test(`真实 ${generation} 管理器：扫描/项目分组/预览/只选一条双向迁移及回滚`, { skip: !binary, timeout: 300000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-catalog-native-')); t.after(() => rm(root, { recursive: true, force: true }));
    const env = { HOME: root, USERPROFILE: root, APPDATA: path.join(root,'roaming'), LOCALAPPDATA: path.join(root,'local'), XDG_DATA_HOME: path.join(root,'data'), XDG_STATE_HOME: path.join(root,'state'), XDG_CONFIG_HOME: path.join(root,'config'), XDG_CACHE_HOME: path.join(root,'cache'), OPENCODE_DB: path.join(root,'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE:'1', OPENCODE_DISABLE_MODELS_FETCH:'1', OPENCODE_CONFIG_CONTENT:'{}', OPENCODE_DISABLE_PROJECT_CONFIG:'1' };
    const makeClient = config => createCliClient({ ...config, binary, env });
    const app = await new DesktopService({ root: path.join(root,'app'), home: root, candidates:[binary], makeClient }).init();
    const sources = [];
    for (const [i,name] of ['ALPHA','BETA','BETA'].entries()) {
      const directory = path.join(root,name); await mkdir(directory,{recursive:true});
      if(i<2) { execFileSync('git',['init','-q',directory]); execFileSync('git',['-C',directory,'-c','user.name=fixture','-c','user.email=fixture@example.com','commit','--allow-empty','-qm',name]); }
      const session = fixture({id:'catalog-'+i}).sessions[0];session.header.cwd=directory;session.title='管理器中文-'+i;
      session.events.push({seq:session.events.length,time:session.header.createdAt+100,type:'session/title',data:{title:session.title,messageSeqs:[],source:{kind:'user'}}});
      const file=path.join(root,'.dsh/sessions',String(i),'session.v4.jsonl');await mkdir(path.dirname(file),{recursive:true});
      await writeFile(file,[{type:'session',...session.header},...session.events].map(e=>JSON.stringify(e)).join('\n')+'\n');sources.push(session);
    }
    await mkdir(path.join(root,'.dsh/storages'),{recursive:true});
    await writeFile(path.join(root,'.dsh/storages/workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:Object.fromEntries(['ALPHA','BETA'].map(name=>[name,{path:path.join(root,name),title:'正式项目-'+name,sessionIds:sources.filter(s=>s.header.cwd===path.join(root,name)).map(s=>s.header.id)}]))}}));
    const client=await makeClient({directory:root});
    let catalog=await app.request('scanCatalog');assert.equal(catalog.entries.length,3);assert.equal(catalog.projects.length,2);assert.equal((await client.listAll()).length,0);
    const chosen=catalog.entries.find(e=>e.sourceID==='catalog-1');
    assert.equal(chosen.title,'管理器中文-1');assert.equal(catalog.projects.find(p=>p.id===chosen.projectID).name,'正式项目-BETA');
    const preview=await app.request('catalogPreview',{scanID:catalog.id,id:chosen.id});assert.match(JSON.stringify(preview),/原始文件内容/);
    await app.request('startSelected',{scanID:catalog.id,ids:[chosen.id]});await app.quick.done;
    assert.equal(app.quick.current.imported,1,JSON.stringify(app.quick.current.errors));assert.equal((await client.listAll()).length,1);
    const actualForward=await client.export((await client.listAll())[0].id);assert.equal(actualForward.info.title,'管理器中文-1');assert.equal((await client.listProjects()).find(p=>p.id===actualForward.info.projectID).name,'正式项目-BETA');
    await client.updateSessionTitle(actualForward.info.id,'DeepSeek · catalog-1');assert.equal((await client.export(actualForward.info.id)).info.title,'DeepSeek · catalog-1');
    const repaired=await app.request('retry',{id:app.quick.current.jobs[0].id});assert.equal(repaired.status,'imported',repaired.error);assert.equal((await client.export(actualForward.info.id)).info.title,'管理器中文-1');
    await app.request('rollback',{id:app.quick.current.jobs[0].id});assert.equal((await client.listAll()).length,0);
    for(const source of sources) {
      const converted=convertBundle({...fixture(),sessions:[source]},{directory:source.header.cwd,generation})[0];const file=path.join(root,source.header.id+'.json');await writeFile(file,JSON.stringify(converted.transcript));
      const projectClient=await makeClient({directory:source.header.cwd});await projectClient.import(file,converted.transcript);
    }
    const nativeProjects=await client.listProjects();assert(Array.isArray(nativeProjects));
    for(const p of nativeProjects.filter(p=>p.id!=='global' && /ALPHA|BETA/.test(p.canonical??p.worktree??'')))await client.updateProjectName(p.id,'原生中文-'+path.basename(p.canonical??p.worktree));
    for(const info of await client.listAll()){const actual=await client.export(info.id);assert(nativeProjects.some(project=>project.id===actual.info.projectID));}
    const target=path.join(root,'reverse-target');catalog=await app.request('scanCatalog',{direction:'oc-to-dsh',dshRoot:target});assert.equal(catalog.entries.length,3);assert.equal(catalog.projects.length,2);
    const selected=catalog.entries[1];assert.match(JSON.stringify(await app.request('catalogPreview',{scanID:catalog.id,id:selected.id})),/原始文件内容/);
    await app.request('startSelected',{scanID:catalog.id,ids:[selected.id]});await app.quick.done;
    assert.equal(app.quick.current.imported,1,JSON.stringify(app.quick.current.errors));const scan=await findLocalSessions(target);assert.equal(scan.files.length,1);
    assert.match(JSON.stringify((await captureLocalSession(scan.files[0])).session),/原始文件内容/);
    const registry=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'storages/workspace.json'),'utf8'));const nativeID=(await captureLocalSession(scan.files[0])).session.header.id;const registered=Object.values(registry.tables.workspaces).find(w=>w.sessionIds.includes(nativeID));
    assert.match(registered.title,/原生中文-/);assert.equal(registered.title,catalog.projects.find(p=>p.id===selected.projectID).name);
    await app.request('rollback',{id:app.quick.current.jobs[0].id});assert.equal((await findLocalSessions(target)).files.length,0);assert.equal((await client.listAll()).length,3);
    for(const info of await client.listAll()) await client.remove(info.id);
    t.diagnostic('scan read-only; projects=2; sources=3; selected=1 each direction; preview/native history/rollback PASS');
  });
}
