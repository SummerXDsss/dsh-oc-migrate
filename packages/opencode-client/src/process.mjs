import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Some native CLIs exit before a pipe drains (large JSON becomes a valid prefix
// followed by EOF). A private regular-file stdout is synchronous for those CLIs.
export async function executeToFile(binary, args, { cwd, env, timeout = 120000, maxBuffer = 64 * 1024 * 1024, windowsHide = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-oc-output-'));
  const file = path.join(root, 'stdout');
  let handle, child, timer, monitor, force, failure;
  const chunks = []; let stderrBytes = 0;
  const stop = error => {
    if (failure) return;
    failure = error; child.kill();
    force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref();
  };
  try {
    handle = await open(file, 'wx', 0o600);
    child = spawn(binary, args, { cwd, env, windowsHide, stdio: ['ignore', handle.fd, 'pipe'] });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) chunks.push(chunk);
      else stop(Object.assign(new Error('OpenCode stderr 超过输出上限'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
    });
    if (timeout > 0) timer = setTimeout(() => stop(Object.assign(new Error('OpenCode 命令超时'), { code: 'ETIMEDOUT' })), timeout);
    monitor = setInterval(() => { stat(file).then(s => { if (s.size > maxBuffer) stop(Object.assign(new Error('OpenCode stdout 超过输出上限'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })); }).catch(() => {}); }, 25);
    monitor.unref();
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const stderr = Buffer.concat(chunks).toString('utf8');
    if (failure) throw Object.assign(failure, { stderr });
    if (code !== 0) throw Object.assign(new Error(`OpenCode exit ${code}`), { code, stderr });
    if ((await stat(file)).size > maxBuffer) throw Object.assign(new Error('OpenCode stdout 超过输出上限'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr });
    return { stdout: await readFile(file, 'utf8'), stderr };
  } finally {
    clearTimeout(timer); clearTimeout(force); clearInterval(monitor);
    await handle?.close(); await rm(root, { recursive: true, force: true });
  }
}
