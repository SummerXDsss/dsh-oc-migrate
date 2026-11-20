import { mkdir, readFile, writeFile, rename, readdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentDigest, digest, validateBundle } from '../../core/src/protocol.mjs';
import { convertBundle } from '../../core/src/convert.mjs';
import { verifyTranscript } from '../../opencode-client/src/index.mjs';

export async function atomicJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}
export class MigrationStore {
  constructor(config) { this.config = config; this.root = path.resolve(config.state); }
  jobPath(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('任务 id 格式无效');
    return path.join(this.root, id);
  }
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
  async read(id) { return JSON.parse(await readFile(path.join(this.jobPath(id), 'report.json'), 'utf8')); }
  async list() {
    await this.init();
    const jobs = [];
    for (const name of await readdir(this.root)) if (/^[a-f0-9]{64}$/.test(name)) {
      try { jobs.push(await this.read(name)); } catch (error) { jobs.push({ id: name, status: 'incomplete', error: error.message }); }
    }
    return jobs;
  }
  async locked(id, action) {
    await this.init();
    const dir = this.jobPath(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lock = path.join(dir, '.lock');
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('任务正在处理；如上次进程崩溃，请检查 .lock 后重试'), { status: 409 }); throw error; }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await action(dir); }
    finally { await handle.close(); await unlink(lock); }
  }
  async receive(bundle, { importNow = false } = {}) {
    validateBundle(bundle);
    const { client, directory, provider, model, includeArchive, stateSnapshots } = this.config;
    const generation = client?.generation ?? this.config.generation ?? 'v1';
    const id = digest({ bundle: contentDigest(bundle), target: client?.identity ?? directory, directory, generation, provider: provider ?? null, model: model ?? null, includeArchive: includeArchive !== false, stateSnapshots: stateSnapshots !== false });
    return this.locked(id, async dir => {
      let report;
      try { report = await this.read(id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!report) {
        const converted = convertBundle(bundle, { directory, generation, provider, model, includeArchive, stateSnapshots });
        await atomicJSON(path.join(dir, 'source.json'), bundle);
        for (const item of converted) await atomicJSON(path.join(dir, `${item.sessionID}.json`), item.transcript);
        report = { id, status: 'received', generation, destination: client?.identity ?? null, createdAt: new Date().toISOString(), sourceHash: contentDigest(bundle), sessions: converted.map(({ transcript: _, ...item }) => ({ ...item, status: 'pending' })) };
        await atomicJSON(path.join(dir, 'report.json'), report);
      }
      if (importNow) return this.importLocked(dir, report);
      return report;
    });
  }
  async import(id) { return this.locked(id, async dir => this.importLocked(dir, await this.read(id))); }
  async importLocked(dir, report) {
    const client = this.config.client;
    if (!client) throw new Error('导入前需要配置 OpenCode 客户端');
    if (report.destination && report.destination !== client.identity) throw new Error('当前目标与任务记录不一致');
    if (report.generation !== client.generation) throw new Error('当前客户端版本与任务不一致');
    report.destination = client.identity;
    report.status = 'importing';
    await atomicJSON(path.join(dir, 'report.json'), report);
    try {
      for (const item of report.sessions) {
        const file = path.join(dir, `${item.sessionID}.json`);
        const expected = JSON.parse(await readFile(file, 'utf8'));
        if (item.owned === undefined) {
          item.owned = !(await client.export(item.sessionID));
          await atomicJSON(path.join(dir, 'report.json'), report);
        }
        // 即使任务曾成功，也要确认目标中的会话尚在，且正文一致。
        const receipt = await client.import(file, expected);
        Object.assign(item, { status: 'verified', receipt });
        await atomicJSON(path.join(dir, 'report.json'), report);
      }
      report.status = 'imported';
      delete report.error;
    } catch (error) { report.status = 'failed'; report.error = error.message; }
    await atomicJSON(path.join(dir, 'report.json'), report);
    return report;
  }
  async rollback(id) {
    return this.locked(id, async dir => {
      const report = await this.read(id), client = this.config.client;
      if (!client || report.destination !== client.identity) throw new Error('回滚目标与任务记录不一致');
      // 全部预检查：用户已继续的会话不删除，也不在检查中途先删别的会话。
      for (const item of report.sessions) {
        if (!item.owned) continue;
        const actual = await client.export(item.sessionID);
        if (actual) verifyTranscript(JSON.parse(await readFile(path.join(dir, `${item.sessionID}.json`), 'utf8')), actual);
      }
      for (const item of report.sessions) {
        if (!item.owned) { item.status = 'preserved-existing'; continue; }
        await client.remove(item.sessionID);
        item.status = 'rolled-back';
        await atomicJSON(path.join(dir, 'report.json'), report);
      }
      report.status = 'rolled-back';
      await atomicJSON(path.join(dir, 'report.json'), report);
      return report;
    });
  }
}
