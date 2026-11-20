import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
const dataURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const compile = text => transpileModule(text, { compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 } }).outputText;
const catalogURL = dataURL(compile(await readFile(new URL('../desktop/src/catalog.ts', import.meta.url), 'utf8')));
const guideURL = dataURL(compile(await readFile(new URL('../desktop/src/onboarding.ts', import.meta.url), 'utf8')));
const navURL = dataURL(compile(await readFile(new URL('../desktop/src/navigation.ts', import.meta.url), 'utf8')));
const { normalizeDirection, directionControlHTML, quickInputFor, resolveConversationIDs, selectionPayload, catalogHTML, newCatalogView } = await import(catalogURL);
const catalog = (direction = 'dsh-to-oc') => ({ id: 'scan-' + direction, direction, input: {}, plan: { target: { version: 'fixture' }, sourceRoot: '/source' }, scannedAt: new Date().toISOString(), errors: [], projects: [], entries: ['ONE','TWO'].map((sourceID,i) => ({ id: 'internal-'+i, sourceID, title: '中文标题'+i, messageCount: 1, projectID: 'p', directory: '/project', updated: i })) });
test('方向控件明确标注目标，运行时锁定；无效存储值回到正向', () => {
  assert.equal(normalizeDirection('oc-to-dsh'), 'oc-to-dsh'); assert.equal(normalizeDirection('invalid'), 'dsh-to-oc');
  const html = directionControlHTML('oc-to-dsh', true);
  assert.match(html, /data-direction="oc-to-dsh" aria-pressed="true" disabled/);
  assert.equal((html.match(/ disabled/g)||[]).length, 2);
  assert.match(catalogHTML(null,newCatalogView(),false,'oc-to-dsh'), /data-direction="oc-to-dsh" aria-pressed="true"/);
});
test('指定源 ID 精确匹配、去重、跨项目；未知/歧义 ID 整体拒绝', () => {
  const c = catalog(); assert.deepEqual(resolveConversationIDs(c, 'ONE， TWO\nONE;TWO'), ['internal-0','internal-1']);
  for (const text of ['', 'ON', 'internal-0', 'ONE UNKNOWN']) assert.throws(() => resolveConversationIDs(c,text));
  c.entries.push({...c.entries[0],id:'duplicate'}); assert.throws(() => resolveConversationIDs(c,'ONE'), /多个原件/);
});
test('单条导入的 payload 只有当前条，方向/扫描/空选择不混入全量', () => {
  const c = catalog(); const otherSelection = new Set(['internal-1']);
  assert.deepEqual(selectionPayload(c,'dsh-to-oc',['internal-0']),{scanID:c.id,ids:['internal-0']}); assert.equal(otherSelection.size,1);
  for (const ids of [[], ['unknown'], ['internal-0','internal-0']]) assert.throws(() => selectionPayload(c,'dsh-to-oc',ids));
  assert.throws(() => selectionPayload(c,'oc-to-dsh',['internal-0']), /方向已变化/);
});
test('切换方向的自定义路径保留，不启用自定义时不夹带旧配置', () => {
  const settings = {customQuick:true,sourceRoot:'/source',dshRoot:'/target',binary:'/oc',directory:'/project',dataHome:'/data'};
  const reverse=quickInputFor(settings,'oc-to-dsh'); assert.equal(reverse.sourceRoot,'/source');assert.equal(reverse.dshRoot,'/target');assert.equal(reverse.dataHome,'/data');
  assert.deepEqual(quickInputFor({...settings,customQuick:false},'oc-to-dsh'),{direction:'oc-to-dsh'});
});
test('预览单条导入按钮目标明确，缺目标或运行中禁用；ID 文本转义', () => {
  const c=catalog('oc-to-dsh'),v=newCatalogView();v.focused='internal-0';v.idsText='<script>bad</script>';
  let html=catalogHTML(c,v);assert.match(html,/data-action="importOne" data-id="internal-0" >仅导入此对话 → DSH/);assert.match(html,/&lt;script&gt;bad/);assert.doesNotMatch(html,/<script>/);
  assert.match(catalogHTML(c,v,true),/data-action="importOne" data-id="internal-0" disabled/);
  c.plan.target=null;assert.match(catalogHTML(c,v),/data-action="importOne" data-id="internal-0" disabled/);
});

test('真实前端事件：方向切换清空旧选择、保留隐藏设置；ID 失败不改勾选，预览导入只发一条', async t => {
  // Execute the actual controller with a minimal DOM and IPC seam, not a duplicate controller.
  const source=await readFile(new URL('../desktop/src/main.ts',import.meta.url),'utf8');
  const handlers={},fields=new Map(),storage=new Map(),calls=[];let snapshot={settings:{customQuick:true,sourceRoot:'/source',dshRoot:'/target',binary:'/oc',dataHome:'/data'},catalog:catalog(),jobs:[],quick:null};let scanFails=false;
  const root={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null,addEventListener:(type,fn)=>handlers[type]=fn};
  const previous=Object.fromEntries(['document','localStorage','__directionHarness'].map(k=>[k,globalThis[k]]));
  globalThis.document={documentElement:{dataset:{}},querySelector:()=>root,getElementById:id=>fields.get(id)||null};
  globalThis.localStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
  globalThis.__directionHarness={
    invoke:async(command,{method,payload})=>{calls.push({method,payload});if(method==='snapshot')return structuredClone(snapshot);if(method==='discoverQuick')return {total:2,target:{version:'fixture'}};if(method==='scanCatalog'){if(scanFails)throw Error('scan failed');snapshot.catalog={...catalog(payload.direction),input:payload};return structuredClone(snapshot.catalog);}if(method==='startSelected'){snapshot.quick={direction:snapshot.catalog.direction,status:'complete',stage:'完成',total:payload.ids.length,finished:payload.ids.length,imported:payload.ids.length,nativeSessions:payload.ids.length,skipped:0,errors:[],target:{version:'fixture'},jobs:[]};return structuredClone(snapshot.quick);}if(method==='catalogPreview')return {id:payload.id,offset:0,total:0,messages:[]};throw Error(method);},
    listen:async()=>{},open:async()=>null,confirm:async()=>true
  };
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  let js=compile(source).replace(/^import .*;$/gm,'').replace(/setInterval\(/g,'void(');
  js=`import {needsGuide,completeGuide,guideHTML,guideStep} from '${guideURL}';import {APP_VERSION,sidebarHTML,pageInfo} from '${navURL}';import {catalogHTML,newCatalogView,filteredEntries,directionControlHTML,normalizeDirection,quickInputFor,resolveConversationIDs,selectionPayload} from '${catalogURL}';const {invoke,listen,open,confirm}=globalThis.__directionHarness;\n`+js+`\nexport const inspect=()=>({direction,catalogView,state,page,probing});`;
  const ui=await import(dataURL(js));await new Promise(resolve=>setImmediate(resolve));
  const click=async(action,data={})=>handlers.click({preventDefault(){},target:{closest:()=>({dataset:{action,...data}})}});
  const input=(id,value)=>handlers.input({target:{id,value,dataset:{}}});
  await click('nav',{page:'catalog'}); ui.inspect().catalogView.selected.add('internal-0');
  await click('direction',{direction:'oc-to-dsh'});assert.equal(ui.inspect().catalogView.selected.size,0);assert.equal(storage.get('migration-direction'),'oc-to-dsh');
  const scan=calls.findLast(c=>c.method==='scanCatalog');assert.equal(scan.payload.sourceRoot,'/source');assert.equal(scan.payload.dshRoot,'/target');assert.equal(scan.payload.dataHome,'/data');
  input('catalogIDs','TWO');await click('catalogApplyIDs');assert.deepEqual([...ui.inspect().catalogView.selected],['internal-1']);
  input('catalogIDs','ONE UNKNOWN');await click('catalogApplyIDs');assert.deepEqual([...ui.inspect().catalogView.selected],['internal-1']);assert.match(ui.inspect().catalogView.idsError,/UNKNOWN/);
  await click('importOne',{id:'internal-0'});assert.deepEqual(calls.findLast(c=>c.method==='startSelected').payload.ids,['internal-0']);
  await click('nav',{page:'catalog'});scanFails=true;await click('direction',{direction:'dsh-to-oc'});
  assert.equal(ui.inspect().catalogView.selected.size,0);assert.match(root.innerHTML,/先把对话找出来/);assert.doesNotMatch(root.innerHTML,/data-action="importOne"/);
  const count=calls.filter(c=>c.method==='startSelected').length;await click('importOne',{id:'internal-0'});assert.equal(calls.filter(c=>c.method==='startSelected').length,count);
  snapshot.quick={...snapshot.quick,status:'running'};await click('refresh');await click('direction',{direction:'oc-to-dsh'});assert.equal(ui.inspect().direction,'dsh-to-oc');
});
