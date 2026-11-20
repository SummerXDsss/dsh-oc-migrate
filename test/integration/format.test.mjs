import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {createCliClient,verifyTranscript,transcriptShape} from '../../packages/opencode-client/src/index.mjs';
import {atomicJSON,MigrationStore} from '../../packages/middleware/src/store.mjs';
import {ReverseStore} from '../../packages/middleware/src/reverse.mjs';
import {captureLocalSession} from '../../packages/plugin/src/local-reader.mjs';
import {formatTranscript,IMAGE} from '../format-fixture.mjs';
const bins={v1:process.env.OPENCODE_V1_BIN,v2:process.env.OPENCODE_V2_BIN};
for(const generation of ['v1','v2'])test(`真实 ${generation} 原生格式：附件/多段工具/错误/usage/时间 → DSH 严格 codec → 同代及跨代回读`,{skip:!bins.v1||!bins.v2,timeout:300000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),`dsh-native-format-${generation}-`));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'项目 中文');await mkdir(directory);
  const env={HOME:root,DSH_HOME:path.join(root,'.dsh'),USERPROFILE:root,APPDATA:path.join(root,'roaming'),LOCALAPPDATA:path.join(root,'local'),XDG_DATA_HOME:path.join(root,'data'),XDG_STATE_HOME:path.join(root,'state'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_CACHE_HOME:path.join(root,'cache'),OPENCODE_DB:path.join(root,'opencode.db'),OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_CONFIG_CONTENT:'{}',OPENCODE_DISABLE_PROJECT_CONFIG:'1'};
  const clients={};
  for(const gen of ['v1','v2'])clients[gen]=await createCliClient({binary:bins[gen],generation:gen,directory,env});
  await clients.v1.prepareStorage();
  // Initialize 2.x before adding 1.x fixtures: its first boot otherwise natively
  // upgrades existing legacy rows, which is unrelated to explicit conversion.
  await clients.v2.listAll();
  const client=clients[generation],source=formatTranscript(generation,directory),file=path.join(root,'native.json');await atomicJSON(file,source);
  await client.import(file,source);const native=await client.export(source.info.id);verifyTranscript(source,native);
  const reverse=new ReverseStore({state:path.join(root,'reverse'),dshRoot:path.join(root,'sessions')});
  const report=await reverse.receive(native,{importNow:true});assert.equal(report.status,'imported',report.error);
  const {session}=await captureLocalSession({file:report.sessions[0].file});
  assert.equal(session.events.find(e=>e.type==='assistant/message').data.usage.inputTokens,123);
  assert.equal(session.events.filter(e=>e.type==='tool/result').length,2);
  assert.ok(session.events.filter(e=>e.type==='migration/opencode-message').every(e=>e.ignorable===true));
  if(process.env.DSH_NATIVE_APP_ROOT){
    const {pathToFileURL}=await import('node:url');
    const load=name=>import(pathToFileURL(path.join(process.env.DSH_NATIVE_APP_ROOT,'node_modules/@deepseek-ai',name,'lib/index.js')));
    const {Context}=await load('cordis'),persistence=await load('dsh-session-persistence-jsonl'),{Session}=await load('dsh-session');
    const ctx=new Context(),scope=ctx.plugin(persistence,{root:path.join(root,'sessions'),compression:'zstd'});
    try{await scope.await();const handle=await ctx.sessionPersistence.open(session.header.id,'read');try{const data=await handle.read();const restored=Session.fromRestore(session.header.id,data.events,structuredClone(handle.header),handle.inheritedEventCount,data.eventState);assert.match(JSON.stringify(restored.deriveMessages()),/原始空格/);assert.equal(data.events.filter(e=>e.type==='migration/opencode-message').length,2);}finally{await handle.close();}}finally{await scope.dispose();}
  }
  const jobs=[];
  for(const gen of ['v1','v2']){
    const store=new MigrationStore({state:path.join(root,'forward-'+gen),directory,client:clients[gen]});
    const imported=await store.receive({format:'dsh-oc-migrate',version:1,sessions:[session]},{importNow:true});assert.equal(imported.status,'imported',imported.error);jobs.push([store,imported]);
    const back=await clients[gen].export(imported.sessions[0].sessionID);
    const user=back.messages[0],assistant=back.messages[1];
    assert.equal((assistant.info??assistant).finish,'length');assert.deepEqual((assistant.info??assistant).tokens,(native.messages[1].info??native.messages[1]).tokens);
    assert.deepEqual((assistant.info??assistant).time,(native.messages[1].info??native.messages[1]).time);
    assert.equal(gen==='v1'?user.parts.find(p=>p.type==='file').url:`data:image/png;base64,${user.files[0].data}`,`data:image/png;base64,${IMAGE}`);
    assert.equal((assistant.parts??assistant.content).filter(p=>p.type==='tool').length,2);
    if(gen===generation){const a=transcriptShape(native),b=transcriptShape(back);a.id=b.id;for(let i=0;i<a.messages.length;i++)a.messages[i].id=b.messages[i].id;assert.deepEqual(a,b);}
  }
  for(const[store,job]of jobs)assert.equal((await store.rollback(job.id)).status,'rolled-back');
  await reverse.rollback(report.id);assert.ok(await client.export(source.info.id));await client.remove(source.info.id);
  for(const gen of ['v1','v2'])assert.equal((await clients[gen].listAll()).length,0);
  t.diagnostic(`${client.version}: structured file bytes / multi-block results / errors / usage / finish / timestamps / same+cross-generation PASS; rollback empty`);
});
