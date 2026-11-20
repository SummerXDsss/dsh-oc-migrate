import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-package-smoke-'));
const run = (file, args, cwd = root) => execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 1000000 });
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp]));
  run('npm', ['install', '--prefix', temp, path.join(temp, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(run(process.execPath, ['--input-type=module', '-e', "const p=await import('dsh-oc-migrate'); if(p.name!=='dsh-oc-migrate'||typeof p.apply!=='function'||!p.Config)process.exit(1);console.log('plugin-entry: PASS')"], temp).trim(), 'plugin-entry: PASS');
  const cli = path.join(temp, 'node_modules', 'dsh-oc-migrate', 'bin/dsh-oc-migrate.mjs');
  assert.match(run(process.execPath, [cli, '--help']), /DeepSeek Harness/);
  const directory = path.join(temp, 'project'); await mkdir(directory);
  for (const generation of ['v1', 'v2']) {
    const out = path.join(temp, generation);
    run(process.execPath, [cli, 'convert', path.join(root, 'examples/synthetic-export.json'), '--directory', directory, '--generation', generation, '--out', out]);
    assert.equal((await readdir(out)).filter(file => file.endsWith('.json')).length, 2);
  }
  console.log('package-smoke: PASS (plugin entry, executable CLI, v1/v2 conversion)');
} finally { await rm(temp, { recursive: true, force: true }); }
