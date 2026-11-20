import { spawnSync, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function localReleasePlan(platform = process.platform, arch = process.arch) {
  const plans = {
    'darwin-arm64': { name: 'macos-arm64', bundles: 'app,dmg', extensions: ['.dmg'] },
    'darwin-x64': { name: 'macos-x64', bundles: 'app,dmg', extensions: ['.dmg'] },
    'win32-x64': { name: 'windows-x64', bundles: 'nsis', extensions: ['.exe'] },
    'linux-x64': { name: 'linux-x64', bundles: 'deb,rpm,appimage', extensions: ['.deb', '.rpm', '.AppImage'] },
  };
  const plan = plans[`${platform}-${arch}`];
  if (!plan) throw new Error(`本地构建尚未配置 ${platform}/${arch}`);
  return plan;
}

export function verifySourceIdentity(expected, current, status) {
  if (expected !== current || status.trim()) throw new Error('构建期间源码已变化，请提交改动后重新构建；本次不生成成功清单');
}

export async function collectLocalInstallers(input, output, plan, version, since = 0) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith('.app')) await walk(file);
      else if (entry.isFile() && plan.extensions.includes(path.extname(file))) files.push(file);
    }
  }
  await walk(input);
  const { stat } = await import('node:fs/promises');
  const selected = [];
  for (const extension of plan.extensions) {
    const candidates = [];
    for (const file of files.filter(file => path.extname(file) === extension)) {
      // Never substitute an old version or stale cached installer for this build.
      const name = path.basename(file);
      // Tauri RPM uses product-version-release.arch.rpm, unlike the underscore formats.
      const rpmStem = name.replace(/-[^-]+\.[^.]+\.rpm$/, '');
      const matchingVersion = extension === '.rpm' ? rpmStem !== name && rpmStem.endsWith(`-${version}`) : name.split('_').includes(version);
      if (matchingVersion && (await stat(file)).mtimeMs >= since) candidates.push(file);
    }
    if (candidates.length !== 1) throw new Error(`需要本次构建的 ${version} ${extension} 安装包，实际找到 ${candidates.length} 份`);
    selected.push(candidates[0]);
  }
  const names = selected.map(file => path.basename(file).replace(/[^A-Za-z0-9._-]/g, '.'));
  if (new Set(names).size !== names.length) throw new Error('本地安装包名称冲突');
  await mkdir(output, { recursive: true });
  for (const [index, file] of selected.entries()) await copyFile(file, path.join(output, names[index]));
  return names;
}

export async function writeChecksums(dir) {
  const names = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name !== 'SHA256SUMS.txt').map(entry => entry.name).sort();
  const rows = [];
  for (const name of names) rows.push(`${createHash('sha256').update(await readFile(path.join(dir, name))).digest('hex')}  ${name}`);
  await writeFile(path.join(dir, 'SHA256SUMS.txt'), rows.join('\n') + '\n');
  return names;
}

async function main() {
  const plan = localReleasePlan();
  if (process.argv.slice(2).some(arg => arg !== '--plan')) throw new Error('用法：npm run release:local [-- --plan]');
  if (process.argv.includes('--plan')) {
    console.log(`local-release plan: ${plan.name}; bundles=${plan.bundles}; GitHub Actions=not used`);
    return;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  process.chdir(root);
  if (!process.env.npm_execpath) throw new Error('请通过 npm run release:local 执行');
  const env = { ...process.env, CARGO_TARGET_DIR: path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target') };
  if (process.platform === 'linux') env.APPIMAGE_EXTRACT_AND_RUN ||= '1';
  const steps = [];
  function run(command, args, options = {}) {
    console.log(`\n[local-release] ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`本地构建步骤失败：${command}，exit=${result.status}, signal=${result.signal}`);
    steps.push({ command: path.basename(command), args, exit: 0 });
  }
  const npm = args => run(process.execPath, [process.env.npm_execpath, ...args]);
  const capture = (command, args) => execFileSync(command, args, { cwd: root, env, encoding: 'utf8' }).trim();
  const host = capture('rustc', ['-vV']).match(/^host: (.+)$/m)?.[1];
  for (const key of ['CARGO_BUILD_TARGET', 'TAURI_ENV_TARGET_TRIPLE']) {
    if (env[key] && env[key] !== host) throw new Error(`${key} 必须与当前主机 ${host} 一致；本命令只产出本机安装包`);
  }
  // CLI should resolve the host build at <target-dir>/release, even when the caller set a host override.
  delete env.CARGO_BUILD_TARGET;
  delete env.TAURI_ENV_TARGET_TRIPLE;
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const tauri = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  if (version !== tauri.version) throw new Error('npm / Tauri 版本不一致');
  const nativeBins = [env.OPENCODE_V1_BIN, env.OPENCODE_V2_BIN];
  if (nativeBins.some(Boolean) && !nativeBins.every(Boolean)) throw new Error('双代原生回归需同时设置 OPENCODE_V1_BIN 与 OPENCODE_V2_BIN');
  const commit = capture('git', ['rev-parse', 'HEAD']);
  if (capture('git', ['status', '--porcelain'])) throw new Error('请先提交源码再打包，以便安装包精确追溯提交；不会自动提交或清理改动');
  for (const task of ['check', 'test', 'test:package']) npm(['run', task]);
  run('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml']);
  const started = Date.now();
  npm(['run', 'desktop:build', '--', '--bundles', plan.bundles, '--ci', '--', '--locked']);
  const bundle = path.join(env.CARGO_TARGET_DIR, 'release/bundle');
  const app = path.join(bundle, 'macos', `${tauri.productName}.app`);
  const sidecar = process.platform === 'darwin' ? path.join(app, 'Contents/MacOS/migrate-backend') : path.join(root, 'src-tauri/binaries', `migrate-backend-${host}${process.platform === 'win32' ? '.exe' : ''}`);
  env.DSH_OC_TEST_SIDECAR = sidecar;
  run(process.execPath, ['--test', '--test-name-pattern=sidecar JSONL', 'test/desktop.test.mjs']);
  if (nativeBins.every(Boolean)) {
    env.DSH_NATIVE_APP_ROOT = root;
    npm(['run', 'test:integration']);
  }
  const verifySource = () => verifySourceIdentity(commit, capture('git', ['rev-parse', 'HEAD']), capture('git', ['status', '--porcelain']));
  verifySource();
  const releases = path.join(root, 'artifacts/releases');
  await mkdir(releases, { recursive: true });
  const staging = await mkdtemp(path.join(releases, '.local-build-'));
  try {
    const names = await collectLocalInstallers(bundle, staging, plan, version, started - 2000);
    if (process.platform === 'darwin') {
      const plist = capture('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')]);
      if (plist !== version) throw new Error('原生 .app 版本不一致');
      run('codesign', ['--verify', '--deep', '--strict', app]);
      run('hdiutil', ['verify', path.join(staging, names.find(name => name.endsWith('.dmg')))]);
      run('tar', ['-czf', path.join(staging, `DSH.OpenCode.Migrate_${version}_${plan.name}.app.tar.gz`), '-C', path.dirname(app), path.basename(app)], { env: { ...env, COPYFILE_DISABLE: '1' } });
    }
    await copyFile('src-tauri/resources/dsh-oc-migrate-plugin.tgz', path.join(staging, `dsh-oc-migrate-${version}.tgz`));
    if (process.platform === 'linux') await copyFile('scripts/start-linux.sh', path.join(staging, 'start-linux.sh'));
    verifySource();
    await writeFile(path.join(staging, 'BUILD-MANIFEST.json'), JSON.stringify({ version, commit, sourceDirty: false, platform: plan.name, rustHost: host, builtAt: new Date().toISOString(), githubActionsUsed: false, nativeRegression: nativeBins.every(Boolean) ? 'passed' : 'not run (provide both OPENCODE_V1_BIN and OPENCODE_V2_BIN)', signing: process.platform === 'darwin' ? 'app ad-hoc; no Apple notarization claimed' : 'no installer signing claimed', steps }, null, 2) + '\n');
    await writeChecksums(staging);
    const destination = path.join(releases, `v${version}-${plan.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await rename(staging, destination);
    console.log(`\nlocal-release: PASS (${plan.name}; GitHub Actions=not used)\n${destination}`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
