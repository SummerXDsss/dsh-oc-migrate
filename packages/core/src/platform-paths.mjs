import path from 'node:path';
// Match DeepSeek Harness dsh-home-paths: DSH_HOME overrides ~/.dsh on every OS.
export function dshHome(home, { env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let configured = env.DSH_HOME;
  if (typeof configured !== 'string' || !configured.trim()) return p.join(home, '.dsh');
  if (configured === '~') configured = home;
  else if (/^~[\\/]/.test(configured)) configured = p.join(home, configured.slice(2));
  return p.resolve(cwd, configured);
}
