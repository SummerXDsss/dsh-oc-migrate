// Offline DSH workspace v2 registration. Native GUI owns this file while running.
// Keep source logs immutable; merge only the migrated session's membership on rollback.
import {readFile,writeFile,mkdir,open,unlink,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {atomicWrite} from '../../core/src/atomic-file.mjs';
import path from 'node:path';import {digest} from '../../core/src/protocol.mjs';import {atomicJSON} from './store.mjs';
const exec=promisify(execFile);
const atomicBytes = atomicWrite;
export function hasDshProcess(output, platform = process.platform) {
 const names=new Set(['dsh','dsh next','deepseek harness','deepseek-harness','deepseek-harnes','deepseekharness','dsh-next','dsh-desktop','dsh next helper']);
 return output.split(/\r?\n/).some(line=>{
  const value=platform==='win32' ? line.match(/^"((?:[^"]|"")*)"/)?.[1]?.replace(/""/g,'"') : line.trim();
  if(!value)return false;
  const name=value.split(/[\\/]/).at(-1).replace(/\.exe$/i,'').toLowerCase();return names.has(name);
 });
}
export async function assertDshOffline({platform=process.platform,execute=exec}={}){
 let output;
 try { output=(await execute(platform==='win32'?'tasklist':'ps',platform==='win32'?['/FO','CSV','/NH']:['-A','-o','comm='],{windowsHide:true,timeout:10000})).stdout; }
 catch(error){throw new Error('系统进程检查失败，尚未写入 DSH 项目；Linux 请确认已安装 procps，Windows 请确认 tasklist 可运行。',{cause:error});}
 if(hasDshProcess(output,platform))throw Error('请先退出 DeepSeek Harness，再迁移或回滚项目名称；重新打开后会显示项目与对话');
}
async function bytes(file){try{return await readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function decode(data){
 if(!data)return {unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:[],archivedSessionIds:[],pinnedSessionIds:[]},tables:{workspaces:{}}};
 const value=JSON.parse(data.toString('utf8'));
 if(value.unit?.name!=='workspace'||value.unit.version!==2||!value.global||!Array.isArray(value.global.workspaceIds)||!value.tables?.workspaces||value.global.pendingMutation)throw Error('DSH 工作区注册表格式异常或有未完成操作，已保留原文件');
 return value;
}
async function locked(root,fn){await mkdir(path.dirname(root),{recursive:true,mode:0o700});const lock=root+'.oc-migrate.lock';let h;try{h=await open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('DSH 工作区正在迁移，请稍后重试');throw e;}try{return await fn();}finally{await h.close();await unlink(lock);}}
export async function registerDshWorkspace(dir,report,project){
 if(!project)return;
 await assertDshOffline();
 let directory;try{directory=await realpath(project.directory);}catch(e){if(e.code==='ENOENT')return {status:'unregistered-missing-directory',warning:'原项目目录不存在，已保留项目名和 cwd；DSH 历史暂列未分组'};throw e;}
 const file=path.join(path.dirname(report.destination),'storages/workspace.json');
 return locked(file,async()=>{
  const before=await bytes(file),data=decode(before);
  // DSH's native registry validates exact canonical cwd equality on attachment.
  let entry=Object.entries(data.tables.workspaces).find(([,w])=>w.path===directory);
  const id=entry?.[0]??'ocm-workspace-'+digest(directory).slice(0,32),now=new Date().toISOString();
  if(entry && entry[1].title!==project.name)throw Error(`DSH 项目名冲突：目标为「${entry[1].title}」，源为「${project.name}」；已保留目标名称`);
  if(!entry){data.tables.workspaces[id]={path:directory,title:project.name,sessionIds:[],createdAt:now,updatedAt:now};data.global.workspaceIds.push(id);}
  const record=data.tables.workspaces[id],sessionID=report.sessions[0].sessionID;
  if(record.sessionIds.includes(sessionID))return {file,id,sessionID,name:project.name,directory,owned:false};
  record.sessionIds.push(sessionID);record.updatedAt=now;
  const after=Buffer.from(JSON.stringify(data,null,2)+'\n');
  // Persist rollback intent before publication. The original bytes remain local.
  const receipt={file,id,sessionID,name:project.name,directory,owned:true,created:!entry,beforeHash:before?digest(before):null,afterHash:digest(after)};
  const old=path.join(dir,'workspace-before.json');if(before)await atomicBytes(old,before);else await unlink(old).catch(e=>{if(e.code!=='ENOENT')throw e;});
  await atomicJSON(path.join(dir,'workspace-receipt.json'),receipt);
  await assertDshOffline();if(digest(await bytes(file))!==digest(before))throw Error('DSH 工作区在导入时变化，已保留现有文件，请重试');
  await atomicJSON(file,data);return receipt;
 });
}
export async function rollbackDshWorkspace(dir,report){
 const raw=await bytes(path.join(dir,'workspace-receipt.json'));if(!raw)return;
 const r=JSON.parse(raw);if(!r.owned)return;
 const expected=path.join(path.dirname(report.destination),'storages/workspace.json');if(r.file!==expected||r.sessionID!==report.sessions[0].sessionID)throw Error('DSH 工作区回滚目标不匹配');
 await assertDshOffline();
 await locked(r.file,async()=>{
  const current=await bytes(r.file);if(!current)return;
  if(digest(current)===r.afterHash){
   if(r.beforeHash===null){await assertDshOffline();if(digest(await bytes(r.file))!==r.afterHash)throw Error('DSH 工作区在回滚时变化');await unlink(r.file);return;}
   const original=await bytes(path.join(dir,'workspace-before.json'));if(!original||digest(original)!==r.beforeHash)throw Error('DSH 工作区原件校验失败');
   decode(original);await assertDshOffline();if(digest(await bytes(r.file))!==r.afterHash)throw Error('DSH 工作区在回滚时变化');await atomicBytes(r.file,original);return;
  }
  const data=decode(current),record=data.tables.workspaces[r.id];if(!record)return;
  record.sessionIds=record.sessionIds.filter(id=>id!==r.sessionID);
  if(r.id==='ocm-workspace-'+digest(r.directory).slice(0,32)&&!record.sessionIds.length&&record.path===r.directory&&record.title===r.name){
   delete data.tables.workspaces[r.id];data.global.workspaceIds=data.global.workspaceIds.filter(id=>id!==r.id);
   if(data.global.defaultWorkspaceId===r.id)delete data.global.defaultWorkspaceId;
  }
  data.global.archivedSessionIds=(data.global.archivedSessionIds??[]).filter(id=>id!==r.sessionID);data.global.pinnedSessionIds=(data.global.pinnedSessionIds??[]).filter(id=>id!==r.sessionID);
  await assertDshOffline();if(digest(await bytes(r.file))!==digest(current))throw Error('DSH 工作区在回滚时变化，已保留现有文件');await atomicJSON(r.file,data);
 });
}

// DSH's cold sidebar performs zero-I/O title reads from this derived v7 record.
// A durable session/title event alone only becomes visible after opening a session.
// Seed the title row, not execution/model/tool projections. Existing native records
// are never replaced; the Session log remains authoritative on every cold replay.
export async function registerDshTitleCache(dir,report,session){
 await assertDshOffline();
 const id=report.sessions[0].sessionID,file=path.join(path.dirname(report.destination),'storages/session_projcache/sessions',id+'.json');
 const identity={formatVersion:4,createdAt:session.header.createdAt,...(session.header.cwd?{cwd:session.header.cwd}:{}),isSeeded:false,inheritedEventCount:0};
 const value={version:7,record:{identity,rows:{title:{ver:1,seq:session.events.at(-1)?.seq??-1,val:session.title}}}};
 const before=await bytes(file);
 if(before){const current=JSON.parse(before);if(current.version!==7||digest(current.record?.identity)!==digest(identity)||current.record?.rows?.title?.val!==session.title)throw Error('DSH 标题缓存已存在且内容不同，已保留现有文件');return {file,status:'existing-verified'};}
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const content=Buffer.from(JSON.stringify(value,null,2)+'\n'),receipt={file,hash:digest(content),owned:true};
 await atomicJSON(path.join(dir,'title-cache-receipt.json'),receipt);
 const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,content,{flag:'wx',mode:0o600});
 try{await assertDshOffline();await (await import('node:fs/promises')).link(temp,file);}finally{await unlink(temp);}
 return {...receipt,status:'verified'};
}
export async function rollbackDshTitleCache(dir,report){
 const raw=await bytes(path.join(dir,'title-cache-receipt.json'));if(!raw)return;const receipt=JSON.parse(raw);
 const expected=path.join(path.dirname(report.destination),'storages/session_projcache/sessions',report.sessions[0].sessionID+'.json');
 if(receipt.file!==expected)throw Error('DSH 标题缓存回滚目标不匹配');
 await assertDshOffline();const current=await bytes(expected);
 if(receipt.owned&&current&&digest(current)===receipt.hash)await unlink(expected);
}
