import { convertBundle } from '../packages/core/src/convert.mjs';
import { fixture } from './fixture.mjs';
export const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7YQAAAAASUVORK5CYII=';
export function formatTranscript(generation,directory) {
  const out=convertBundle(fixture(),{directory,generation,stateSnapshots:false})[0].transcript;
  out.info.title='格式验收 · 中文/换行/工具与附件';
  out.messages=out.messages.slice(1);
  for(const record of out.messages){delete record.metadata;for(const part of record.parts??[]){delete part.metadata;if(part.state)delete part.state.metadata;}}
  const [user,assistant]=out.messages,info=assistant.info??assistant;
  info.finish='length';info.cost=0.012;info.time.completed+=100;
  info.tokens={input:123,output:45,reasoning:6,cache:{read:7,write:8}};
  if(generation==='v1'){
    user.parts[0].text='  原始空格\n\n```ts\nconst 中文 = "保留";\n```\n';
    user.parts.push({id:'prt_image',messageID:user.info.id,sessionID:out.info.id,type:'file',mime:'image/png',filename:'示意.png',url:`data:image/png;base64,${IMAGE}`});
    assistant.parts=assistant.parts.filter(p=>p.type!=='text'||!p.text.startsWith('[DSH 历史工具快照'));
    const tool=assistant.parts.find(p=>p.type==='tool');tool.state.output='';tool.state.metadata={source:'native-fixture',diff:'第一行\n第二行'};
    assistant.parts.push({...structuredClone(tool),id:'prt_error',callID:'call-error',tool:'historical_error',state:{status:'error',input:{file:'不存在.txt'},error:'原始错误\n第二行',time:{start:info.time.created,end:info.time.completed}}});
  }else{
    user.text='  原始空格\n\n```ts\nconst 中文 = "保留";\n```\n';
    user.files=[{data:IMAGE,mime:'image/png',name:'示意.png',source:{type:'inline'}}];user.agents=[{name:'plan'}];user.skills=[{id:'format-skill',name:'format-skill',text:'历史引用'}];
    assistant.content=assistant.content.filter(p=>p.type!=='text'||!p.text.startsWith('[DSH 历史工具快照'));
    const tool=assistant.content.find(p=>p.type==='tool');tool.state.content=[{type:'text',text:''},{type:'text',text:'第二段\n'},{type:'file',uri:'data:text/plain;base64,5bel5YW35paH5Lu2',mime:'text/plain',name:'工具文件.txt'}];tool.state.metadata={source:'native-fixture',diff:'第一行\n第二行'};
    assistant.content.push({...structuredClone(tool),id:'call-error',name:'historical_error',state:{status:'error',input:{file:'不存在.txt'},error:{type:'file-missing',message:'原始错误\n第二行'},content:[{type:'text',text:'已记录的失败结果'}]}});
  }
  return out;
}
