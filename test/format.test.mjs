import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertBundle } from '../packages/core/src/convert.mjs';
import { convertOpenCode } from '../packages/core/src/reverse.mjs';
import { verifyTranscript } from '../packages/opencode-client/src/index.mjs';
import { fixture } from './fixture.mjs';

for (const generation of ['v1', 'v2']) {
  test(`${generation}: 反向用量保留且同代往返不重复工具说明`, () => {
    const original = convertBundle(fixture(), { directory: '/tmp/format-project', generation, stateSnapshots: false })[0].transcript;
    const converted = convertOpenCode(original);
    const assistant = converted.session.events.find(e => e.type === 'assistant/message');
    assert.equal(assistant.data.usage?.inputTokens, 10);
    assert.equal(assistant.data.usage?.cacheReadTokens, 2);
    const round = convertBundle({format:'dsh-oc-migrate',version:1,sessions:[converted.session]}, {directory:'/tmp/format-project',generation,stateSnapshots:false})[0].transcript;
    assert.equal(JSON.stringify(round).split('[DSH 历史工具快照').length, JSON.stringify(original).split('[DSH 历史工具快照').length);
  });
  test(`${generation}: 已中断响应不伪装正常完成，工具空输出不改正文`, () => {
    const source=fixture(); source.sessions[0].events[4].data.interrupted=true;
    source.sessions[0].events[6].data.message.content=[{type:'text',text:''}];
    const out=convertBundle(source,{directory:'/tmp/format-project',generation})[0];
    const assistant=out.transcript.messages.find(m=>(m.info?.role??m.type)==='assistant');
    assert.equal((assistant.info??assistant).finish,'error');
    const tool=(assistant.parts??assistant.content).find(p=>p.type==='tool');
    assert.equal(tool.state.output??tool.state.content[0].text,'');
    assert.match(out.warnings.join(),/中断/);
  });
}

test('原生回读校验必须检查附件、模型用量和终止原因，而非只检查文字', () => {
  const expected=convertBundle(fixture(),{directory:'/tmp/format-project',generation:'v2'})[0].transcript;
  expected.messages[0].files=[{data:'YQ==',mime:'text/plain',source:{type:'inline'},name:'a.txt'}];
  const changed=structuredClone(expected); changed.messages[0].files[0].data='Yg==';
  assert.throws(()=>verifyTranscript(expected,changed),/回读不匹配/);
  const usage=structuredClone(expected); usage.messages.find(m=>m.type==='assistant').tokens.input++;
  assert.throws(()=>verifyTranscript(expected,usage),/回读不匹配/);
});

const bundleFor = session => ({format:'dsh-oc-migrate',version:1,sessions:[session]});
for (const generation of ['v1','v2']) test(`${generation}: 原生多段工具/错误/引用/时间/终止状态往返；修改过的 DSH 内容不被旧原件覆盖`, () => {
  const source=convertBundle(fixture(),{directory:'/tmp/format-project',generation,stateSnapshots:false})[0].transcript;
  const user=source.messages.find(m=>(m.info?.role??m.type)==='user'), assistant=source.messages.find(m=>(m.info?.role??m.type)==='assistant');
  // Remove envelopes: this represents a native, non-migrated conversation.
  for (const record of source.messages) { delete record.metadata; for(const p of record.parts??[]) { delete p.metadata; if(p.state) delete p.state.metadata; } }
  (assistant.info??assistant).finish='length'; (assistant.info??assistant).cost=0.012;
  (assistant.info??assistant).time.completed+=900;
  const tool=(assistant.parts??assistant.content).find(p=>p.type==='tool');
  if(generation==='v1') {
    user.parts.push({id:'prt_file',messageID:user.info.id,sessionID:source.info.id,type:'file',mime:'image/png',filename:'示意.png',url:'data:image/png;base64,YWJj'});
    tool.state={status:'error',input:{command:'historical only'},error:'第一行\n第二行',time:{start:1795132800004,end:1795132800099},metadata:{diff:'原始差异'}};
  } else {
    user.files=[{name:'示意.png',mime:'image/png',data:'YWJj',source:{type:'inline'}}]; user.agents=[{name:'plan'}]; user.skills=[{id:'skill-id',name:'测试',text:'历史技能引用'}];
    tool.state={status:'error',input:{command:'historical only'},error:{type:'test-error',message:'第一行\n第二行'},content:[{type:'text',text:''},{type:'file',uri:'file:///original/report.txt',mime:'text/plain',name:'report.txt'},{type:'text',text:'末段'}],metadata:{diff:'原始差异'}};
  }
  const raw=JSON.stringify(source), c=convertOpenCode(source);
  assert.equal(JSON.stringify(source),raw,'转换不得修改输入');
  assert.match(c.warnings.join(),/附件/);
  const round=convertBundle(bundleFor(c.session),{directory:'/tmp/format-project',generation,stateSnapshots:false})[0].transcript;
  const shape=record=>{const r=structuredClone(record);if(r.info){delete r.info.id;delete r.info.sessionID;delete r.info.parentID;for(const p of r.parts){delete p.id;delete p.messageID;delete p.sessionID;}}else delete r.id;return r;};
  assert.deepEqual(round.messages.map(shape),source.messages.map(shape));
  const modified=structuredClone(c.session), first=modified.events.find(e=>e.type==='user/message'); first.data.content[0].text='用户在 DSH 修改了这段文字';
  const after=convertBundle(bundleFor(modified),{directory:'/tmp/format-project',generation,stateSnapshots:false})[0].transcript;
  assert.match(JSON.stringify(after),/用户在 DSH 修改了这段文字/);
});

for(const generation of ['v1','v2']) test(`${generation}: DSH 原始角色、分块、非 JSON 对象参数与多段结果可以往返恢复`,()=>{
  const source=fixture(); source.sessions[0].events[4].data.message.content[2].arguments='[1, "保留原始参数"]'; source.sessions[0].events[5].data.arguments='[1, "保留原始参数"]';
  source.sessions[0].events[6].data.message.content=[{type:'text',text:'第一段\n'},{type:'text',text:''},{type:'text',text:'第三段'}];
  const original=source.sessions[0].events.filter(e=>['system/message','user/message','assistant/message','tool/result'].includes(e.type));
  const out=convertBundle(source,{directory:'/tmp/format-project',generation,stateSnapshots:false})[0].transcript;
  const back=convertOpenCode(out).session.events.filter(e=>['system/message','user/message','assistant/message','tool/result'].includes(e.type));
  assert.deepEqual(back.map(e=>[e.type,e.time,e.type==='user/message'?e.data:e.data.message]),original.map(e=>[e.type,e.time,e.type==='user/message'?e.data:e.data.message]));
});

test('跨代往返仅移除带 hash 标识的工具展示副本，保留同前缀的用户正文',()=>{
  const original=convertBundle(fixture(),{directory:'/tmp/format-project',generation:'v1',stateSnapshots:false})[0].transcript;
  const assistant=original.messages.find(m=>m.info.role==='assistant');
  assistant.parts.push({...structuredClone(assistant.parts.find(p=>p.type==='text')),id:'prt_custom',text:'[DSH 历史工具快照 这是用户自己的文字'});
  const session=convertOpenCode(original).session;
  const out=convertBundle(bundleFor(session),{directory:'/tmp/format-project',generation:'v2',stateSnapshots:false})[0].transcript;
  const text=out.messages.filter(m=>m.type==='assistant').flatMap(m=>m.content).filter(p=>p.type==='text').map(p=>p.text);
  assert.equal(text.filter(s=>s.startsWith('[DSH 历史工具快照 ·')).length,1);
  assert.ok(text.includes('[DSH 历史工具快照 这是用户自己的文字'));
});

test('更改了工具参数、附件或终止原因时，不套用旧 DSH 原件',()=>{
  for(const generation of ['v1','v2']){
    const original=convertBundle(fixture(),{directory:'/tmp/format-project',generation,stateSnapshots:false})[0].transcript;
    const assistant=original.messages.find(m=>(m.info?.role??m.type)==='assistant');
    (assistant.parts??assistant.content).find(p=>p.type==='tool').state.input.path='changed.txt';
    const session=convertOpenCode(original).session;
    assert.equal(JSON.parse(session.events.find(e=>e.type==='assistant/message').data.message.content.find(p=>p.type==='tool-call').arguments).path,'changed.txt');
  }
});

for(const from of ['v1','v2'])test(`${from} 跨代结构转换保留正文、文件数据、工具 ID、usage、时间和 length`,async()=>{
  const {formatTranscript,IMAGE}=await import('./format-fixture.mjs');
  const original=formatTranscript(from,'/tmp/format-project'),session=convertOpenCode(original).session,to=from==='v1'?'v2':'v1';
  const out=convertBundle(bundleFor(session),{directory:'/tmp/format-project',generation:to,stateSnapshots:false})[0].transcript;
  const user=out.messages[0],assistant=out.messages[1];
  assert.deepEqual((assistant.info??assistant).tokens,(original.messages[1].info??original.messages[1]).tokens);
  assert.deepEqual((assistant.info??assistant).time,(original.messages[1].info??original.messages[1]).time);
  assert.equal((assistant.info??assistant).finish,'length');
  if(to==='v1'){assert.equal(user.parts.find(p=>p.type==='file').url,`data:image/png;base64,${IMAGE}`);assert.match(user.parts[0].text,/^  原始空格/);}
  else{assert.equal(user.files[0].data,IMAGE);assert.match(user.text,/^  原始空格/);}
  const tools=(assistant.parts??assistant.content).filter(p=>p.type==='tool');
  assert.deepEqual(tools.map(p=>p.callID??p.id),['call-1','call-error']);
  assert.equal(tools[0].state.status,'completed');assert.equal(tools[1].state.status,'error');
});

test('DSH 用户多文字块不凭空插入换行，2.x 工具结果保留多段而非揉成一段',()=>{
  const source=fixture();source.sessions[0].events[3].data.content=[{type:'text',text:'前半'},{type:'text',text:'后半\n'}];
  source.sessions[0].events[6].data.message.content=[{type:'text',text:'一'},{type:'text',text:''},{type:'text',text:'三\n'}];
  for(const generation of ['v1','v2']){
    const out=convertBundle(source,{directory:'/tmp/format-project',generation})[0];
    if(generation==='v1'){assert.deepEqual(out.transcript.messages[1].parts.map(p=>p.text),['前半','后半\n']);assert.match(out.warnings.join(),/多段结果合并/);}
    else{assert.equal(out.transcript.messages[1].text,'前半后半\n');assert.deepEqual(out.transcript.messages[2].content.find(p=>p.type==='tool').state.content,source.sessions[0].events[6].data.message.content);}
  }
});

test('有回程结构的未完成原生工具也不会被恢复成 running/pending',async()=>{
  const {formatTranscript}=await import('./format-fixture.mjs');
  for(const generation of ['v1','v2']){
    const source=formatTranscript(generation,'/tmp/format-project'),assistant=source.messages[1];
    const tool=(assistant.parts??assistant.content).find(p=>p.type==='tool');tool.state={status:'running',input:{command:'历史，不执行'},metadata:{}};
    const session=convertOpenCode(source).session;
    const out=convertBundle(bundleFor(session),{directory:'/tmp/format-project',generation,stateSnapshots:false})[0];
    assert.ok(out.transcript.messages.flatMap(m=>m.parts??m.content??[]).filter(p=>p.type==='tool').every(p=>['completed','error'].includes(p.state.status)));
  }
});

test('回读校验同时覆盖 1.x 工具元数据和时间；桥接不复活未完成响应',()=>{
  const expected=convertBundle(fixture(),{directory:'/tmp/format-project',generation:'v1'})[0].transcript;
  const tool=expected.messages.find(m=>m.info.role==='assistant').parts.find(p=>p.type==='tool'); tool.state.metadata.diff='原始 diff';
  const changed=structuredClone(expected);changed.messages.find(m=>m.info.role==='assistant').parts.find(p=>p.type==='tool').state.metadata.diff='被改变';
  assert.throws(()=>verifyTranscript(expected,changed),/回读不匹配/);
  const timing=structuredClone(expected);timing.messages.find(m=>m.info.role==='assistant').info.time.completed++;
  assert.throws(()=>verifyTranscript(expected,timing),/回读不匹配/);
});
