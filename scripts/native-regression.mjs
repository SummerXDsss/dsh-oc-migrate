import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,stat} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath,pathToFileURL} from 'node:url';
export function nativeTarget(platform=process.platform,arch=process.arch){
 const targets={'linux:x64':'x86_64-unknown-linux-gnu','win32:x64':'x86_64-pc-windows-msvc','darwin:arm64':'aarch64-apple-darwin','darwin:x64':'x86_64-apple-darwin'};
 const target=targets[platform+':'+arch];if(!target)throw Error('未配置原生回归平台：'+platform+'/'+arch);return target;
}
async function main(){
 if(!process.env.npm_execpath)throw Error('请使用 npm run test:native:ci');
 const project=fileURLToPath(new URL('..',import.meta.url));
 const root=await mkdtemp(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'dsh-platform-ci-'));
 const run=(file,args,env=process.env)=>execFileSync(file,args,{cwd:project,env,stdio:'inherit',windowsHide:true,timeout:900000});
 try{
  const paths={};
  for(const [key,pkg]of [['V1','opencode-ai@1.18.31'],['V2','@opencode/cli@2.3.2']]){
   const folder=path.join(root,'工具 空格 '+key);
   run(process.execPath,[process.env.npm_execpath,'install','--prefix',folder,pkg,'--no-audit','--no-fund']);
   const binary=path.join(folder,'node_modules',key==='V1'?'opencode-ai':'@opencode/cli','bin','opencode.exe');
   if(!(await stat(binary)).isFile())throw Error('官方原生 CLI 缺失：'+binary);paths['OPENCODE_'+key+'_BIN']=binary;
  }
  const temp=path.join(root,'项目 中文 空格');await mkdir(temp);
  const target=nativeTarget(),binary=path.join(project,'src-tauri','binaries','migrate-backend-'+target+(process.platform==='win32'?'.exe':''));
  if(!(await stat(binary)).isFile())throw Error('编译 sidecar 缺失：'+binary);
  const files=(await (await import('node:fs/promises')).readdir(path.join(project,'test/integration'))).filter(name=>name.endsWith('.test.mjs')).map(name=>'test/integration/'+name);
  run(process.execPath,['--test',...files],{...process.env,...paths,DSH_NATIVE_APP_ROOT:project,DSH_OC_TEST_SIDECAR:binary,TMPDIR:temp,TEMP:temp,TMP:temp});
 }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)await main();
