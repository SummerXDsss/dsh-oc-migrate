import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { embedDshVersion } from './bun-compat.mjs';
const [target, outfile] = process.argv.slice(2);
let embedded = 0;
const result = await Bun.build({
  entrypoints: ['packages/desktop/src/service.mjs'],
  compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false },
  plugins: [{ name: 'embed-pinned-dsh-package-version', setup(build) {
    build.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, async ({ path: file }) => {
      const metadata = JSON.parse(await readFile(path.join(path.dirname(file), '../package.json'), 'utf8'));
      const contents = embedDshVersion(await readFile(file, 'utf8'), metadata.version); embedded++;
      return { contents, loader: 'js' };
    });
  } }],
});
if (!result.success || embedded !== 1) throw new Error(`sidecar build failed: embedded=${embedded}; ${result.logs.join('\n')}`);
console.log(`sidecar compiled: ${target}; DSH package identity embedded=${embedded}`);
