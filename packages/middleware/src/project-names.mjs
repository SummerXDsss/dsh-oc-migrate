import {mkdir,open,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {digest} from '../../core/src/protocol.mjs';
import {atomicJSON} from './store.mjs';
async function locked(state,key,fn){
 const root=path.join(state,'project-names');await mkdir(root,{recursive:true,mode:0o700});const file=path.join(root,key+'.json'),lock=file+'.lock';let handle;
 try{handle=await open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('项目名称正在更新，请稍后重试');throw e;}
 try{return await fn(file);}finally{await handle.close();await unlink(lock);}
}
const currentProject=async(client,id)=>{const p=(await client.listProjects()).find(p=>p.id===id);if(!p)throw Error('原生项目不存在，未标记名称迁移完成');return p;};
export async function claimProjectName(state,client,id,name,owner){
 if(!client.listProjects||!client.updateProjectName)throw Error('目标客户端缺少原生项目名称接口');
 if(id==='global')return {id,name,status:'global-preserved',warning:'该目录属于 OpenCode 全局项目，已保留全局名称；源项目名与原目录保存在迁移原件中'};
 const key=digest({target:client.storageIdentity??client.identity,id});
 return locked(state,key,async file=>{
  let ledger;try{ledger=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const p=await currentProject(client,id),actual=p.name??'';
  if(ledger){if(ledger.name!==name||![ledger.before??'',ledger.name].includes(actual))throw Error(`项目名冲突：目标为「${actual}」，源为「${name}」；已保留目标名称`);}
  else{
   if(actual===name)return {id,name,status:'existing-verified'};
   if(actual && actual!==path.basename(p.canonical??p.worktree??''))throw Error(`项目名冲突：目标为「${actual}」，源为「${name}」；已保留目标名称`);
   ledger={id,name,before:p.name??'',owners:[]};
  }
  if(!ledger.owners.includes(owner))ledger.owners.push(owner);
  // Journal before the native mutation; a retry completes an interrupted claim.
  await atomicJSON(file,ledger);
  if(actual!==name)await client.updateProjectName(id,name);
  if((await currentProject(client,id)).name!==name)throw Error('项目名称原生回读不匹配');
  return {key,id,name,status:'verified'};
 });
}
export async function releaseProjectName(state,client,receipt,owner){
 if(!receipt.key)return;
 return locked(state,receipt.key,async file=>{
  let ledger;try{ledger=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}
  ledger.owners=ledger.owners.filter(id=>id!==owner);
  if(ledger.owners.length){await atomicJSON(file,ledger);return;}
  const actual=(await currentProject(client,ledger.id)).name??'';
  if(actual===ledger.name){await client.updateProjectName(ledger.id,ledger.before);if(((await currentProject(client,ledger.id)).name??'')!==ledger.before)throw Error('项目名称回滚回读不匹配');}
  // A subsequent user rename is preserved, not overwritten by rollback.
  await unlink(file);
 });
}
