import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicJSON } from '../../middleware/src/store.mjs';
import { digest } from '../../core/src/protocol.mjs';
import { findLocalSessions, captureLocalSession } from '../../plugin/src/local-reader.mjs';

const directionOf = input => input.direction === 'oc-to-dsh' ? 'oc-to-dsh' : 'dsh-to-oc';
const settingsOf = input => Object.fromEntries(['direction', 'sourceRoot', 'dshRoot', 'binary', 'directory', 'dataHome'].filter(key => typeof input[key] === 'string').map(key => [key, input[key]]));
const titleOf = (value, fallback) => typeof value === 'string' && value.trim() ? value : fallback;
function dshMessages(session) {
  return session.events.filter(e => /^(user|assistant|system)\/message$/.test(e.type) || e.type === 'tool/result').map(e => {
    const message = e.type === 'user/message' ? e.data : e.data.message;
    return { role: message.role, text: (message.content ?? []).map(block => block.type === 'text' ? block.text : block.type === 'reasoning' ? `[思考]\n${block.text}` : `[${block.type}]\n${JSON.stringify(block, null, 2)}`).join('\n'), active: session.surfaceEventSeqs.includes(e.seq), seq: e.seq };
  });
}
function ocMessages(transcript) {
  return transcript.messages.map(record => {
    const info = record.info ?? record, parts = record.parts ?? record.content;
    return { role: info.role ?? info.type, text: Array.isArray(parts) ? parts.map(part => part.type === 'text' ? part.text : part.type === 'reasoning' ? `[思考]\n${part.text}` : `[${part.type}]\n${JSON.stringify(part, null, 2)}`).join('\n') : record.text ?? '', active: true };
  });
}
export class ConversationCatalog {
  constructor({ root, quick, emit = () => {} }) { Object.assign(this, { root, quick, emit }); this.current = null; this.metadata = { entries: {}, projects: {} }; }
  async init() {
    for (const [file, key] of [['catalog-latest.json', 'current'], ['catalog-metadata.json', 'metadata']]) {
      try { this[key] = JSON.parse(await readFile(path.join(this.root, file), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  snapshot() {
    if (!this.current) return null;
    return { ...this.current, entries: this.current.entries.map(e => ({ ...e, ...this.metadata.entries[e.id] })), projects: this.current.projects.map(p => ({ ...p, ...this.metadata.projects[p.id] })) };
  }
  async scan(input = {}) {
    const direction = directionOf(input), config = settingsOf({ ...input, direction });
    for (const key of ['sourceRoot', 'dshRoot', 'directory', 'dataHome']) if (config[key] && !path.isAbsolute(config[key])) throw new Error(`${key} 需要绝对路径`);
    const plan = await this.quick.discover(config), entries = [], errors = [...plan.errors];
    const sources = direction === 'oc-to-dsh' ? plan.sessions ?? [] : (await findLocalSessions(plan.sourceRoot)).files;
    const origin = digest({ direction, source: direction === 'oc-to-dsh' ? [plan.target?.binary, config.dataHome ?? ''] : plan.sourceRoot });
    let finished = 0;
    const progress = () => this.emit({ type: 'catalog-progress', finished, total: sources.length });
    progress();
    let client;
    if (direction === 'oc-to-dsh' && plan.target) client = await this.quick.makeClient({ ...plan.target, directory: this.quick.home, dataHome: config.dataHome || '' });
    for (const item of sources) {
      try {
        let entry;
        if (direction === 'dsh-to-oc') {
          const captured = await captureLocalSession(item), s = captured.session;
          const messages = s.events.filter(e => /^(user|assistant|system)\/message$/.test(e.type) || e.type === 'tool/result');
          entry = { sourceID: s.header.id, title: titleOf(s.title, s.header.id), directory: s.header.cwd ?? '', created: s.header.createdAt,
            updated: s.events.reduce((n, e) => Math.max(n, e.time), s.header.createdAt), messageCount: messages.length,
            activeCount: s.surfaceEventSeqs.length, eventCount: s.events.length, parentID: s.header.parentSession ?? null,
            fingerprint: captured.hash, source: item };
        } else {
          const transcript = await client.export(item.id);
          if (!transcript) throw new Error('扫描期间对话已删除，请重新扫描');
          entry = { sourceID: item.id, title: titleOf(transcript.info.title, item.id), directory: transcript.info.location?.directory ?? transcript.info.directory ?? '',
            created: transcript.info.time?.created ?? 0, updated: transcript.info.time?.updated ?? 0, messageCount: transcript.messages.length,
            parentID: transcript.info.parentID ?? null, archived: !!transcript.info.time?.archived, fingerprint: digest(transcript), source: { id: item.id } };
        }
        entries.push({ ...entry, id: digest({ origin, source: direction === 'dsh-to-oc' ? item.file : item.id }), projectID: digest({ direction, directory: entry.directory }) });
      } catch (error) { errors.push({ file: item.file ?? item.id, error: error.message }); }
      finished++; progress();
    }
    const projects = new Map();
    for (const entry of entries) {
      if (!projects.has(entry.projectID)) projects.set(entry.projectID, { id: entry.projectID, directory: entry.directory, name: entry.directory ? path.basename(entry.directory) || entry.directory : '未关联项目', count: 0 });
      projects.get(entry.projectID).count++;
    }
    const { sessions: _, ...summary } = plan;
    const catalog = { id: randomUUID(), direction, input: config, plan: summary, scannedAt: new Date().toISOString(), entries, projects: [...projects.values()], errors };
    // Publish the new manifest only once fully captured; no target import occurs.
    await atomicJSON(path.join(this.root, 'catalog-latest.json'), catalog);
    this.current = catalog;
    return this.snapshot();
  }
  requireScan(scanID) { if (!this.current || scanID !== this.current.id) throw new Error('扫描结果已更新，请重新选择对话'); return this.current; }
  async preview({ scanID, id, offset = 0, limit = 20 }) {
    const catalog = this.requireScan(scanID), entry = catalog.entries.find(e => e.id === id);
    if (!entry) throw new Error('扫描结果中没有此对话');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('预览分页参数无效');
    let messages;
    if (catalog.direction === 'dsh-to-oc') {
      const capture = await captureLocalSession(entry.source);
      if (capture.hash !== entry.fingerprint) throw new Error('对话已变化，请重新扫描后预览或迁移');
      messages = dshMessages(capture.session);
    } else {
      const client = await this.quick.makeClient({ ...catalog.plan.target, directory: this.quick.home, dataHome: catalog.input.dataHome || '' });
      const transcript = await client.export(entry.sourceID);
      if (!transcript || digest(transcript) !== entry.fingerprint) throw new Error('对话已变化，请重新扫描后预览或迁移');
      messages = ocMessages(transcript);
    }
    return { id, offset, total: messages.length, messages: messages.slice(offset, offset + limit).map(message => ({ ...message, text: String(message.text).slice(0, 12000), truncated: String(message.text).length > 12000 })) };
  }
  async update({ scanID, kind, id, patch }) {
    const catalog = this.requireScan(scanID);
    if (!['entry', 'project'].includes(kind) || !(kind === 'entry' ? catalog.entries : catalog.projects).some(item => item.id === id)) throw new Error('项目或对话不存在');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['alias', 'starred'].includes(key)) || 'alias' in patch && (typeof patch.alias !== 'string' || patch.alias.trim().length > 120) || 'starred' in patch && typeof patch.starred !== 'boolean') throw new Error('本地管理信息格式无效（名称最多 120 字）');
    const key = kind === 'entry' ? 'entries' : 'projects';
    const metadata = structuredClone(this.metadata);
    metadata[key][id] = { ...metadata[key][id], ...patch, ...('alias' in patch ? { alias: patch.alias.trim() } : {}) };
    await atomicJSON(path.join(this.root, 'catalog-metadata.json'), metadata);
    this.metadata = metadata;
    return this.snapshot();
  }
  async startSelected({ scanID, ids }) {
    const catalog = this.requireScan(scanID);
    if (!Array.isArray(ids) || !ids.length || ids.length > catalog.entries.length || new Set(ids).size !== ids.length) throw new Error('请至少选择一个对话，且不要重复选择');
    const selected = ids.map(id => catalog.entries.find(e => e.id === id));
    if (selected.some(entry => !entry)) throw new Error('选择包含未知对话，请重新扫描');
    if (!catalog.plan.target) throw new Error('尚未找到 OpenCode，请先在迁移工作台检测');
    const client = await this.quick.makeClient({ ...catalog.plan.target, directory: this.quick.home, dataHome: catalog.input.dataHome || '' });
    if (client.generation !== catalog.plan.target.generation || client.version !== catalog.plan.target.version) throw new Error('OpenCode 版本已变化，请重新扫描');
    this.requireScan(scanID);
    const plan = { ...catalog.plan, direction: catalog.direction, total: selected.length, errors: [], scanID,
      ...(catalog.direction === 'oc-to-dsh' ? { sessions: selected.map(e => ({ id: e.sourceID, expectedHash: e.fingerprint })) } : { files: selected.map(e => ({ ...e.source, expectedHash: e.fingerprint })) }) };
    return this.quick.start(catalog.input, plan);
  }
}
