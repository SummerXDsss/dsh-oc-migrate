// Explicit OpenCode generation adapters. Only native structured records are
// handled here; non-equivalent parts retain a readable snapshot + source copy.
const text = value => ({ type: 'text', text: value });
const snapshot = part => text(`[OpenCode ${part.type ?? '扩展'} 原始结构]\n${JSON.stringify(part, null, 2)}`);
const asV2Error = error => error && ({ type: error.name ?? 'opencode-historical', message: error.data?.message ?? JSON.stringify(error), ...(error.data?.statusCode ? { status: error.data.statusCode } : {}) });
const asV1Error = error => error && ({ name: 'APIError', data: { message: error.message ?? JSON.stringify(error), isRetryable: false, ...(error.status ? { statusCode: error.status } : {}) } });
const dataFile = part => {
  const match = typeof part.url === 'string' && part.url.match(/^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/);
  return match && match[2].length % 4 === 0 ? { data: match[2], mime: part.mime || match[1] || 'application/octet-stream', source: { type: 'inline' }, ...(part.filename ? { name: part.filename } : {}) } : null;
};
export function transcodeNativeRecord(record, from, to, { directory, parentID, warnings }) {
  if (from === to) return structuredClone(record);
  const info = record.info ?? record, role = record.info?.role ?? record.type;
  if (!['user', 'assistant'].includes(role)) return null;
  const time = structuredClone(info.time), marker = { opencodeHistorical: { generation: from, record } };
  const annotate = part => { warnings.push(`${info.id}: ${part.type ?? '扩展'} 在 ${to} 没有等价字段，保留原始结构快照`); return snapshot(part); };
  if (to === 'v2') {
    if (role === 'user') {
      const texts = [], files = [], agents = [];
      for (const part of record.parts) {
        if (part.type === 'text') texts.push(part.text);
        else if (part.type === 'file' && dataFile(part)) files.push(dataFile(part));
        else if (part.type === 'agent') agents.push({ name: part.name });
        else texts.push(annotate(part).text);
      }
      return { id: info.id, type: role, time, text: texts.join('\n'), ...(files.length ? { files } : {}), ...(agents.length ? { agents } : {}), metadata: marker };
    }
    return { id: info.id, type: role, agent: info.agent ?? 'build', model: { providerID: info.providerID, id: info.modelID }, time, finish: info.finish, cost: info.cost, tokens: info.tokens,
      ...(info.error ? { error: asV2Error(info.error) } : {}), metadata: marker,
      content: record.parts.map(part => {
        if (['text','reasoning'].includes(part.type)) return { type: part.type, text: part.text, ...(part.type === 'reasoning' ? { time: { created: part.time?.start ?? time.created, completed: part.time?.end ?? time.completed ?? time.created } } : {}) };
        if (part.type !== 'tool') return annotate(part);
        const state = part.state, content = [text(state.output ?? state.error ?? ''), ...(state.attachments ?? []).map(file => ({type:'file',uri:file.url,mime:file.mime,...(file.filename?{name:file.filename}:{})}))];
        const base = { input: state.input, content, ...(state.metadata ? { metadata: state.metadata } : {}) };
        return { type:'tool', id:part.callID, name:part.tool, executed:true, time:{created:state.time?.start ?? time.created,completed:state.time?.end ?? time.completed ?? time.created}, state:state.status==='error' ? {...base,status:'error',error:{type:'opencode-historical',message:state.error}} : {...base,status:'completed'} };
      }) };
  }
  const base = { id: info.id, sessionID: '', role, time, agent: info.agent ?? 'build' };
  if (role === 'user') {
    const parts = [text(record.text)];
    for (const file of record.files ?? []) {
      if (typeof file.data === 'string') parts.push({ type:'file', mime:file.mime, url:`data:${file.mime};base64,${file.data}`, ...(file.name ? {filename:file.name} : {}) });
      else parts.push(annotate({type:'file',...file}));
    }
    for (const agent of record.agents ?? []) parts.push({type:'agent',name:agent.name});
    for (const skill of record.skills ?? []) parts.push(annotate({type:'skill',...skill}));
    parts[0].metadata = marker;
    return {info:{...base,model:{providerID:'opencode',modelID:'historical'}},parts};
  }
  return { info:{...base,parentID,mode:info.agent ?? 'build',modelID:info.model.id,providerID:info.model.providerID,path:{cwd:directory,root:directory},cost:info.cost ?? 0,tokens:info.tokens ?? {input:0,output:0,reasoning:0,cache:{read:0,write:0}},...(info.finish ? {finish:info.finish} : {}),...(info.error?{error:asV1Error(info.error)}:{})},
    parts:record.content.map(part=>{
      if(['text','reasoning'].includes(part.type)) return {type:part.type,text:part.text,...(part.type==='reasoning'?{time:{start:part.time?.created ?? time.created,end:part.time?.completed ?? time.completed ?? time.created}}:{}),metadata:marker};
      if(part.type!=='tool') return annotate(part);
      const state=part.state, files=(state.content ?? []).filter(c=>c.type==='file'), texts=(state.content ?? []).filter(c=>c.type==='text');
      if(texts.length>1) warnings.push(`${info.id}: 多段工具文字合并为 1.x output，分块原件保留`);
      const output=texts.map(c=>c.text).join('\n');
      const shared={input:state.input,metadata:{...state.metadata,...marker},time:{start:part.time.created,end:part.time.completed ?? time.completed ?? time.created}};
      // 1.x error state has no attachments slot; keep those in the error snapshot.
      if(state.status==='error') return {type:'tool',callID:part.id,tool:part.name,state:{...shared,status:'error',error:[state.error.message,output,...files.map(f=>JSON.stringify(f))].filter(Boolean).join('\n')}};
      return {type:'tool',callID:part.id,tool:part.name,state:{...shared,status:'completed',output,title:part.name,...(files.length?{attachments:files.map(f=>({type:'file',url:f.uri,mime:f.mime,...(f.name?{filename:f.name}:{})}))}:{})}};
    }) };
}
