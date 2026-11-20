import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import{binaryCandidates,desktopCliRoots,discoverBinaries,resolveCliBinary}from'../packages/opencode-client/src/discovery.mjs';
import{dshHome}from'../packages/core/src/platform-paths.mjs';import{replaceFile,atomicWrite}from'../packages/core/src/atomic-file.mjs';
import {nativeTarget} from '../scripts/native-regression.mjs';
import{hasDshProcess,assertDshOffline}from'../packages/middleware/src/dsh-workspaces.mjs';
const missing=()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});};
test('Windows 发现：2.x resources、旧 GUI、npm 原生包、Scoop 与中文/空格路径',()=>{
 const home='C:\\Users\\张 三',env={LOCALAPPDATA:'D:\\本地 数据',APPDATA:'E:\\漫游',ProgramFiles:'C:\\Program Files'};
 const rows=binaryCandidates(home,{platform:'win32',env});
 for(const suffix of ['D:\\本地 数据\\Programs\\ai.opencode.desktop\\resources\\opencode-cli.exe','C:\\Program Files\\OpenCode\\resources\\opencode-cli.exe','E:\\漫游\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe','E:\\漫游\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe','C:\\Users\\张 三\\scoop\\shims\\opencode.exe'])assert(rows.includes(suffix),suffix);
 assert.equal(desktopCliRoots(home,{platform:'win32',env})[0],'E:\\漫游\\ai.opencode.desktop\\cli');assert.equal(rows.at(-1),'opencode.exe');
 assert.equal(new Set(rows).size,rows.length);assert(!rows.some(x=>x.includes('/Applications')));
});
test('普通 Linux：GUI resources、用户 CLI、系统 CLI 与 XDG_CONFIG_HOME',()=>{
 const rows=binaryCandidates('/home/张 三',{platform:'linux',env:{}});
 for(const file of ['/opt/OpenCode/resources/opencode-cli','/opt/opencode/resources/opencode-cli','/usr/lib/opencode/resources/opencode-cli','/home/张 三/.local/bin/opencode','/usr/bin/opencode'])assert(rows.includes(file));
 assert(!rows.some(x=>x.includes('homebrew')||x.includes('wsl')));
 assert.equal(desktopCliRoots('/home/a',{platform:'linux',env:{XDG_CONFIG_HOME:'/定制 配置'}})[0],'/定制 配置/ai.opencode.desktop/cli');
});
test('2.x staged CLI 优先：只读直接版本目录、数值排序、过滤不匹配架构/不完整副本',async()=>{
 const root='C:\\Users\\张 三\\AppData\\Roaming\\ai.opencode.desktop\\cli';
 const names=['2.3.2-x64','2.10.0-x64','2.20.0-arm64','2.99.0-x64.tmp','2.12.0-x64','junk'];
 const versions=names.map(name=>({name,isDirectory:()=>true}));
 const files=await discoverBinaries('C:\\Users\\张 三',{platform:'win32',arch:'x64',env:{},readDir:async file=>{assert.equal(file,root);return versions;},inspect:async file=>file.includes('2.12.0')?missing():{isFile:()=>true}});
 assert.equal(files[0],root+'\\2.10.0-x64\\opencode-cli.exe');assert.equal(files[1],root+'\\2.3.2-x64\\opencode-cli.exe');assert(!files.some(x=>x.includes('2.20.0')));
});
test('Linux staged CLI 真目录读取；权限不足时保留系统候选',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'dsh-platform-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const opts={platform:'linux',env:{XDG_CONFIG_HOME:path.join(home,'配置 空格')},arch:'x64'},dir=path.join(desktopCliRoots(home,opts)[0],'2.3.2-x64');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'opencode-cli'),'fixture');
 assert.equal((await discoverBinaries(home,opts))[0],path.join(dir,'opencode-cli'));
 const rows=await discoverBinaries(home,{...opts,readDir:async()=>{throw Object.assign(Error(),{code:'EACCES'});}});assert(rows.includes('/usr/bin/opencode'));
});
test('Windows npm shim 解析原生 .exe；参数不交给 shell，不执行无关批处理',async()=>{
 const home='C:\\Users\\张 三 & 测试',root=home+'\\AppData\\Roaming\\npm';const expected=root+'\\node_modules\\@opencode\\cli\\bin\\opencode.exe';
 const opts={platform:'win32',cwd:home,env:{PATH:root},inspect:async file=>file===expected?{isFile:()=>true}:missing()};
 assert.equal(await resolveCliBinary(root+'\\opencode.cmd',opts),expected);assert.equal(await resolveCliBinary('opencode.ps1',opts),expected);
 const local=home+'\\项目\\node_modules',native=local+'\\opencode-ai\\bin\\opencode.exe';
 assert.equal(await resolveCliBinary(local+'\\.bin\\opencode.cmd',{...opts,inspect:async file=>file===native?{isFile:()=>true}:missing()}),native);
 await assert.rejects(resolveCliBinary('unrelated.cmd',opts),/原生可执行/);await assert.rejects(resolveCliBinary('opencode.cmd',{...opts,inspect:async()=>missing()}),/未找到对应原生/);
 assert.equal(await resolveCliBinary('C:\\Open Code\\opencode.exe',opts),'C:\\Open Code\\opencode.exe');
});
test('DSH_HOME 遵循原生覆盖规则，支持 Windows home、UNC 与 Linux tilde',()=>{
 assert.equal(dshHome('C:\\Users\\A',{platform:'win32',env:{}}),'C:\\Users\\A\\.dsh');
 assert.equal(dshHome('C:\\Users\\A',{platform:'win32',cwd:'C:\\work',env:{DSH_HOME:'\\\\server\\共享\\DSH'}}),'\\\\server\\共享\\DSH');
 assert.equal(dshHome('/home/a',{platform:'linux',env:{DSH_HOME:'~/历史 空格'}}),'/home/a/历史 空格');
 assert.equal(dshHome('/home/a',{platform:'linux',env:{DSH_HOME:'  '}}),'/home/a/.dsh');
});
test('Windows 替换文件占用：限次退避，不对普通错误重试，不删除原目标',async()=>{
 let count=0;const waits=[];await replaceFile('temp','target',{platform:'win32',move:async()=>{if(++count<3)throw Object.assign(Error(),{code:'EPERM'});},wait:async ms=>waits.push(ms)});assert.equal(count,3);assert.deepEqual(waits,[20,40]);
 count=0;await assert.rejects(replaceFile('temp','target',{platform:'win32',move:async()=>{count++;throw Object.assign(Error(),{code:'EBUSY'});},wait:async()=>{}}));assert.equal(count,6);
 count=0;await assert.rejects(replaceFile('temp','target',{platform:'linux',move:async()=>{count++;throw Object.assign(Error(),{code:'EPERM'});}}));assert.equal(count,1);
});
test('原子发布真实文件：连续替换可回读，无临时文件残留',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-atomic-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'中文 空格.json');
 await atomicWrite(file,'before');await atomicWrite(file,'after');assert.equal(await readFile(file,'utf8'),'after');assert.deepEqual(await readdir(root),['中文 空格.json']);
});
test('离线检查：Windows CSV、Linux/macOS 可执行名，普通 node 与编辑器不误判',async()=>{
 assert(hasDshProcess('"DSH NEXT.exe","1234","Console"\r\n','win32'));assert(hasDshProcess('/opt/deepseek-harness/dsh-next\n','linux'));assert(hasDshProcess('deepseek-harnes\n','linux'));assert(!hasDshProcess('node\ncode\n','linux'));assert(!hasDshProcess('"node.exe","1234"','win32'));
 let invocation;await assertDshOffline({platform:'linux',execute:async(...args)=>{invocation=args;return{stdout:'node\n'};}});assert.deepEqual(invocation.slice(0,2),['ps',['-A','-o','comm=']]);
 await assert.rejects(assertDshOffline({platform:'win32',execute:async()=>({stdout:'"dsh.exe","12"'})}),/先退出/);
 await assert.rejects(assertDshOffline({platform:'linux',execute:async()=>missing()}),/进程检查失败/);
});

test('原生 CI 平台映射不依赖 bash、WSL 或 .cmd shim',()=>{
 assert.equal(nativeTarget('win32','x64'),'x86_64-pc-windows-msvc');assert.equal(nativeTarget('linux','x64'),'x86_64-unknown-linux-gnu');assert.throws(()=>nativeTarget('linux','mips'));
});
