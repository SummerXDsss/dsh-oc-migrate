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
  await writeFile(path.join(input, 'dmg', 'arm.dmg'), 'fixture');
  await assert.rejects(collectRelease(input, output), /Expected 5/);
  for (const name of ['intel.dmg', 'win.exe', 'linux.deb', 'linux.AppImage']) await writeFile(path.join(input, name), 'fixture');
  assert.equal((await collectRelease(input, output)).length, 5);
  assert.equal((await readdir(output)).length, 5);
  await writeFile(path.join(input, 'dmg', 'win.exe'), 'fixture');
  await assert.rejects(collectRelease(input, output), /collision/);
});
