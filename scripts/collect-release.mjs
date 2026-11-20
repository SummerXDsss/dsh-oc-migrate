import { readdir, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export async function collectRelease(input, output) {
  const files = [], counts = { '.dmg': 0, '.exe': 0, '.deb': 0, '.AppImage': 0 };
  // GitHub rewrites spaces in uploaded asset names. Normalize before checksums
  // so SHA256SUMS refers to the actual downloadable filenames.
  const assetName = file => path.basename(file).replace(/[^A-Za-z0-9._-]/g, '.');
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && Object.hasOwn(counts, path.extname(file))) files.push(file);
    }
  }
  await walk(input);
  const names = new Set();
  for (const file of files) {
    const name = assetName(file);
    if (names.has(name)) throw new Error(`Release asset name collision: ${name}`);
    names.add(name); counts[path.extname(file)]++;
  }
  if (counts['.dmg'] !== 2 || counts['.exe'] !== 1 || counts['.deb'] !== 1 || counts['.AppImage'] !== 1) {
    throw new Error(`Expected 5 installers across 4 platforms: ${JSON.stringify(counts)}`);
  }
  await mkdir(output, { recursive: true });
  for (const file of files) await copyFile(file, path.join(output, assetName(file)));
  return files.map(assetName).sort();
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = await collectRelease(process.argv[2], process.argv[3]);
  console.log(`release-assets: PASS (${files.length} installers, flat layout)`);
}
