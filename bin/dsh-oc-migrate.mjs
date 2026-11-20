#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { convertBundle } from '../packages/core/src/convert.mjs';
import { createCliClient, createHttpClient } from '../packages/opencode-client/src/index.mjs';
import { MigrationStore, atomicJSON } from '../packages/middleware/src/store.mjs';
import { ReverseStore } from '../packages/middleware/src/reverse.mjs';
import { binaryCandidates } from '../packages/opencode-client/src/discovery.mjs';
import { digest } from '../packages/core/src/protocol.mjs';
import { createReceiver } from '../packages/middleware/src/server.mjs';

const help = `dsh-oc-migrate 0.5.3 — DeepSeek Harness ↔ OpenCode 1.x / 2.x

  init [--state DIR] [--token-file FILE]              创建本地接收令牌
  serve --directory DIR --token-file FILE [--auto-import]
  convert BUNDLE --directory DIR --out DIR --generation v1|v2
  import BUNDLE --directory DIR [--state DIR]         本地文件直接导入
  to-dsh [EXPORT.json] [--dsh-root DIR]              反向迁移；不指定文件则导出本机全部 OpenCode 历史
  jobs [--state DIR]                                 查看任务
  retry JOB_ID --directory DIR [--state DIR]          重试导入
  rollback JOB_ID --directory DIR [--state DIR]       只回滚正文未改变的迁移会话

目标选项：--binary PATH / --data-home DIR / --generation auto|v1|v2
2.x GUI 远端：--server URL [--password-file FILE] [--username opencode]
转换选项：--provider ID --model ID --no-archive --no-state-snapshots
接收端默认：127.0.0.1:48765；--port 可覆盖。目标路径由本机配置决定。
`;

async function main() {
  const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, state: { type: 'string' }, directory: { type: 'string' }, out: { type: 'string' },
    'token-file': { type: 'string' }, port: { type: 'string', default: '48765' }, binary: { type: 'string' },
    'dsh-root': { type: 'string' }, generation: { type: 'string', default: 'auto' }, 'data-home': { type: 'string' }, server: { type: 'string' },
    'password-file': { type: 'string' }, username: { type: 'string' }, 'auto-import': { type: 'boolean' },
    provider: { type: 'string' }, model: { type: 'string' }, 'no-archive': { type: 'boolean' }, 'no-state-snapshots': { type: 'boolean' },
  } });
  const [command, input] = positionals;
  if (args.help || !command) { console.log(help); return; }
  const state = path.resolve(args.state ?? path.join(os.homedir(), '.local/share/dsh-oc-migrate'));
  const tokenFile = path.resolve(args['token-file'] ?? path.join(state, 'receiver.token'));
  if (command === 'init') {
    await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    await writeFile(tokenFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`已创建令牌文件：${tokenFile}`); return;
  }
  if (command === 'jobs') { console.log(JSON.stringify(await new MigrationStore({ state }).list(), null, 2)); return; }
  if (['retry', 'rollback'].includes(command)) {
    const report = await new MigrationStore({ state }).read(input);
    if (report.direction === 'oc-to-dsh') { console.log(JSON.stringify(await new ReverseStore({ state })[command === 'retry' ? 'import' : 'rollback'](input), null, 2)); return; }
  }
  if (command === 'to-dsh') {
    const store = new ReverseStore({ state, dshRoot: path.resolve(args['dsh-root'] ?? path.join(os.homedir(), '.dsh/sessions')) });
    if (input) {
      const report = await store.receive(JSON.parse(await readFile(input, 'utf8')), { importNow: true });
      console.log(JSON.stringify(report, null, 2)); if (report.status !== 'imported') process.exitCode = 1; return;
    }
    let client;
    for (const binary of args.binary ? [args.binary] : binaryCandidates(os.homedir())) {
      try { client = await createCliClient({ binary, directory: os.homedir(), dataHome: args['data-home'], generation: args.generation }); break; }
      catch { /* Try the next installed client. */ }
    }
    if (!client) throw new Error('未找到可用的 OpenCode');
    const reports = [], errors = [], sessions = await client.listAll();
    for (const session of sessions) {
      try {
        const source = await client.export(session.id);
        if (!source || digest(source) !== digest(await client.export(session.id))) throw new Error('会话正在变化，请等待响应结束后重试');
        const report = await store.receive(source, { importNow: true }); reports.push(report);
        if (report.status !== 'imported') errors.push({ id: session.id, error: report.error });
      } catch (error) { errors.push({ id: session.id, error: error.message }); }
    }
    console.log(JSON.stringify({ total: sessions.length, reports, errors }, null, 2));
    if (errors.length) process.exitCode = 1; return;
  }
  if (!['serve', 'convert', 'import', 'retry', 'rollback'].includes(command)) throw new Error(`未知命令：${command}`);
  if (!args.directory) throw new Error('请用 --directory 指定 OpenCode 目标项目');
  const directory = path.resolve(args.directory);
  const options = { directory, generation: args.generation, provider: args.provider, model: args.model, includeArchive: !args['no-archive'], stateSnapshots: !args['no-state-snapshots'] };
  if (command === 'convert') {
    if (!input || !args.out || !['v1', 'v2'].includes(args.generation)) throw new Error('convert 需要文件、--out 和显式 --generation v1|v2');
    const converted = convertBundle(JSON.parse(await readFile(input, 'utf8')), options);
    const out = path.resolve(args.out); await mkdir(out, { recursive: true, mode: 0o700 });
    for (const item of converted) await atomicJSON(path.join(out, `${item.sessionID}.json`), item.transcript);
    console.log(JSON.stringify(converted.map(({ transcript: _, ...item }) => item), null, 2)); return;
  }
  const config = { ...options, state, binary: args.binary, dataHome: args['data-home'] ? path.resolve(args['data-home']) : undefined };
  if (args.server) {
    if (args.generation === 'v1') throw new Error('server 导入适配 OpenCode 2.x；1.x 使用原生 CLI');
    config.client = createHttpClient({ ...config, server: args.server, username: args.username, password: args['password-file'] ? (await readFile(args['password-file'], 'utf8')).trim() : undefined });
  } else config.client = await createCliClient(config);
  const store = new MigrationStore(config);
  if (command === 'serve') {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const port = Number(args.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 应为 1–65535');
    const receiver = createReceiver({ store, token, autoImport: args['auto-import'] });
    await new Promise((resolve, reject) => { receiver.once('error', reject); receiver.listen(port, '127.0.0.1', resolve); });
    console.log(`接收端：http://127.0.0.1:${port}；目标：${config.client.version} ${directory}；自动导入：${!!args['auto-import']}`);
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => receiver.close(() => process.exit(0)));
    return;
  }
  if (!input) throw new Error(`${command} 需要文件或任务 id`);
  const report = command === 'import' ? await store.receive(JSON.parse(await readFile(input, 'utf8')), { importNow: true }) : await store[command === 'retry' ? 'import' : 'rollback'](input);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'failed') process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
