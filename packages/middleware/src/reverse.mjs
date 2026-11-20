import { mkdir, readFile, readdir, writeFile, link, unlink, rmdir, realpath } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MigrationStore, atomicJSON } from './store.mjs';
import { convertOpenCode } from '../../core/src/reverse.mjs';
import { digest } from '../../core/src/protocol.mjs';
import { captureLocalSession, findLocalSessions } from '../../plugin/src/local-reader.mjs';
import { registerDshWorkspace, rollbackDshWorkspace, registerDshTitleCache, rollbackDshTitleCache, assertDshOffline } from './dsh-workspaces.mjs';

// Same project-key algorithm as DSH session-persistence-jsonl@0.2.1-rc.2.
export function dshProjectKey(cwd) {
  if (cwd === undefined) return '_no-cwd';
  let value = '', separator = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i];
    if ('/\\:'.includes(ch)) { if (!separator) value += '-'; separator = true; }
    else { value += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`; separator = false; }
  }
  return `--${(value.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
async function exists(file) { try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function detectDshEncoding(root, requested) {
  const scan = await findLocalSessions(root);
  if (scan.errors.length) throw new Error(scan.errors[0].error);
  const modes = new Set();
  for (const item of scan.files) {
    // DSH rejects opposite encodings even when they belong to an older generation.
    for (const name of await readdir(path.dirname(item.file))) if (/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(name)) modes.add(name.endsWith('.zstd') ? 'zstd' : 'none');
  }
  if (modes.size > 1) throw new Error('DSH sessions 混用了压缩和明文日志，请先在 DSH 核对存储配置');
  const encoding = [...modes][0] ?? requested ?? 'zstd';
  if (!['zstd', 'none'].includes(encoding) || requested && requested !== encoding) throw new Error('DSH 目标日志编码与所选配置不一致');
  return encoding;
}

export class ReverseStore extends MigrationStore {
  async receive(transcript, { importNow = false } = {}) {
    if (!this.config.dshRoot || !path.isAbsolute(this.config.dshRoot)) throw new Error('DSH sessions 需要绝对路径');
    if (transcript.migrationProject) {
      const p = transcript.migrationProject, cwd = transcript.info?.location?.directory ?? transcript.info?.directory;
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 500 || typeof p.directory !== 'string' || !path.isAbsolute(p.directory) || typeof cwd !== 'string' || path.normalize(p.directory) !== path.normalize(cwd)) throw new Error('项目名称或目录与 OpenCode 原件不一致');
      await assertDshOffline();
    }
    await assertDshOffline();
    await mkdir(this.config.dshRoot, { recursive: true, mode: 0o700 });
    const dshRoot = await realpath(this.config.dshRoot);
    const encoding = await detectDshEncoding(dshRoot, this.config.encoding);
    const item = convertOpenCode(transcript), sourceHash = digest(transcript);
    const id = digest({ direction: 'oc-to-dsh', writer: 1, revision: item.revision, sourceHash, dshRoot, encoding });
    return this.locked(id, async dir => {
      let report;
      try { report = await this.read(id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!report) {
        const file = path.join(dshRoot, dshProjectKey(item.session.header.cwd), item.sessionID, `session.v4.jsonl${encoding === 'zstd' ? '.zstd' : ''}`);
        // DSH requires the first Zstd frame to contain exactly the header row.
        // The event batch lives in a second frame, like native persistBatch.
        const cut = item.bytes.indexOf(10) + 1;
        const bytes = encoding === 'zstd' ? Buffer.concat([zstdCompressSync(item.bytes.subarray(0, cut)), zstdCompressSync(item.bytes.subarray(cut))]) : item.bytes;
        await atomicJSON(path.join(dir, 'source.json'), transcript);
        await writeFile(path.join(dir, 'session.log'), bytes, { mode: 0o600, flag: 'wx' });
        report = { id, direction: 'oc-to-dsh', generation: 'dsh-v4', status: 'received', sourceHash, destination: dshRoot, encoding, createdAt: new Date().toISOString(),
          sessions: [{ sourceID: item.sourceID, sessionID: item.sessionID, title: item.session.title, revision: item.revision, directory: item.session.header.cwd, file, hash: digest(bytes), warnings: item.warnings, status: 'pending' }] };
        await atomicJSON(path.join(dir, 'report.json'), report);
      }
      return importNow ? this.importLocked(dir, report) : report;
    });
  }
  async expected(dir, report) {
    const source = JSON.parse(await readFile(path.join(dir, 'source.json'), 'utf8'));
    if (digest(source) !== report.sourceHash) throw new Error('OpenCode 原始备份校验不匹配');
    const item = convertOpenCode(source);
    const expectedFile = path.join(report.destination, dshProjectKey(item.session.header.cwd), item.sessionID, `session.v4.jsonl${report.encoding === 'zstd' ? '.zstd' : ''}`);
    if (report.sessions.length !== 1 || report.sessions[0].file !== expectedFile) throw new Error('DSH 任务目标路径校验不匹配');
    const bytes = await readFile(path.join(dir, 'session.log'));
    if (digest(bytes) !== report.sessions[0].hash) throw new Error('DSH 日志备份校验不匹配');
    return bytes;
  }
  async importLocked(dir, report) {
    if (report.direction !== 'oc-to-dsh') throw new Error('迁移方向不匹配');
    const bytes = await this.expected(dir, report), item = report.sessions[0];
    const source = JSON.parse(await readFile(path.join(dir, 'source.json'), 'utf8'));
    await assertDshOffline();
    report.status = 'importing'; await atomicJSON(path.join(dir, 'report.json'), report);
    try {
      await detectDshEncoding(report.destination, report.encoding);
      await mkdir(path.dirname(item.file), { recursive: true, mode: 0o700 });
      if (item.owned === undefined) {
        item.owned = false;
        await atomicJSON(path.join(dir, 'report.json'), report);
      }
      if (!await exists(item.file)) {
        const canonical = await realpath(path.dirname(item.file));
        if (!canonical.startsWith(report.destination + path.sep)) throw new Error('DSH 会话目录指向目标根目录之外');
        if ((await readdir(path.dirname(item.file))).length) throw new Error('DSH 会话目录已有其他数据，保留该目录');
        const temp = path.join(path.dirname(item.file), `.oc-migrate-${randomUUID()}`);
        try {
          await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
          // Publish one complete file without replacing any existing pathname.
          await link(temp, item.file);
          item.owned = true; await atomicJSON(path.join(dir, 'report.json'), report);
        } finally { await unlink(temp).catch(() => {}); }
      }
      const actual = await readFile(item.file);
      if (digest(actual) !== item.hash) throw new Error('DSH 会话已变化，保留现有历史');
      const captured = await captureLocalSession({ file: item.file });
      if (captured.session.header.id !== item.sessionID) throw new Error('DSH 原生日志回读 ID 不匹配');
      // Validate the disk representation with the DSH-owned codec again.
      const original = convertOpenCode(JSON.parse(await readFile(path.join(dir, 'source.json'), 'utf8')));
      if (digest(captured.session.events) !== digest(original.session.events)) throw new Error('DSH 事件回读不匹配');
      report.titleCache = await registerDshTitleCache(dir, report, original.session);
      report.workspace = await registerDshWorkspace(dir, report, source.migrationProject);
      item.status = 'verified'; report.status = 'imported'; delete report.error;
    } catch (error) { report.status = 'failed'; report.error = error.message; }
    await atomicJSON(path.join(dir, 'report.json'), report);
    return report;
  }
  async rollback(id) {
    return this.locked(id, async dir => {
      const report = await this.read(id); await this.expected(dir, report);
      const item = report.sessions[0];
      if (!item.owned) { await rollbackDshTitleCache(dir, report); await rollbackDshWorkspace(dir, report); report.status = 'rolled-back'; item.status = 'preserved-existing'; }
      else {
        const scan = await findLocalSessions(report.destination);
        if (scan.errors.length) throw new Error('DSH 子会话检查失败，保留历史');
        for (const candidate of scan.files) {
          const { session } = await captureLocalSession(candidate);
          if (session.header.parentSession === item.sessionID) throw new Error('DSH 会话已有分支，保留历史');
        }
        if (await exists(item.file)) {
          if (digest(await readFile(item.file)) !== item.hash) throw new Error('DSH 会话已变化，保留历史');
          const entries = await readdir(path.dirname(item.file));
          // A surviving native lease means DSH has taken write ownership at least once.
          // Do not unlink its stable lock inode or race a resumed native writer.
          if (entries.some(name => name !== path.basename(item.file))) throw new Error('DSH 已打开此会话或目录存在其他数据，保留历史');
          await rollbackDshTitleCache(dir, report); await rollbackDshWorkspace(dir, report);
          await unlink(item.file); await rmdir(path.dirname(item.file));
        } else { await rollbackDshTitleCache(dir, report); await rollbackDshWorkspace(dir, report); }
        item.status = 'rolled-back'; report.status = 'rolled-back';
      }
      await atomicJSON(path.join(dir, 'report.json'), report); return report;
    });
  }
}
