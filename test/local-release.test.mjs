import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { localReleasePlan, collectLocalInstallers, writeChecksums } from '../scripts/local-release.mjs';

test('本地构建只选择当前原生平台，不伪造四平台 Release', () => {
  assert.equal(localReleasePlan('darwin', 'arm64').bundles, 'app,dmg');
  assert.equal(localReleasePlan('darwin', 'x64').name, 'macos-x64');
  assert.equal(localReleasePlan('win32', 'x64').bundles, 'nsis');
  assert.deepEqual(localReleasePlan('linux', 'x64').extensions, ['.deb', '.rpm', '.AppImage']);
  assert.throws(() => localReleasePlan('linux', 'arm64'), /尚未配置/);
});

test('本地归集拒绝缺失、旧版本、过期缓存与重复安装包，不碰既有输出', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-local-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'bundle'), output = path.join(root, 'out');
  await mkdir(input);
  await mkdir(output);
  await writeFile(path.join(output, 'keep.txt'), 'previous release');
  const plan = localReleasePlan('darwin', 'arm64');
  await writeFile(path.join(input, 'DSH_0.5.7_arm64.dmg'), 'old');
  await assert.rejects(collectLocalInstallers(input, output, plan, '0.5.8'), /实际找到 0/);
  const current = path.join(input, 'DSH OpenCode_0.5.8_arm64.dmg');
  await writeFile(current, 'current');
  const now = Date.now();
  await utimes(current, 0, 0);
  await assert.rejects(collectLocalInstallers(input, output, plan, '0.5.8', now - 1000), /实际找到 0/);
  await utimes(current, now / 1000, now / 1000);
  assert.deepEqual(await collectLocalInstallers(input, output, plan, '0.5.8', now - 1000), ['DSH.OpenCode_0.5.8_arm64.dmg']);
  assert.equal(await readFile(path.join(output, 'keep.txt'), 'utf8'), 'previous release');
  await writeFile(path.join(input, 'duplicate_0.5.8_arm64.dmg'), 'duplicate');
  await assert.rejects(collectLocalInstallers(input, output, plan, '0.5.8'), /实际找到 2/);
});

test('本地校验清单可重复生成，包含真实文件哈希但不包含自身', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-local-checksum-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'installer.dmg'), 'native fixture');
  await mkdir(path.join(root, 'ignored'));
  const expected = createHash('sha256').update('native fixture').digest('hex') + '  installer.dmg\n';
  await writeChecksums(root);
  assert.equal(await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8'), expected);
  await writeChecksums(root);
  assert.equal(await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8'), expected);
  assert.equal((await readdir(root)).length, 3);
});
