import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createCliClient } from '../../packages/opencode-client/src/index.mjs';
import { MigrationStore } from '../../packages/middleware/src/store.mjs';
import { ReverseStore } from '../../packages/middleware/src/reverse.mjs';
import { captureLocalSession } from '../../packages/plugin/src/local-reader.mjs';
import { fixture } from '../fixture.mjs';
for (const [generation, binary] of [['v1', process.env.OPENCODE_V1_BIN], ['v2', process.env.OPENCODE_V2_BIN]]) {
  test(`真实 ${generation} 全项目与分支 → DSH 原生严格回放 → ${generation} 往返及回滚`, { skip: !binary, timeout: 300000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), `dsh-bidirectional-${generation}-`)); t.after(() => rm(root, { recursive: true, force: true }));
    const env = { HOME: root, XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_DB: path.join(root, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_PROJECT_CONFIG: '1' };
    const sources = [];
    for (const name of ['alpha', 'beta']) {
      const directory = path.join(root, name); await mkdir(directory);
      execFileSync('git', ['init', '-q', directory]); execFileSync('git', ['-C', directory, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', name]);
      const client = await createCliClient({ binary, generation, directory, env });
      const store = new MigrationStore({ state: path.join(root, name + '-jobs'), directory, client });
      const imported = await store.receive(fixture({ id: name }), { importNow: true }); assert.equal(imported.status, 'imported', imported.error);
      sources.push({ client, store, imported, directory });
    }
    const client = sources[0].client;
    const parent = sources[0].imported.sessions[0].sessionID;
    const childSource = fixture({ id: 'native-child' });
    const { convertBundle } = await import('../../packages/core/src/convert.mjs');
    const { atomicJSON } = await import('../../packages/middleware/src/store.mjs');
    const child = convertBundle(childSource, { generation, directory: sources[0].directory })[0].transcript;
    child.info.parentID = parent;
    const childFile = path.join(root, 'child.json'); await atomicJSON(childFile, child); await client.import(childFile, child);
    const all = await client.listAll({ pageSize: 1 }); assert.equal(all.length, 3); // Not limited to alpha's project.
    const reverse = new ReverseStore({ state: path.join(root, 'reverse-jobs'), dshRoot: path.join(root, 'sessions') });
    for (const info of all) {
      const original = await client.export(info.id); assert.ok(original);
      const report = await reverse.receive(original, { importNow: true }); assert.equal(report.status, 'imported', report.error);
      const { session } = await captureLocalSession({ file: report.sessions[0].file });
      if (process.env.DSH_NATIVE_APP_ROOT) {
        const load = name => import(pathToFileURL(path.join(process.env.DSH_NATIVE_APP_ROOT, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
        const { Context } = await load('cordis'), persistence = await load('dsh-session-persistence-jsonl'), { Session } = await load('dsh-session');
        const ctx = new Context(); const scope = ctx.plugin(persistence, { root: path.join(root, 'sessions'), compression: 'zstd' });
        try {
          await scope.await();
          assert.ok((await ctx.sessionPersistence.list()).some(row => row.header.id === session.header.id));
          const {checkpointRecord,SessionProjectionCache}=await load('dsh-session-projection-cache'),{SessionProjectionRegistry}=await load('dsh-session-projection'),{titleProjectionDefinition}=await load('dsh-session-title');
          const cached=JSON.parse(await (await import('node:fs/promises')).readFile(report.titleCache.file,'utf8'));assert.equal(cached.version,7);const record=checkpointRecord.parse(cached.record);
          const registry=new SessionProjectionRegistry(ctx);registry.register(titleProjectionDefinition);const reader=Object.create(SessionProjectionCache.prototype);reader.ctx=ctx;reader.table={get:()=>record};
          assert.equal(reader.cachedSnapshot(session.header,['title']).values.title,session.title);
          const handle = await ctx.sessionPersistence.open(session.header.id, 'read');
          try {
            const native = await handle.read();
            assert.equal(native.events.length, session.events.length);
            const restored = Session.fromRestore(session.header.id, native.events, structuredClone(handle.header), handle.inheritedEventCount, native.eventState);
            assert.ok(JSON.stringify(restored.deriveMessages()).includes('原始文件内容'));
          } finally { await handle.close(); }
        } finally { await scope.dispose(); }
        t.diagnostic('native DSH persistence 0.2.1-rc.2: cold list/title-cache/read/deriveMessages PASS');
      }
      const project = sources.find(s => s.imported.sessions[0].sessionID === info.id) ?? (info.id === child.info.id ? sources[0] : null); assert.ok(project);
      assert.equal(session.header.cwd, original.info.location?.directory ?? original.info.directory);
      const roundtrip = await project.store.receive({ format: 'dsh-oc-migrate', version: 1, sessions: [session] }, { importNow: true }); assert.equal(roundtrip.status, 'imported', roundtrip.error);
      const reread = await client.export(roundtrip.sessions[0].sessionID);
      assert.ok(JSON.stringify(reread).includes('原始文件内容')); assert.ok(JSON.stringify(reread).includes('先核对已有文件'));
      assert.equal((await reverse.receive(original, { importNow: true })).id, report.id);
      assert.equal((await reverse.rollback(report.id)).status, 'rolled-back');
      await project.store.rollback(roundtrip.id);
      assert.ok(await client.export(info.id));
    }
    await client.remove(child.info.id);
    for (const source of sources) await source.store.rollback(source.imported.id);
    assert.equal((await client.listAll()).length, 0);
    t.diagnostic(`${client.version}: all-project listing, native DSH codec, tool/reasoning/project roundtrip, dedup and rollback PASS`);
  });
}
