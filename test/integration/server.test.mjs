import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fixture } from '../fixture.mjs';
import { createHttpClient, verifyTranscript } from '../../packages/opencode-client/src/index.mjs';
import { MigrationStore } from '../../packages/middleware/src/store.mjs';
import { convertBundle } from '../../packages/core/src/convert.mjs';

test('真实 OpenCode 2.x HTTP：导入到 GUI 后端，CLI 连接同一服务器回读', { skip: !process.env.OPENCODE_V2_BIN, timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-server-v2-'));
  const directory = path.join(root, 'project'); await mkdir(directory);
  const binary = process.env.OPENCODE_V2_BIN, password = 'isolated-integration-test-password';
  const env = { ...process.env, HOME: root, XDG_DATA_HOME: root + '/data', XDG_STATE_HOME: root + '/state', XDG_CONFIG_HOME: root + '/config', XDG_CACHE_HOME: root + '/cache', OPENCODE_DB: root + '/opencode.db', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_SERVER_PASSWORD: password };
  const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const server = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OpenCode 服务器启动超时：' + output)), 30000);
    const capture = chunk => {
      output += chunk.toString();
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) { clearTimeout(timer); resolve(url); }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`OpenCode 服务器提前退出 ${code}: ${output}`)); });
  });
  const client = createHttpClient({ directory, server, password });
  const store = new MigrationStore({ directory, state: root + '/jobs', client });
  const bundle = fixture({ compact: true });
  const report = await store.receive(bundle, { importNow: true });
  assert.equal(report.status, 'imported', report.error); assert.equal(report.sessions.length, 2);
  const expected = convertBundle(bundle, { directory, generation: 'v2' });
  for (const item of expected) {
    const { stdout } = await promisify(execFile)(binary, ['session', 'export', item.sessionID, '--server', server], { env, cwd: directory, timeout: 30000, maxBuffer: 1000000 });
    verifyTranscript(item.transcript, JSON.parse(stdout));
  }
  const headers = { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') };
  const response = await fetch(server + '/api/session?directory=' + encodeURIComponent(directory), { headers });
  assert.equal(response.status, 200);
  const list = await response.json();
  for (const item of expected) assert.ok(list.data.some(session => session.id === item.sessionID));
  assert.equal((await store.rollback(report.id)).status, 'rolled-back');
  t.diagnostic('HTTP import=PASS; CLI same-server export=PASS; GUI session-list API=PASS; HTTP rollback=PASS');
});
