import path from 'node:path';
export function binaryCandidates(home) {
  const gui = process.platform === 'darwin'
    ? ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', path.join(home, 'Applications/OpenCode.app/Contents/Resources/opencode-cli')]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'OpenCode/opencode-cli.exe'), path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs/OpenCode/opencode-cli.exe')]
      : ['/opt/OpenCode/opencode-cli', '/usr/lib/opencode/opencode-cli', path.join(home, '.local/bin/opencode')];
  return [...new Set([...gui, path.join(home, `.opencode/bin/opencode${process.platform === 'win32' ? '.exe' : ''}`), ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']), process.platform === 'win32' ? 'opencode.exe' : 'opencode'])];
}

