// Offline DSH workspace v2 registration. Native GUI owns this file while running.
// Keep source logs immutable; merge only the migrated session's membership on rollback.
import {readFile,writeFile,rename,mkdir,open,unlink,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';import {digest} from '../../core/src/protocol.mjs';import {atomicJSON} from './store.mjs';
const exec=promisify(execFile);
async function atomicBytes(file,data){const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,data,{flag:'wx',mode:0o600});try{await rename(temp,file);}catch(e){await unlink(temp).catch(()=>{});throw e;}}
export async function assertDshOffline(){
 const output=process.platform==='win32' ? (await exec('tasklist',['/FO','CSV','/NH'],{windowsHide:true,timeout:10000})).stdout : (await exec('ps',['-axo','comm='],{timeout:10000})).stdout;
 if(output.split('\n').some(line=>/(?:^|[\\/" ])(?:DSH NEXT|DeepSeek Harness|deepseek-harness|dsh)(?:\.exe)?(?:"|$)/i.test(line.trim())))throw Error('请先退出 DeepSeek Harness，再迁移或回滚项目名称；重新打开后会显示项目与对话');
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
