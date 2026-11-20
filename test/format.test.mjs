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
