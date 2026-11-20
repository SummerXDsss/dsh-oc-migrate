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
