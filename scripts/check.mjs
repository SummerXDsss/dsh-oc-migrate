import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
async function check(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = `${dir}/${item.name}`;
    if (item.isDirectory()) await check(file);
    else if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
for (const dir of ['bin', 'packages', 'scripts', 'test']) await check(dir);
console.log('syntax: PASS');
