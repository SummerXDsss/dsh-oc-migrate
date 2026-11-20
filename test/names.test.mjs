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
