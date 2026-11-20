import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dshHome } from '../../core/src/platform-paths.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { findLocalSessions, captureLocalSession } from '../../plugin/src/local-reader.mjs';
import { FORMAT, digest } from '../../core/src/protocol.mjs';
import { ReverseStore, detectDshEncoding } from '../../middleware/src/reverse.mjs';
import { atomicJSON } from '../../middleware/src/store.mjs';
import { readDshWorkspaces, workspaceFor, canonicalDirectory } from './source-labels.mjs';

import { binaryCandidates, discoverBinaries } from '../../opencode-client/src/discovery.mjs';
export { binaryCandidates };

export class QuickMigration {
  constructor({ root, home, makeClient, store, emit, candidates }) {
    Object.assign(this, { root, home, makeClient, store, emit });
    this.candidates = candidates;
    this.current = null; this.active = false; this.cancelled = false;
  }
  async init() {
    try { this.current = JSON.parse(await readFile(path.join(this.root, 'quick-latest.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.current?.status === 'running') {
      this.current.status = 'interrupted'; this.current.stage = '上次迁移已中断，可重新一键迁移；已完成会话会自动核对去重';
      await this.save();
    }
    return this;
  }
  async discover(input = {}) {
    if (input.direction === 'oc-to-dsh') return this.discoverReverse(input);
    const sourceRoot = input.sourceRoot || path.join(dshHome(this.home), 'sessions');
    const scan = await findLocalSessions(sourceRoot);
    const binaries = input.binary ? [input.binary] : (this.candidates ?? await discoverBinaries(this.home));
    // Prefer the installed GUI's own CLI over another generation in PATH.
    const found = await Promise.all(binaries.map(async binary => {
      try {
        const client = await this.makeClient({ binary, directory: this.home, dataHome: input.dataHome || '', timeout: process.platform === 'win32' ? 30000 : 7000 });
        return { binary, version: client.version, generation: client.generation };
      } catch { return null; }
    }));
    const target = found.find(Boolean) || null;
    return { sourceRoot, total: scan.files.length, errors: scan.errors, target,
      directory: input.directory || path.join(this.home, 'OpenCode/DSH 历史'), preserveProjects: !input.directory };
  }
  async discoverReverse(input) {
    const dshRoot = input.dshRoot || path.join(dshHome(this.home), 'sessions');
    if (!path.isAbsolute(dshRoot)) throw new Error('DSH sessions 需要绝对路径');
    let target = null;
    for (const binary of input.binary ? [input.binary] : (this.candidates ?? await discoverBinaries(this.home))) {
      try { const client = await this.makeClient({ binary, directory: this.home, dataHome: input.dataHome || '', timeout: process.platform === 'win32' ? 30000 : 7000 });
        target = { binary, version: client.version, generation: client.generation }; break;
      } catch { /* Next installed binary. */ }
    }
    if (!target) return { total: 0, target, sourceRoot: '', directory: dshRoot, errors: [] };
    const client = await this.makeClient({ ...target, directory: this.home, dataHome: input.dataHome || '' });
    const sessions = await client.listAll();
    await detectDshEncoding(dshRoot);
    return { direction: 'oc-to-dsh', total: sessions.length, sessions, target, sourceRoot: target.binary, directory: dshRoot, preserveProjects: true, errors: [] };
  }
  async startReverse(input, prepared) {
    if (this.active) throw new Error('一键迁移正在进行');
    for (const key of ['dshRoot', 'dataHome']) if (input[key] && !path.isAbsolute(input[key])) throw new Error(`${key} 需要绝对路径`);
    const plan = prepared ?? await this.discoverReverse(input);
    if (!plan.target) throw new Error('未找到可用的 OpenCode');
    if (!plan.total) throw new Error('OpenCode 中尚未找到对话');
    const id = randomUUID();
    await mkdir(path.join(this.root, 'quick-runs', id, 'sources'), { recursive: true, mode: 0o700 });
    this.active = true; this.cancelled = false;
    this.current = { id, direction: 'oc-to-dsh', status: 'running', stage: '正在读取 OpenCode 全部项目的历史', total: plan.total,
      finished: 0, imported: 0, nativeSessions: 0, skipped: 0, sourceRoot: plan.sourceRoot, target: plan.target, directory: plan.directory,
      createdAt: new Date().toISOString(), ...(plan.scanID ? { scanID: plan.scanID, selected: true } : {}), jobs: [], errors: [] };
    try { await this.save(); } catch (error) { this.active = false; throw error; }
    this.done = this.executeReverse(plan, input).catch(async error => {
      this.current.status = 'failed'; this.current.errors.push({ error: error.message }); await this.save();
    }).finally(() => { this.active = false; });
    return this.current;
  }
  async executeReverse(plan, input) {
    const client = await this.makeClient({ ...plan.target, directory: this.home, dataHome: input.dataHome || '' });
    const store = new ReverseStore({ state: path.join(this.root, 'jobs'), dshRoot: plan.directory });
    for (const [index, item] of plan.sessions.entries()) {
      if (this.cancelled) break;
      this.current.stage = `正在导出并核对第 ${index + 1} / ${plan.total} 个 OpenCode 对话`; await this.save();
      try {
        const source = await client.export(item.id);
        if (!source) throw new Error('会话在导出前已删除，请重新扫描');
        const hash = digest(source);
        if (item.expectedHash && item.expectedHash !== hash) throw new Error('对话自扫描后已变化，请重新扫描再迁移');
        await atomicJSON(path.join(this.root, 'quick-runs', this.current.id, 'sources', `${index}.json`), source);
        const after = await client.export(item.id);
        if (!after || digest(after) !== hash) throw new Error('OpenCode 对话正在变化，请在响应结束后重新迁移');
        const projects = client.listProjects ? await client.listProjects() : [];
        const nativeProject = projects.find(p => p.id === source.info.projectID);
        const directory = source.info.location?.directory ?? source.info.directory;
        const project = directory ? { name: nativeProject?.name || path.basename(directory), directory } : undefined;
        if (item.expectedProject && digest(project ?? null) !== item.expectedProject) throw new Error('项目名称自扫描后已变化，请重新扫描再迁移');
        const report = await store.receive({ ...source, ...(project ? { migrationProject: project } : {}) }, { importNow: true });
        this.current.jobs.push({ id: report.id, sourceID: item.id, sha256: hash, status: report.status, directory: report.sessions[0]?.directory });
        this.emit({ type: 'jobs-changed', id: report.id });
        if (report.status !== 'imported') throw new Error(report.error || 'DSH 原生日志回读未通过');
        this.current.imported++; this.current.nativeSessions++;
      } catch (error) { this.current.errors.push({ file: item.id, error: error.message }); }
      this.current.finished++; await this.save();
    }
    this.current.status = this.cancelled ? 'cancelled' : this.current.errors.length ? 'partial' : 'completed';
    this.current.stage = this.cancelled ? '已在当前对话完成后停止' : this.current.errors.length ? '迁移结束，部分记录需要处理' : '已写入 DSH 原生历史；重新打开 DSH 查看';
    this.current.completedAt = new Date().toISOString(); await this.save();
  }
  async save() {
    await atomicJSON(path.join(this.root, 'quick-latest.json'), this.current);
    await atomicJSON(path.join(this.root, 'quick-runs', this.current.id, 'report.json'), this.current);
    this.emit({ type: 'quick-progress', quick: this.current });
  }
  async start(input = {}, prepared) {
    if (input.direction === 'oc-to-dsh') return this.startReverse(input, prepared);
    if (this.active) throw new Error('一键迁移正在进行');
    for (const key of ['sourceRoot', 'directory', 'dataHome']) if (input[key] && !path.isAbsolute(input[key])) throw new Error(`${key} 需要绝对路径`);
    const plan = prepared ?? await this.discover(input);
    if (!plan.target) throw new Error('未找到可用的 OpenCode，请安装 OpenCode 后重试，或在高级设置中选择');
    const scan = prepared ? { files: prepared.files, errors: [] } : await findLocalSessions(plan.sourceRoot);
    if (!scan.files.length) throw new Error(scan.errors[0]?.error || '尚未找到 DSH 本地对话，请在高级设置中选择 DSH sessions 文件夹');
    const id = randomUUID();
    await mkdir(path.join(this.root, 'quick-runs', id, 'sources'), { recursive: true, mode: 0o700 });
    this.active = true; this.cancelled = false;
    this.current = { id, status: 'running', stage: '正在读取本机对话', total: scan.files.length, finished: 0, imported: 0, nativeSessions: 0, skipped: 0,
      sourceRoot: plan.sourceRoot, target: plan.target, directory: plan.directory, preserveProjects: plan.preserveProjects, createdAt: new Date().toISOString(), ...(plan.scanID ? { scanID: plan.scanID, selected: true } : {}),
      jobs: [], errors: [...scan.errors] };
    try { await this.save(); }
    catch (error) { this.active = false; throw error; }
    this.done = this.execute(scan.files, plan, input).catch(async error => {
      this.current.status = 'failed'; this.current.stage = '迁移已停止'; this.current.errors.push({ error: error.message });
      await this.save();
    }).finally(() => { this.active = false; });
    return this.current;
  }
  cancel() { this.cancelled = true; return { requested: true }; }
  async execute(files, plan, input) {
    const clients = new Map(), seen = new Map();
    for (const [index, item] of files.entries()) {
      if (this.cancelled) break;
      this.current.stage = `正在读取第 ${index + 1} / ${files.length} 个对话`; await this.save();
      try {
        const captured = await captureLocalSession(item);
        const registry = await readDshWorkspaces(plan.sourceRoot);
        if (registry.error) throw new Error('源项目名称读取失败：' + registry.error);
        const project = workspaceFor(registry.records, captured.session.header.id, await canonicalDirectory(captured.session.header.cwd ?? ''));
        if (project?.name) captured.session.project = { name: project.name, directory: project.directory };
        if (item.expectedProject && digest(captured.session.project ?? null) !== item.expectedProject) throw new Error('项目名称自扫描后已变化，请重新扫描再迁移');
        if (item.expectedHash && item.expectedHash !== captured.hash) throw new Error('对话自扫描后已变化，请重新扫描再迁移');
        const original = `${index}${captured.file.endsWith('.zstd') ? '.jsonl.zstd' : '.jsonl'}`;
        await writeFile(path.join(this.root, 'quick-runs', this.current.id, 'sources', original), captured.bytes, { mode: 0o600, flag: 'wx' });
        const source = { file: item.file, original, sha256: captured.hash, sourceID: captured.session.header.id };
        const identity = digest(captured.session);
        if (seen.has(source.sourceID)) {
          if (seen.get(source.sourceID) !== identity) throw new Error('同一会话 ID 存在不同副本，请检查原始日志');
          this.current.skipped++; this.current.jobs.push({ ...source, status: 'duplicate' });
        } else if (!captured.session.events.length) {
          this.current.skipped++; this.current.jobs.push({ ...source, status: 'empty-archived' });
        } else {
          let directory = input.directory || captured.session.header.cwd || plan.directory;
          if (!input.directory) {
            try { if (!(await stat(directory)).isDirectory()) directory = plan.directory; }
            catch { directory = plan.directory; }
          }
          if (!path.isAbsolute(directory)) directory = plan.directory;
          if (directory === plan.directory && !input.directory) await mkdir(directory, { recursive: true });
          const config = { binary: plan.target.binary, generation: plan.target.generation, directory, dataHome: input.dataHome || '', includeArchive: true, stateSnapshots: true };
          if (!clients.has(directory)) clients.set(directory, await this.makeClient(config));
          this.current.stage = `正在导入并核对第 ${index + 1} / ${files.length} 个对话`; await this.save();
          const report = await this.store({ ...config, client: clients.get(directory) }).receive({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), sessions: [captured.session] }, { importNow: true });
          this.current.jobs.push({ ...source, id: report.id, status: report.status, directory });
          if (report.status !== 'imported') throw new Error(report.error || '原生回读验证未通过');
          this.current.imported++; this.current.nativeSessions += report.sessions.length;
        }
        seen.set(source.sourceID, identity);
      } catch (error) { this.current.errors.push({ file: item.file, error: error.message }); }
      this.current.finished++; await this.save();
    }
    this.current.status = this.cancelled ? 'cancelled' : this.current.errors.length ? 'partial' : 'completed';
    this.current.stage = this.cancelled ? '已在当前对话完成后停止' : this.current.errors.length ? '迁移结束，部分记录需要处理' : '全部迁移完成，正文已回读核对';
    this.current.completedAt = new Date().toISOString(); await this.save();
  }
}
