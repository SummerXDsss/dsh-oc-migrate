import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from '../fixture.mjs';
import { createCliClient } from '../../packages/opencode-client/src/index.mjs';
import { MigrationStore, atomicJSON } from '../../packages/middleware/src/store.mjs';
import { convertBundle } from '../../packages/core/src/convert.mjs';

const exec = promisify(execFile);
const matrix = [
  { generation: 'v1', binary: process.env.OPENCODE_V1_BIN ?? 'opencode' },
  { generation: 'v2', binary: process.env.OPENCODE_V2_BIN },
];
for (const target of matrix) {
  test(`真实 OpenCode ${target.generation}: 隔离导入 / export 回读 / 幂等 / delete 回滚`, { skip: !target.binary, timeout: 300000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), `dsh-native-${target.generation}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'project');
    await mkdir(directory);
    const env = {
      HOME: root, DSH_HOME: path.join(root,'.dsh'), USERPROFILE: root, APPDATA: path.join(root,'roaming'), LOCALAPPDATA: path.join(root,'local'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
      OPENCODE_DB: path.join(root, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    };
    const config = { directory, binary: target.binary, generation: target.generation, env };
    const client = await createCliClient(config);
    const paths = await exec(target.binary, target.generation === 'v1' ? ['db', 'path', '--pure'] : ['debug', 'paths', 'db'], { env: { ...process.env, ...env }, cwd: directory, timeout: 120000 });
    assert.ok(paths.stdout.trim().includes(root), `数据库未隔离：${paths.stdout}`);
    t.diagnostic(`binary=${target.binary}; version=${client.version}; database isolated=true`);
    const store = new MigrationStore({ ...config, client, state: path.join(root, 'jobs') });
    const bundle = fixture();
    const compacted = fixture({ id: 'compacted-history', compact: true });
    bundle.sessions.push(...compacted.sessions);
    const failedTool = fixture({ id: 'failed-tool' });
    failedTool.sessions[0].events[6].data.message.isError = true;
    bundle.sessions.push(...failedTool.sessions);
    const report = await store.receive(bundle, { importNow: true });
    assert.equal(report.status, 'imported', report.error);
    assert.equal(report.sessions.length, 4);
    for (const item of report.sessions) {
      const result = await client.export(item.sessionID);
      assert.equal(result.info.id, item.sessionID);
      t.diagnostic(`${item.sessionID}: ${result.messages.length} messages verified`);
    }
    const duplicate = await store.receive({ ...bundle, exportedAt: 'later' }, { importNow: true });
    assert.equal(report.id, duplicate.id);
    const [child] = convertBundle(fixture({ id: 'user-created-child' }), { directory, generation: target.generation });
    child.transcript.info.parentID = report.sessions[0].sessionID;
    const childFile = path.join(root, 'child.json'); await atomicJSON(childFile, child.transcript);
    await client.import(childFile, child.transcript);
    await assert.rejects(store.rollback(report.id), /子会话/);
    assert.ok(await client.export(child.sessionID));
    await client.remove(child.sessionID);
    assert.equal((await store.rollback(report.id)).status, 'rolled-back');
    for (const item of report.sessions) assert.equal(await client.export(item.sessionID), null);
    t.diagnostic('import=PASS; export=PASS; idempotence=PASS; rollback=PASS; existing user history untouched');
  });
}
