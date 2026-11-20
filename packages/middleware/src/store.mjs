import { mkdir, readFile, writeFile, rename, readdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentDigest, digest, validateBundle } from '../../core/src/protocol.mjs';
import { convertBundle, CONVERTER_REVISION } from '../../core/src/convert.mjs';
import { atomicWrite } from '../../core/src/atomic-file.mjs';
import { verifyTranscript } from '../../opencode-client/src/index.mjs';
import { claimProjectName, releaseProjectName } from './project-names.mjs';

export async function atomicJSON(file, value) {
  await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
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
    const id = digest({ converter: CONVERTER_REVISION, bundle: contentDigest(bundle), target: client?.identity ?? directory, directory, generation, provider: provider ?? null, model: model ?? null, includeArchive: includeArchive !== false, stateSnapshots: stateSnapshots !== false });
    return this.locked(id, async dir => {
      let report;
      try { report = await this.read(id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!report) {
        const converted = convertBundle(bundle, { directory, generation, provider, model, includeArchive, stateSnapshots });
        await atomicJSON(path.join(dir, 'source.json'), bundle);
        for (const item of converted) await atomicJSON(path.join(dir, `${item.sessionID}.json`), item.transcript);
        report = { id, status: 'received', generation, destination: client?.identity ?? null, createdAt: new Date().toISOString(), sourceHash: contentDigest(bundle), projectName: [...new Set(bundle.sessions.map(s => s.project?.name).filter(Boolean))].length === 1 ? bundle.sessions.find(s => s.project?.name)?.project.name : undefined, projectNames: [], sessions: converted.map(({ transcript: _, ...item }) => ({ ...item, status: 'pending' })) };
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
        const existing = await client.export(item.sessionID);
        if (existing && existing.info.title !== expected.info.title) {
          verifyTranscript({ ...expected, info: { ...expected.info, title: existing.info.title } }, existing);
          const sourceID = expected.info.metadata?.dshMigration?.sourceID;
          if (!client.updateSessionTitle || ![item.sessionID, `DeepSeek · ${sourceID}`, `OpenCode ${sourceID}`].includes(existing.info.title)) throw new Error('目标对话标题已变化，已保留现有名称；请在源端或目标端核对');
          item.titleChange ??= { before: existing.info.title, after: expected.info.title };
          await atomicJSON(path.join(dir, 'report.json'), report);
          await client.updateSessionTitle(item.sessionID, expected.info.title);
        }
        // 即使任务曾成功，也要确认目标中的会话尚在，且正文一致。
        const receipt = await client.import(file, expected);
        Object.assign(item, { status: 'verified', receipt });
        if (receipt.status === 'existing-continued-preserved') item.warnings = [...new Set([...(item.warnings ?? []), '这个对话已继续聊天，已保留后续新增消息；撤销不会删除已使用的历史。'])];
        await atomicJSON(path.join(dir, 'report.json'), report);
      }
      if (report.projectName) {
        const checkedProjects = new Set();
        for (const item of report.sessions) {
          const actual = await client.export(item.sessionID), id = actual.info.projectID;
          if (checkedProjects.has(id)) continue; checkedProjects.add(id);
          report.projectNames ??= [];
          let receipt = report.projectNames.find(p => p.id === id);
          if (!receipt) { receipt = { id, name: report.projectName, key: digest({ target: client.storageIdentity ?? client.identity, id }), status: 'pending' }; report.projectNames.push(receipt); }
          Object.assign(receipt, { key: digest({ target: client.storageIdentity ?? client.identity, id }), status: 'pending' });
          await atomicJSON(path.join(dir, 'report.json'), report);
          const result = await claimProjectName(this.root, client, id, report.projectName, report.id);
          for (const key of Object.keys(receipt)) delete receipt[key]; Object.assign(receipt, result);
          await atomicJSON(path.join(dir, 'report.json'), report);
        }
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
        if (!item.owned && !item.titleChange) continue;
        await client.assertNoChildren?.(item.sessionID);
        const actual = await client.export(item.sessionID);
        if (actual) verifyTranscript(JSON.parse(await readFile(path.join(dir, `${item.sessionID}.json`), 'utf8')), actual);
      }
      for (const item of report.sessions) {
        if (!item.owned) {
          if (item.titleChange) { const actual = await client.export(item.sessionID); if (actual) await client.updateSessionTitle(item.sessionID, item.titleChange.before); }
          item.status = 'preserved-existing'; continue;
        }
        await client.remove(item.sessionID);
        item.status = 'rolled-back';
        await atomicJSON(path.join(dir, 'report.json'), report);
      }
      for (const receipt of report.projectNames ?? []) await releaseProjectName(this.root, client, receipt, report.id);
      report.status = 'rolled-back';
      await atomicJSON(path.join(dir, 'report.json'), report);
      return report;
    });
  }
}
