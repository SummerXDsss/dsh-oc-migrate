import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createDocsBridge, demoProjects, demoEntries, startReadmePreview } from '../scripts/readme-preview.mjs';

test('README 五张清晰截图均存在且本地文档链接有效，保留现有许可证说明', async () => {
  const root = new URL('../', import.meta.url), markdown = await readFile(new URL('README.md', root), 'utf8');
  const images = [...markdown.matchAll(/!\[[^\]]+\]\((docs\/images\/[^)]+\.png)\)/g)].map(m => m[1]);
  assert.equal(images.length, 5);
  let size = 0;
  for (const image of images) {
    const data = await readFile(new URL(image, root));
    assert.equal(data.subarray(1, 4).toString(), 'PNG');
    assert.equal(data.readUInt32BE(16), 1360);
    assert.ok(data.readUInt32BE(20) >= 900);
    assert.ok(data.length < 700000);
    size += data.length;
  }
  assert.ok(size < 1800000);
  for (const match of markdown.matchAll(/\]\(((?:docs\/|LICENSE|NOTICE)[^)]+|LICENSE|NOTICE)\)/g)) await readFile(new URL(match[1], root));
  assert.match(markdown, /文档演示 · 合成数据/);
  assert.match(markdown, /\*\*图片说明：\*\* 本文/);
  assert.match(markdown, /当前采用本地构建交付/);
  assert.match(markdown, /v0\.5\.9.*PolyForm Noncommercial/);
  assert.match(markdown, /v0\.5\.8 及更早版本/);
});

test('文档桥接只有合成数据和只读扫描预览，拒绝真实迁移与撤销', async () => {
  const storage = new Map(), context = { window: {}, localStorage: { setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) } };
  new vm.Script(createDocsBridge('reverse')).runInNewContext(context);
  assert.equal(storage.get('migration-direction'), 'oc-to-dsh');
  const invoke = context.window.__TAURI_INTERNALS__.invoke;
  const snapshot = await invoke('desktop_request', { method: 'snapshot' });
  assert.ok(snapshot.stateDirectory.startsWith('/demo/'));
  assert.equal(snapshot.quick, null);
  assert.equal(demoProjects.reduce((count, p) => count + p.count, 0), demoEntries.length);
  const plan = await invoke('desktop_request', { method: 'discoverQuick', payload: { direction: 'oc-to-dsh' } });
  assert.equal(plan.target.version, '2.3.2');
  assert.equal(plan.targets.length, 1);
  const catalog = await invoke('desktop_request', { method: 'scanCatalog' });
  assert.equal(catalog.entries.length, 8);
  assert.ok(catalog.entries.every(e => e.directory.startsWith('/demo/') && e.sourceID.startsWith('DEMO-')));
  for (const method of ['startQuick', 'startSelected', 'importFile', 'rollback', 'retry']) await assert.rejects(invoke('desktop_request', { method }), /文档演示/);
  assert.throws(() => createDocsBridge('unknown'), /未知文档视图/);
});

test('文档服务只绑定回环，固定资源与 CSP，无写入接口或任意文件读取', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'readme-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), '<head></head><body>fixture</body>');
  await writeFile(path.join(root, 'assets', 'demo.js'), '/* fixture */');
  const server = await startReadmePreview({ dist: root });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  assert.match(await page.text(), /\/__docs\/bridge\.js/);
  assert.match(page.headers.get('Content-Security-Policy'), /connect-src 'none'/);
  assert.equal((await fetch(origin + '/rpc', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(origin + '/package.json')).status, 404);
  assert.equal((await fetch(origin + '/?view=unknown')).status, 400);
  assert.equal((await fetch(origin + '/favicon.ico')).status, 204);
  assert.equal((await fetch(origin + '/assets/demo.js')).status, 200);
});
