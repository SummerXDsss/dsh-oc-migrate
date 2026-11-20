import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
const unique = values => [...new Set(values.filter(Boolean))];
export function desktopCliRoots(home, { platform = process.platform, env = process.env } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const data = platform === 'win32' ? env.APPDATA || p.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? p.join(home, 'Library', 'Application Support')
    : env.XDG_CONFIG_HOME || p.join(home, '.config');
  return [p.join(data, 'ai.opencode.desktop', 'cli')];
}
export function binaryCandidates(home, { platform = process.platform, env = process.env } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const local = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
  const gui = platform === 'darwin'
    ? ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', p.join(home, 'Applications/OpenCode.app/Contents/Resources/opencode-cli')]
    : platform === 'win32'
      ? [p.join(local, 'Programs', 'ai.opencode.desktop', 'resources', 'opencode-cli.exe'),
        ...[p.join(local, 'OpenCode'), p.join(local, 'Programs', 'OpenCode'), env.ProgramFiles && p.join(env.ProgramFiles, 'OpenCode')].filter(Boolean).flatMap(root => [p.join(root, 'resources', 'opencode-cli.exe'), p.join(root, 'opencode-cli.exe')])]
      : ['/opt/OpenCode/resources/opencode-cli', '/opt/opencode/resources/opencode-cli', '/opt/ai.opencode.desktop/resources/opencode-cli', '/usr/lib/opencode/resources/opencode-cli', '/usr/lib64/opencode/resources/opencode-cli', '/opt/OpenCode/opencode-cli', '/usr/lib/opencode/opencode-cli'];
  const npmRoots = platform === 'win32' ? unique([env.APPDATA && p.join(env.APPDATA, 'npm'), env.NPM_CONFIG_PREFIX, env.npm_config_prefix, p.join(home, 'AppData', 'Roaming', 'npm')]) : [];
  return unique([...gui, p.join(home, '.opencode', 'bin', platform === 'win32' ? 'opencode.exe' : 'opencode'),
    ...npmRoots.flatMap(root => ['@opencode/cli', 'opencode-ai'].map(pkg => p.join(root, 'node_modules', pkg, 'bin', 'opencode.exe'))),
    ...(platform === 'win32' ? [p.join(home, 'scoop', 'shims', 'opencode.exe')] : [p.join(home, '.local', 'bin', 'opencode'), p.join(home, '.npm-global', 'bin', 'opencode'), '/usr/local/bin/opencode', '/usr/bin/opencode', ...(platform === 'darwin' ? ['/opt/homebrew/bin/opencode'] : [])]),
    platform === 'win32' ? 'opencode.exe' : 'opencode']);
}
// Electron 2.x stages its own CLI here even when the desktop app is not in PATH.
// Read only the known stable app's immediate version directories, never recurse.
export async function discoverBinaries(home, options = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const staged = [];
  const readDir = options.readDir ?? readdir, inspect = options.inspect ?? stat;
  for (const root of desktopCliRoots(home, options)) {
    let entries;
    try { entries = await readDir(root, { withFileTypes: true }); }
    catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; continue; }
    const versions = entries.filter(e => e.isDirectory() && /^\d+\.\d+\.\d+(?:-(?:x64|arm64))?$/.test(e.name) && (!/-(?:x64|arm64)$/.test(e.name) || e.name.endsWith('-' + arch))).sort((a,b) => b.name.localeCompare(a.name, 'en', {numeric:true}));
    for (const entry of versions) {
      const file = p.join(root, entry.name, platform === 'win32' ? 'opencode-cli.exe' : 'opencode-cli');
      try { if ((await inspect(file)).isFile()) staged.push(file); } catch { /* Incomplete/removed stage; installed candidates remain available. */ }
    }
  }
  return unique([...staged, ...binaryCandidates(home, options)]);
}
// npm's Windows .cmd/.ps1 shims are not executables. Resolve their installed native
// payload instead of enabling cmd.exe/shell interpolation for user-controlled args.
export async function resolveCliBinary(binary, { platform = process.platform, env = process.env, cwd = process.cwd(), inspect = stat } = {}) {
  if (platform !== 'win32' || !/\.(?:cmd|bat|ps1)$/i.test(binary)) return binary;
  const p = path.win32;
  if (!/^opencode\.(?:cmd|bat|ps1)$/i.test(p.basename(binary))) throw new Error('请选择 OpenCode 的原生可执行文件，不执行任意批处理脚本。');
  const roots = p.isAbsolute(binary) || /[\\/]/.test(binary) ? [p.dirname(p.resolve(cwd, binary))] : (env.PATH || env.Path || '').split(';').filter(Boolean);
  for (const root of roots) {
    const candidates = [p.join(root, 'opencode.exe'), ...[root, p.dirname(root)].flatMap(base => ['@opencode/cli', 'opencode-ai'].map(pkg => p.join(base, root.endsWith('.bin') ? '' : 'node_modules', pkg, 'bin', 'opencode.exe')))];
    for (const file of candidates) { try { if ((await inspect(file)).isFile()) return file; } catch { /* Try the other official package layout. */ } }
  }
  throw new Error('这个 Windows 脚本入口未找到对应原生程序；请选择 OpenCode 安装目录内的 opencode.exe 或 resources\\opencode-cli.exe。');
}
