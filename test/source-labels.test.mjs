import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conversationLabel,workspaceFor} from '../packages/desktop/src/source-labels.mjs';
test('真实标题优先；提示截取按 Unicode 字符；无用户消息不伪造标题',()=>{
 assert.deepEqual(conversationLabel('原生标题',[{role:'user',text:'提示'}],'id'),{title:'原生标题',titleOrigin:'source'});
 assert.equal(conversationLabel(' ',[{role:'assistant',text:'忽略'},{role:'user',text:'👋'.repeat(90)}],'id').title,'👋'.repeat(80)+'…');
 assert.deepEqual(conversationLabel('',[],'session-12345678'),{title:'空白对话 · 12345678',titleOrigin:'empty'});
});
test('工作区优先显式挂接，其次取最近祖先，不用同名前缀串错项目',()=>{
 const records=[{id:'root',directory:'/code/app',sessions:[]},{id:'child',directory:'/code/app/sub',sessions:[]},{id:'attached',directory:'/other',sessions:['s']}];
 assert.equal(workspaceFor(records,'s','/code/app/sub').id,'attached');
 assert.equal(workspaceFor(records,'other','/code/app/sub/deep').id,'child');
 assert.equal(workspaceFor(records,'other','/code/application'),undefined);
});
