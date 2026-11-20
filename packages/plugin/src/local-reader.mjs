// Read-only DSH v4 adapter. Physical layout and frame structure verified against:
// deepseek-ai/deepseek-harness@2e39e704, session-persistence-jsonl and session-format-v3-to-v4.
import { readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { dshLabel } from '../../core/src/labels.mjs';
import { zstdDecompressSync } from 'node:zlib';
import { FORMAT, foldSurface, validateBundle, digest } from '../../core/src/protocol.mjs';

export const MAX_LOG = 256 * 1024 * 1024;
// DSH appends independently checksummed Zstd frames. Some runtimes decompress
// only the first frame, so decode every frame explicitly rather than losing history.
export function decodeZstdFrames(bytes, limit = MAX_LOG) {
  let offset = 0, size = 0;
  const chunks = [];
  const need = count => { if (offset + count > bytes.length) throw new Error('日志尾部尚未写完，请等待 DSH 当前响应结束后重试'); };
  while (offset < bytes.length) {
    const start = offset;
    need(5);
    if (bytes.readUInt32LE(offset) !== 0xfd2fb528) throw new Error('Zstandard 日志帧无效');
    offset += 4;
    const descriptor = bytes[offset++];
    if (descriptor & 0x18) throw new Error('Zstandard 日志帧标志无效');
    const single = descriptor & 0x20, dictionary = descriptor & 3, flag = descriptor >>> 6;
    const extra = (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (flag === 0 ? (single ? 1 : 0) : 1 << flag);
    need(extra); offset += extra;
    for (;;) {
      need(3); const block = bytes.readUIntLE(offset, 3); offset += 3;
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error('Zstandard 日志块无效');
      const count = type === 1 ? 1 : block >>> 3;
      need(count); offset += count;
      if (block & 1) break;
    }
    if (descriptor & 4) { need(4); offset += 4; }
    if (size >= limit) throw new Error('单会话解压后超过读取上限（默认 256 MiB）');
    let output;
    try { output = zstdDecompressSync(bytes.subarray(start, offset), { maxOutputLength: limit - size }); }
    catch (error) { throw new Error(`日志帧解压失败或超过读取上限（默认 256 MiB）：${error.message}`); }
    size += output.length;
    if (size > limit) throw new Error('单会话解压后超过读取上限（默认 256 MiB）');
    chunks.push(output);
  }
  return Buffer.concat(chunks, size);
}

export function decodeLocalLog(bytes, compressed = false) {
  const decoded = compressed ? decodeZstdFrames(bytes) : bytes;
  if (decoded.length > MAX_LOG) throw new Error('单会话超过 256 MiB');
  const text = decoded.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('日志尾部尚未写完，请等待 DSH 当前响应结束后重试');
  const rows = text.trimEnd().split('\n').map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`日志第 ${index + 1} 行不是完整 JSON`); }
  });
  const physical = rows.shift();
  if (physical?.type !== 'session' || physical.version !== 4) throw new Error(`本地直读需要 DSH v4 日志，当前为 v${physical?.version ?? '未知'}；可在 DSH 打开旧会话完成升级后重试`);
  const { type: _, ...header } = physical;
  let inheritedEventCount = 0, marker = false;
  for (const event of rows) if (event.type === 'session/end-seed' && event.data?.inherited === true) { inheritedEventCount = event.seq; marker = true; }
  if (!!header.isSeeded !== marker) throw new Error('日志的继承边界与会话头不一致');
  const session = { header, inheritedEventCount, events: rows, surfaceEventSeqs: foldSurface(rows) };
  Object.assign(session, dshLabel(session));
  validateBundle({ format: FORMAT, version: 1, sessions: [session] });
  return session;
}

export async function findLocalSessions(root) {
  if (!path.isAbsolute(root)) throw new Error('DSH 数据位置需要绝对路径');
  const files = [], errors = [];
  async function walk(directory, depth) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') errors.push({ file: directory, error: error.message }); return; }
    const logs = entries.filter(item => item.isFile() && /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(item.name));
    if (logs.length) {
      const version = name => Number(name.match(/\.v(\d+)\./)?.[1] ?? 0);
      const latest = Math.max(...logs.map(item => version(item.name)));
      files.push({ file: path.join(directory, logs.filter(item => version(item.name) === latest).sort((a, b) => a.name.localeCompare(b.name))[0].name), alternatives: logs.filter(item => version(item.name) === latest).map(item => path.join(directory, item.name)), version: latest });
      return;
    }
    if (depth >= 6) return;
    for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') await walk(path.join(directory, item.name), depth + 1);
    }
  }
  await walk(root, 0);
  return { root, files, errors };
}

export async function captureLocalSession(item) {
  let captured;
  for (const file of item.alternatives ?? [item.file]) {
    const handle = await open(file, 'r');
    let bytes;
    try {
      const before = await handle.stat();
      if (before.size > MAX_LOG) throw new Error('单会话文件超过 256 MiB');
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('会话正在写入，请等待 DSH 当前响应结束后重试');
    } finally { await handle.close(); }
    const session = decodeLocalLog(bytes, file.endsWith('.zstd'));
    if (captured && digest(session) !== digest(captured.session)) throw new Error('同一会话存在两份不一致的日志编码，请在 DSH 检查后重试');
    captured = { session, bytes, file, hash: digest(bytes) };
  }
  return captured;
}
