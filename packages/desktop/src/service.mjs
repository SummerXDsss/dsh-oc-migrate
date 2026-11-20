import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { MigrationStore, atomicJSON } from '../../middleware/src/store.mjs';
import { createReceiver } from '../../middleware/src/server.mjs';
import { createCliClient, createHttpClient } from '../../opencode-client/src/index.mjs';

const MAX_FILE = 64 * 1024 * 1024;
export class DesktopService {
  constructor({ root, pluginFile, emit = () => {}, makeClient = createCliClient }) {
    this.root = path.resolve(root); this.pluginFile = pluginFile;
    this.emit = emit; this.makeClient = makeClient;
    this.server = null; this.target = null; this.receiver = null;
    this.jobs = new MigrationStore({ state: path.join(this.root, 'jobs') });
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.tokenFile = path.join(this.root, 'receiver.token');
    try { await writeFile(this.tokenFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.token = (await readFile(this.tokenFile, 'utf8')).trim();
    try { this.settings = JSON.parse(await readFile(path.join(this.root, 'settings.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.settings = {}; }
    return this;
  }
  async snapshot() {
    return { settings: this.settings, receiver: this.receiver, jobs: await this.jobs.list(),
      stateDirectory: this.root, tokenFile: this.tokenFile, pluginFile: this.pluginFile ?? null };
  }
  async detect() {
    const home = os.homedir();
    const names = process.platform === 'win32'
      ? [path.join(home, '.opencode/bin/opencode.exe'), 'opencode.exe']
      : [path.join(home, '.opencode/bin/opencode'), '/Applications/OpenCode.app/Contents/Resources/opencode-cli', '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', 'opencode'];
    const candidates = [];
    for (const binary of names) {
      try {
        const client = await this.makeClient({ binary, directory: home, timeout: 15000 });
        candidates.push({ binary, version: client.version, generation: client.generation });
      } catch { /* Other candidates remain discoverable when one binary is absent. */ }
    }
    return { candidates, dshProfile: path.join(home, '.dsh/profiles/desktop') };
  }
  normalize(input) {
    if (!input || typeof input.directory !== 'string' || !path.isAbsolute(input.directory)) throw new Error('请选择 OpenCode 目标项目的绝对路径');
    if (input.server && input.generation === 'v1') throw new Error('OpenCode 1.x 请使用 CLI 方式连接');
    return { directory: path.normalize(input.directory), binary: input.binary || 'opencode',
      generation: input.generation || 'auto', server: input.server || '',
      dataHome: input.dataHome || '', passwordFile: input.passwordFile || '',
      includeArchive: input.includeArchive !== false, stateSnapshots: input.stateSnapshots !== false };
  }
  async connect(input) {
    if (this.server) throw new Error('请先停止接收，再切换或重新连接 OpenCode');
    const config = this.normalize(input);
    if (!(await stat(config.directory)).isDirectory()) throw new Error('目标项目必须是文件夹');
    const client = config.server
      ? createHttpClient({ ...config, password: config.passwordFile ? (await readFile(config.passwordFile, 'utf8')).trim() : undefined })
      : await this.makeClient(config);
    // HTTP clients also need a real connection check before the UI claims success.
    if (config.server) await client.export('ses_00000000000000000000000000');
    this.settings = config;
    await atomicJSON(path.join(this.root, 'settings.json'), config);
    this.target = { ...config, generation: client.generation, version: client.version, client };
    return { version: client.version, generation: client.generation, directory: config.directory };
  }
  observedStore(target) {
    const store = new MigrationStore({ ...target, state: this.jobs.root });
    const receive = store.receive.bind(store);
    store.receive = async (bundle, { importNow = false } = {}) => {
      const report = await receive(bundle);
      const { client: _, version: __, ...config } = target;
      await atomicJSON(path.join(store.jobPath(report.id), 'desktop-target.json'), config);
      this.emit({ type: 'jobs-changed', id: report.id });
      try { return importNow ? await store.import(report.id) : report; }
      finally { this.emit({ type: 'jobs-changed', id: report.id }); }
    };
    return store;
  }
  async start({ port = 48765, autoImport = true } = {}) {
    if (this.server) throw new Error('接收端已经启动，请先停止再修改设置');
    if (!this.target) throw new Error('请先检测并连接 OpenCode');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应为 1–65535');
    const target = this.target;
    const server = createReceiver({ store: this.observedStore(target), token: this.token, autoImport });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    this.server = server;
    this.receiver = { url: `http://127.0.0.1:${port}`, autoImport, version: target.version, directory: target.directory };
    this.emit({ type: 'receiver-changed' });
    return this.receiver;
  }
  async stop() {
    const server = this.server;
    if (server) await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    this.server = null; this.receiver = null;
    this.emit({ type: 'receiver-changed' });
    return { stopped: true };
  }
  async importFile({ file }) {
    if (!this.target) throw new Error('请先检测并连接 OpenCode');
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('请选择本地 JSON 迁移包');
    if ((await stat(file)).size > MAX_FILE) throw new Error('迁移包超过 64 MiB');
    return this.observedStore(this.target).receive(JSON.parse(await readFile(file, 'utf8')), { importNow: true });
  }
  async jobAction(action, { id }) {
    // Reconnect to the original target, not the currently selected project.
    const file = path.join(this.jobs.jobPath(id), 'desktop-target.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    const client = config.server
      ? createHttpClient({ ...config, password: config.passwordFile ? (await readFile(config.passwordFile, 'utf8')).trim() : undefined })
      : await this.makeClient(config);
    try { return await this.observedStore({ ...config, client })[action](id); }
    finally { this.emit({ type: 'jobs-changed', id }); }
  }
  async request(method, payload = {}) {
    switch (method) {
      case 'snapshot': return this.snapshot();
      case 'detect': return this.detect();
      case 'connect': return this.connect(payload);
      case 'start': return this.start(payload);
      case 'stop': return this.stop();
      case 'importFile': return this.importFile(payload);
      case 'retry': return this.jobAction('import', payload);
      case 'rollback': return this.jobAction('rollback', payload);
      default: throw new Error('未知桌面操作');
    }
  }
}

export async function runRPC({ root, pluginFile, input = process.stdin, output = process.stdout }) {
  const send = value => output.write(JSON.stringify(value) + '\n');
  const service = await new DesktopService({ root, pluginFile, emit: event => send({ kind: 'event', event }) }).init();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  // Serialize mutations so settings cannot race with receiver startup or imports.
  for await (const line of lines) {
    let message;
    try {
      if (line.length > 1024 * 1024) throw new Error('桌面请求过大');
      message = JSON.parse(line);
      const result = await service.request(message.method, message.payload);
      send({ kind: 'response', id: message.id, result });
    } catch (error) { send({ kind: 'response', id: message?.id ?? null, error: error.message }); }
  }
  await service.stop();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href || process.env.DSH_OC_SIDECAR === '1') {
  runRPC({ root: process.env.DSH_OC_APP_DATA, pluginFile: process.env.DSH_OC_PLUGIN_FILE }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
