import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { findLocalSessions, captureLocalSession } from '../../plugin/src/local-reader.mjs';
import { FORMAT, digest } from '../../core/src/protocol.mjs';
import { atomicJSON } from '../../middleware/src/store.mjs';

export function binaryCandidates(home) {
  const gui = process.platform === 'darwin'
    ? ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', path.join(home, 'Applications/OpenCode.app/Contents/Resources/opencode-cli')]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'OpenCode/opencode-cli.exe'), path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs/OpenCode/opencode-cli.exe')]
      : ['/opt/OpenCode/opencode-cli', '/usr/lib/opencode/opencode-cli', path.join(home, '.local/bin/opencode')];
  return [...new Set([...gui, path.join(home, `.opencode/bin/opencode${process.platform === 'win32' ? '.exe' : ''}`), ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']), process.platform === 'win32' ? 'opencode.exe' : 'opencode'])];
}

export class QuickMigration {
  constructor({ root, home, makeClient, store, emit, candidates }) {
    Object.assign(this, { root, home, makeClient, store, emit });
    this.candidates = candidates ?? binaryCandidates(home);
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
    const sourceRoot = input.sourceRoot || path.join(this.home, '.dsh/sessions');
    const scan = await findLocalSessions(sourceRoot);
    const binaries = input.binary ? [input.binary] : this.candidates;
    // Prefer the installed GUI's own CLI over another generation in PATH.
    const found = await Promise.all(binaries.map(async binary => {
      try {
        const client = await this.makeClient({ binary, directory: this.home, dataHome: input.dataHome || '', timeout: 7000 });
        return { binary, version: client.version, generation: client.generation };
      } catch { return null; }
    }));
    const target = found.find(Boolean) || null;
    return { sourceRoot, total: scan.files.length, errors: scan.errors, target,
      directory: input.directory || path.join(this.home, 'OpenCode/DSH 历史'), preserveProjects: !input.directory };
  }
  async save() {
    await atomicJSON(path.join(this.root, 'quick-latest.json'), this.current);
    await atomicJSON(path.join(this.root, 'quick-runs', this.current.id, 'report.json'), this.current);
    this.emit({ type: 'quick-progress', quick: this.current });
  }
  async start(input = {}) {
    if (this.active) throw new Error('一键迁移正在进行');
    for (const key of ['sourceRoot', 'directory', 'dataHome']) if (input[key] && !path.isAbsolute(input[key])) throw new Error(`${key} 需要绝对路径`);
    const plan = await this.discover(input);
    if (!plan.target) throw new Error('未找到可用的 OpenCode，请安装 OpenCode 后重试，或在高级设置中选择');
    const scan = await findLocalSessions(plan.sourceRoot);
    if (!scan.files.length) throw new Error(scan.errors[0]?.error || '尚未找到 DSH 本地对话，请在高级设置中选择 DSH sessions 文件夹');
    const id = randomUUID();
    await mkdir(path.join(this.root, 'quick-runs', id, 'sources'), { recursive: true, mode: 0o700 });
    this.active = true; this.cancelled = false;
    this.current = { id, status: 'running', stage: '正在读取本机对话', total: scan.files.length, finished: 0, imported: 0, nativeSessions: 0, skipped: 0,
      sourceRoot: plan.sourceRoot, target: plan.target, directory: plan.directory, preserveProjects: plan.preserveProjects, createdAt: new Date().toISOString(),
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
