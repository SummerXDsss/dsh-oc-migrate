import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { convertBundle } from '../packages/core/src/convert.mjs';
import { validateBundle, contentDigest, foldSurface } from '../packages/core/src/protocol.mjs';
import { verifyTranscript } from '../packages/opencode-client/src/index.mjs';

for (const generation of ['v1', 'v2']) {
  test(`${generation}: 中文、reasoning、工具、tokens、状态快照`, () => {
    const [item] = convertBundle(fixture(), { directory: '/target', generation });
    const transcript = item.transcript;
    assert.match(JSON.stringify(transcript), /请检查迁移链路/);
    const assistant = generation === 'v1' ? transcript.messages.find(m => m.info.role === 'assistant') : transcript.messages.find(m => m.type === 'assistant');
    const parts = assistant.parts ?? assistant.content;
    assert.equal(parts[0].type, 'reasoning');
    const tool = parts.find(p => p.type === 'tool');
    assert.equal(tool.state.status, 'completed');
    assert.equal(tool.state.input.path, 'README.md');
    assert.match(tool.state.output ?? tool.state.content[0].text, /原始文件内容/);
    const snapshot = parts.find(p => p.type === 'text' && p.text.startsWith('[DSH 历史工具快照'));
    assert.match(snapshot.text, /read_file/);
    assert.match(snapshot.text, /README.md/);
    assert.match(snapshot.text, /原始文件内容/);
    assert.match(snapshot.text, /未重新执行/);
    assert.equal((assistant.info ?? assistant).tokens.input, 10);
    assert.match(JSON.stringify(transcript), /状态快照/);
    if (generation === 'v1') assert.ok(transcript.messages.some(m => m.info.id === assistant.info.parentID));
    verifyTranscript(transcript, structuredClone(transcript));
  });
  test(`${generation}: 压缩前全文单独归档，当前上下文不重复`, () => {
    const [active, archive] = convertBundle(fixture({ compact: true }), { directory: '/target', generation });
    assert.ok(archive);
    assert.doesNotMatch(JSON.stringify(active.transcript), /原始文件内容/);
    assert.match(JSON.stringify(archive.transcript), /原始文件内容/);
    assert.match(archive.transcript.info.title, /归档全文/);
    assert.notEqual(active.sessionID, archive.sessionID);
    for (const item of [active, archive]) {
      const times = item.transcript.messages.map(m => (m.info ?? m).time.created);
      assert.deepEqual(times, [...times].sort((a, b) => a - b));
    }
    assert.equal(active.transcript.info.metadata.dshMigration.view, 'active');
    assert.equal(convertBundle(fixture({ compact: true }), { directory: '/target', generation, includeArchive: false }).length, 1);
  });
  test(`${generation}: 缺少工具结果不会生成可执行 pending`, () => {
    const bundle = fixture();
    bundle.sessions[0].events[6] = { ...bundle.sessions[0].events[6], type: 'custom/log', data: {}, surfaceOp: undefined };
    bundle.sessions[0].surfaceEventSeqs = foldSurface(bundle.sessions[0].events);
    const [item] = convertBundle(bundle, { directory: '/target', generation });
    assert.match(JSON.stringify(item.transcript), /历史中断/);
    assert.doesNotMatch(JSON.stringify(item.transcript), /"status":"pending"/);
    assert.ok(item.warnings.length);
  });
}

test('内容 hash 忽略导出时间，转换不修改原件，ID 稳定且按目标隔离', () => {
  const bundle = fixture(), original = JSON.stringify(bundle);
  const [a] = convertBundle(bundle, { directory: '/target' });
  const [b] = convertBundle(bundle, { directory: '/target' });
  const [c] = convertBundle(bundle, { directory: '/another-target' });
  assert.deepEqual(a, b); assert.notEqual(a.sessionID, c.sessionID); assert.equal(original, JSON.stringify(bundle));
  const another = structuredClone(bundle); another.exportedAt = 'later';
  assert.equal(contentDigest(bundle), contentDigest(another));
  const ids = a.transcript.messages.map(m => m.info.id); assert.deepEqual(ids, [...ids].sort());
});
test('拒绝序号断裂、伪造 surface、重复会话和非绝对目录', () => {
  const broken = fixture(); broken.sessions[0].events[0].seq = 10;
  assert.throws(() => validateBundle(broken), /seq/);
  const fake = fixture(); fake.sessions[0].surfaceEventSeqs = [3];
  assert.throws(() => validateBundle(fake), /不一致/);
  const duplicate = fixture(); duplicate.sessions.push(duplicate.sessions[0]);
  assert.throws(() => validateBundle(duplicate), /重复/);
  assert.throws(() => convertBundle(fixture(), { directory: 'relative' }), /绝对路径/);
});
test('未知媒体引用以文字与告知保留，不自动下载', () => {
  const bundle = fixture(); bundle.sessions[0].events[4].data.message.content.push({ type: 'image', attachment: { id: 'attachment-original' } });
  const [item] = convertBundle(bundle, { directory: '/target' });
  assert.match(JSON.stringify(item.transcript), /attachment-original/); assert.match(item.warnings.join(), /未复制字节/);
});
test('扩展插件的标量事件保留，不阻断完整会话导出', () => {
  const bundle = fixture(), events = bundle.sessions[0].events;
  events.push({ seq: events.length, type: 'extension/notice', time: 1795132800100, data: '原始标量事件' });
  validateBundle(bundle);
  assert.equal(events.at(-1).data, '原始标量事件');
});
test('导出命令的审计尾巴变化不会复制相同对话，raw 包 hash 仍有区别', () => {
  const bundle = fixture(), changed = structuredClone(bundle), events = changed.sessions[0].events;
  events.push({ seq: events.length, type: 'command/run', time: 1795132801000, data: { name: 'oc-migrate' } });
  events.push({ seq: events.length, type: 'command/done', time: 1795132801001, data: { name: 'oc-migrate' } });
  const [a] = convertBundle(bundle, { directory: '/target' });
  const [b] = convertBundle(changed, { directory: '/target' });
  assert.equal(a.sessionID, b.sessionID); assert.notEqual(contentDigest(bundle), contentDigest(changed));
  verifyTranscript(a.transcript, b.transcript);
});

test('继续聊天只接受完整原件的追加前缀，严格撤销校验仍拒绝删除已使用记录', async () => {
 const {verifyImportedHistory}=await import('../packages/opencode-client/src/index.mjs');
 for(const generation of ['v1','v2']){
 const expected=convertBundle(fixture(),{directory:'/target',generation})[0].transcript,actual=structuredClone(expected);
 const extra=structuredClone(actual.messages.at(-1));if(extra.info)extra.info.id='followup';else extra.id='followup';actual.messages.push(extra);
 assert.equal(verifyImportedHistory(expected,actual),'existing-continued-preserved');assert.throws(()=>verifyTranscript(expected,actual),/回读不匹配/);
 if(actual.messages[0].parts)actual.messages[0].parts[0].text='modified';else actual.messages[0].text='modified';assert.throws(()=>verifyImportedHistory(expected,actual),/回读不匹配/);
 }
});
