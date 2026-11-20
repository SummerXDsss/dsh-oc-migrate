import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectRelease } from '../scripts/collect-release.mjs';
test('Release 归集四平台嵌套 artifacts，缺失或重名时阻止发布', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'download'), output = path.join(root, 'assets');
  await mkdir(path.join(input, 'dmg'), { recursive: true });
  await writeFile(path.join(input, 'dmg', 'DSH OpenCode arm.dmg'), 'fixture');
  await assert.rejects(collectRelease(input, output), /Expected 6/);
  for (const name of ['intel.dmg', 'win.exe', 'linux.deb', 'linux.AppImage', 'linux.rpm']) await writeFile(path.join(input, name), 'fixture');
  assert.equal((await collectRelease(input, output)).length, 6);
  assert.equal((await readdir(output)).length, 6);
  assert((await readdir(output)).includes('DSH.OpenCode.arm.dmg'));
  await writeFile(path.join(input, 'dmg', 'win.exe'), 'fixture');
  await assert.rejects(collectRelease(input, output), /collision/);
});

test('发布版本在 npm、CLI、Tauri 与 Rust 中保持一致，标题体现双向', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
  const pkg = JSON.parse(await read('package.json')), lock = JSON.parse(await read('package-lock.json'));
  const tauri = JSON.parse(await read('src-tauri/tauri.conf.json'));
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(tauri.version, pkg.version);
  assert.ok((await read('src-tauri/Cargo.toml')).includes(`version = "${pkg.version}"`));
  assert.ok((await read('src-tauri/Cargo.lock')).includes(`name = "dsh-oc-migrate-desktop"\nversion = "${pkg.version}"`));
  assert.ok((await read('bin/dsh-oc-migrate.mjs')).includes(`dsh-oc-migrate ${pkg.version} —`));
  assert.ok((await read('desktop/src/navigation.ts')).includes(`APP_VERSION = '${pkg.version}'`));
  assert.equal(tauri.app.windows[0].title, 'DSH ↔ OpenCode');
  assert.match(await read('desktop/index.html'), /<title>DSH ↔ OpenCode<\/title>/);
});
