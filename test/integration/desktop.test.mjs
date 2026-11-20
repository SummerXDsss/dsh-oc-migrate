import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { fixture } from '../fixture.mjs';
import { createCliClient } from '../../packages/opencode-client/src/index.mjs';
const targets = [{ generation: 'v1', binary: process.env.OPENCODE_V1_BIN }, { generation: 'v2', binary: process.env.OPENCODE_V2_BIN }];
for (const target of targets) {
  test(`桌面 sidecar → 真实 OpenCode ${target.generation} → 回读与回滚`, { skip: !target.binary, timeout: 300000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-native-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'project'); await mkdir(directory);
    const env = { ...process.env, HOME: root, XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_DB: path.join(root, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_CONTENT: '{}', DSH_OC_SIDECAR: '1', DSH_OC_APP_DATA: path.join(root, 'app') };
    const compiled = process.env.DSH_OC_TEST_SIDECAR;
    const child = spawn(compiled || process.execPath, compiled ? [] : ['packages/desktop/src/service.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => error += chunk);
    t.after(() => child.kill());
    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map(); let sequence = 0;
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.kind !== 'response') return;
      const handler = pending.get(message.id); pending.delete(message.id);
      if (message.error) handler?.reject(new Error(message.error)); else handler?.resolve(message.result);
    });
    const rpc = (method, payload = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, payload }) + '\n');
    });
    const connected = await rpc('connect', { directory, binary: target.binary, generation: target.generation });
    assert.equal(connected.generation, target.generation);
    const file = path.join(root, 'bundle.json'); await writeFile(file, JSON.stringify(fixture({ compact: true })));
    const report = await rpc('importFile', { file }); assert.equal(report.status, 'imported', report.error);
    assert.equal(report.sessions.length, 2);
    const client = await createCliClient({ binary: target.binary, directory, env });
    for (const item of report.sessions) assert.equal((await client.export(item.sessionID)).info.id, item.sessionID);
    assert.equal((await rpc('snapshot')).jobs[0].status, 'imported');
    assert.equal((await rpc('retry', { id: report.id })).status, 'imported');
    assert.equal((await rpc('rollback', { id: report.id })).status, 'rolled-back');
    for (const item of report.sessions) assert.equal(await client.export(item.sessionID), null);
    child.stdin.end();
    const code = await new Promise(resolve => child.on('exit', resolve)); assert.equal(code, 0, error);
    t.diagnostic(`sidecar=${compiled ? 'compiled Bun' : 'Node'}; ${target.generation} import=PASS; native export=PASS; retry=PASS; rollback=PASS; exit=0`);
  });
}
