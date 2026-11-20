import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
const compile = text => transpileModule(text, { compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 } }).outputText;
const dataURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const moduleURL = async name => dataURL(compile(await readFile(new URL('../desktop/src/' + name + '.ts', import.meta.url), 'utf8')));
const guideURL = await moduleURL('onboarding'), navURL = await moduleURL('navigation'), catalogURL = await moduleURL('catalog');
const { GUIDE_KEY, needsGuide, completeGuide, guideStep, guideHTML } = await import(guideURL);
const { APP_VERSION, sidebarHTML, GITHUB_LINKS } = await import(navURL);
const { isFilePermissionError } = await import(catalogURL);
const freshStorage = () => { const map = new Map(); return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; };

test('首次教程只显示一次；完成或跳过后保存；写入失败不阻塞操作', () => {
  const storage = freshStorage(); assert(needsGuide(storage)); assert(completeGuide(storage)); assert.equal(storage.map.get(GUIDE_KEY), 'done'); assert.equal(needsGuide(storage), false);
  assert(needsGuide({getItem(){throw Error('unavailable');}})); assert.equal(completeGuide({setItem(){throw Error('quota');}}), false);
});
test('教程三个步骤有边界，包含明确的扫描/检查/撤销说明，不直接迁移', () => {
  for (const [input, expected] of [[-10,0],[1.9,1],[9,2],[NaN,0]]) assert.equal(guideStep(input),expected);
  for(let step=0;step<3;step++) { const html=guideHTML(step,'dsh-to-oc','choose');assert.match(html,new RegExp(`第 ${step+1} 步，共 3 步`));assert.match(html,/跳过教程/);assert.doesNotMatch(html,/data-action="startQuick"|role="dialog"/); }
  assert.match(guideHTML(1,'dsh-to-oc','choose'),/扫描.*不会开始迁移/);assert.match(guideHTML(2,'dsh-to-oc','choose'),/开始扫描对话/);assert.match(guideHTML(2,'dsh-to-oc','all'),/前往一键迁移/);
});
test('反向教程使用完整工具名，并提示退出 DSH 与保留已使用的对话', () => {
  assert.match(guideHTML(0,'oc-to-dsh','choose'),/请先完全退出/);assert.match(guideHTML(2,'oc-to-dsh','choose'),/再打开 DeepSeek Harness/);assert.match(guideHTML(2,'oc-to-dsh','choose'),/被原工具占用的记录会保留/);
});
test('独立高级导航与 GitHub 快捷入口；侧栏不再渲染旧说明和版本', () => {
  for(const page of ['guide','migrate','catalog','jobs','advanced','plugin']) {
    const html=sidebarHTML(page,'dark',2,()=>'<svg></svg>');assert.match(html,/data-page="advanced"[^>]*>.*高级模式/);assert.match(html,/data-page="guide"/);
    assert.match(html,/href="https:\/\/github.com\/SummerXDsss" data-action="github" data-target="author"/);assert.match(html,/data-target="project"/);assert.match(html,/rel="noopener noreferrer"/);
    assert.doesNotMatch(html,/全程在本机处理|原始记录留存|DESKTOP|Tauri|v0\./);
  }
  assert.equal(GITHUB_LINKS.project,'https://github.com/SummerXDsss/dsh-oc-migrate');assert.match(APP_VERSION,/^\d+\.\d+\.\d+$/);
  assert.match(sidebarHTML('plugin','light',0,()=>''),/data-page="advanced" class="nav-item active"/);
});

let sequence = 0;
async function controller(t, {seen=false,quick=null,scanError=false,partialErrors=[]}={}) {
  const storage=freshStorage();if(seen)completeGuide(storage);
  const handlers={},fields=new Map(),calls=[];
  const root={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null,addEventListener:(type,fn)=>handlers[type]=fn};
  const snapshot={settings:{},jobs:[],catalog:null,quick};
  const previous=Object.fromEntries(['document','localStorage','__onboardingHarness'].map(key=>[key,globalThis[key]]));
  globalThis.document={documentElement:{dataset:{}},querySelector:()=>root,getElementById:id=>fields.get(id)||null};globalThis.localStorage=storage;
  globalThis.__onboardingHarness={
    invoke:async(command,args)=>{calls.push({command,...args});if(command==='open_github')return;
      const{method,payload}=args;if(method==='snapshot')return structuredClone(snapshot);if(method==='discoverQuick')return{total:1,target:{version:'fixture'}};
      if(method==='scanCatalog'){if(scanError)throw Error(typeof scanError === 'string' ? scanError : '请检查对话位置后重新扫描');snapshot.catalog={id:'scan',direction:payload.direction,input:payload,plan:{target:{version:'fixture'},sourceRoot:'/fixture'},projects:[],entries:[],errors:partialErrors,scannedAt:new Date().toISOString()};return structuredClone(snapshot.catalog);}throw Error(method);},
    listen:async()=>{},open:async()=>null,confirm:async()=>true
  };
  t.after(()=>{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  let js=compile(await readFile(new URL('../desktop/src/main.ts',import.meta.url),'utf8')).replace(/^import .*;$/gm,'').replace(/setInterval\(/g,'void(');
  js=`import {needsGuide,completeGuide,guideHTML,guideStep} from '${guideURL}';import {APP_VERSION,sidebarHTML,pageInfo} from '${navURL}';import {PERMISSION_HELP,isFilePermissionError,catalogHTML,newCatalogView,filteredEntries,directionControlHTML,normalizeDirection,quickInputFor,resolveConversationIDs,selectionPayload} from '${catalogURL}';const {invoke,listen,open,confirm}=globalThis.__onboardingHarness;\n`+js+`\nexport const inspect=()=>({page,tutorialStep,tutorialChoice,direction,state}); // ${sequence++}`;
  const ui=await import(dataURL(js));await new Promise(resolve=>setImmediate(resolve));
  const click=async(action,data={})=>handlers.click({preventDefault(){},target:{closest:()=>({dataset:{action,...data}})}});
  return{ui,click,storage,calls,root,fields,handlers};
}
test('首次真实控制器：先显示教程；选方向/点步骤不扫描、不导入',async t=>{
  const h=await controller(t);assert.equal(h.ui.inspect().page,'guide');assert.deepEqual(h.calls.map(c=>c.method),['snapshot']);
  await h.click('direction',{direction:'oc-to-dsh'});await h.click('guideNext');assert.equal(h.ui.inspect().tutorialStep,1);assert.equal(h.ui.inspect().direction,'oc-to-dsh');
  assert(!h.calls.some(c=>['discoverQuick','scanCatalog','startQuick','startSelected'].includes(c.method)));
});
test('选择全部的教程结束仅检测，仍需用户再次点击一键迁移',async t=>{
  const h=await controller(t);await h.click('guideNext');await h.click('guideChoice',{choice:'all'});await h.click('guideNext');await h.click('guideFinish');
  assert.equal(h.ui.inspect().page,'migrate');assert.equal(h.storage.getItem(GUIDE_KEY),'done');assert.equal(h.calls.filter(c=>c.method==='discoverQuick').length,1);assert(!h.calls.some(c=>c.method==='startQuick'));
  assert.doesNotMatch(h.root.innerHTML,/id="(?:binary|sourceRoot|server|port|customQuick)"|高级设置与其他迁移方式/);
});
test('选择挑选的教程结束只扫描；扫描失败也不会变成全量迁移',async t=>{
  const h=await controller(t,{scanError:true});await h.click('guideStep',{step:'2'});await h.click('guideFinish');
  assert.equal(h.ui.inspect().page,'catalog');assert.equal(h.calls.filter(c=>c.method==='scanCatalog').length,1);assert.match(h.root.innerHTML,/请检查对话位置/);assert(!h.calls.some(c=>c.method==='startQuick'||c.method==='startSelected'));
});
test('跳过、重看与高级页面保留草稿；GitHub 交给固定原生入口',async t=>{
  const h=await controller(t);await h.click('guideSkip');assert.equal(h.ui.inspect().page,'migrate');assert.equal(h.storage.getItem(GUIDE_KEY),'done');
  await h.click('nav',{page:'advanced'});assert.match(h.root.innerHTML,/id="binary"/);assert.match(h.root.innerHTML,/id="customQuick"/);
  h.fields.set('binary',{value:'/中文 路径/opencode'});h.handlers.input({target:{id:'binary',value:'/中文 路径/opencode',dataset:{}}});h.fields.clear();
  await h.click('nav',{page:'guide'});assert.equal(h.ui.inspect().tutorialStep,0);assert.equal(h.ui.inspect().state.settings.binary,'/中文 路径/opencode');assert.equal(h.storage.getItem(GUIDE_KEY),'done');
  await h.click('github',{target:'author'});assert.equal(h.calls.at(-1).command,'open_github');assert.equal(h.calls.at(-1).target,'author');assert.equal(h.ui.inspect().page,'guide');
});
test('返回用户直接到工作台；已有进行中的迁移优先展示，不被首次教程遮挡',async t=>{
  const h=await controller(t,{quick:{status:'running',stage:'正在迁移',total:1,finished:0,imported:0,nativeSessions:0,skipped:0,errors:[],target:{version:'fixture'},jobs:[]}});
  assert.equal(h.ui.inspect().page,'migrate');assert.match(h.root.innerHTML,/停止迁移/);assert(!h.calls.some(c=>c.method==='discoverQuick'));
});
test('完成过教程的启动不再自动显示，仍保留使用教程入口',async t=>{
  const h=await controller(t,{seen:true});assert.equal(h.ui.inspect().page,'migrate');assert.match(h.root.innerHTML,/使用教程/);assert(!h.calls.some(c=>c.method==='scanCatalog'));
});

test('扫描被系统拒绝时，明确提示可能出现弹窗和必要的文件读取权限', async t => {
  const h=await controller(t,{scanError:'EACCES: permission denied, scandir /fixture/sessions'});
  await h.click('guideStep',{step:'2'});await h.click('guideFinish');
  assert.match(h.root.innerHTML,/还需要文件读取权限/);assert.match(h.root.innerHTML,/可能会出现权限弹窗/);assert.match(h.root.innerHTML,/必要的文件读取权限/);assert.match(h.root.innerHTML,/再重新扫描/);
  assert(!h.calls.some(c=>c.method==='startQuick'||c.method==='startSelected'));
});
test('部分文件读取失败也提示权限；普通位置错误不误报权限', async t => {
  const h=await controller(t,{partialErrors:[{file:'/fixture/one.jsonl',error:'EPERM: operation not permitted'}]});
  await h.click('guideFinish');assert.match(h.root.innerHTML,/还需要文件读取权限/);
});
test('无权限错误不显示授权提示，教程提前说明系统可能询问', async t => {
  const h=await controller(t,{scanError:true});await h.click('guideFinish');assert.doesNotMatch(h.root.innerHTML,/还需要文件读取权限/);
  assert.match(guideHTML(1,'dsh-to-oc','choose'),/可能会出现权限弹窗.*必要的文件读取权限/);
});

test('识别各系统权限错误，不把未找到路径或普通连接错误当成授权问题', () => {
  for(const error of ['EACCES: scandir /fixture','EPERM: open /fixture','Permission denied','Operation not permitted','Access is denied','拒绝访问','没有读取权限','文件权限不足',new Error('EACCES'),{code:'EPERM',message:'scandir'}]) assert.equal(isFilePermissionError(error),true,String(error));
  for(const error of ['ENOENT: no such file','ECONNREFUSED','需要检查安装位置',null,undefined]) assert.equal(isFilePermissionError(error),false,String(error));
});
