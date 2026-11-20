import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';

export const nonEmpty = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
export async function canonicalDirectory(directory) {
  if (!directory || !path.isAbsolute(directory)) return directory || '';
  try { return await realpath(directory); } catch { return path.normalize(directory); }
}
// Titles are persisted in session/title, whereas workspace display names live in
// the separate workspace v2 registry. Neither is reliably a directory basename.
export async function readDshWorkspaces(sourceRoot) {
  const file = path.join(path.dirname(sourceRoot), 'storages/workspace.json');
  try {
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('工作区元数据超过 8 MiB');
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.unit?.name !== 'workspace' || data.unit.version !== 2 || !data.tables?.workspaces || Array.isArray(data.tables.workspaces)) throw new Error('工作区元数据格式未识别');
    const records = [];
    for (const [id, record] of Object.entries(data.tables.workspaces)) {
      if (!record || !path.isAbsolute(record.path || '') || !Array.isArray(record.sessionIds)) throw new Error('工作区记录缺少路径或对话列表');
      records.push({ id, directory: await canonicalDirectory(record.path), name: nonEmpty(record.title), sessions: record.sessionIds.filter(id => typeof id === 'string') });
    }
    return { file, records };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, records: [] };
    return { file, records: [], error: error.message };
  }
}
export function workspaceFor(records, sourceID, directory) {
  const attached = records.find(record => record.sessions.includes(sourceID));
  if (attached) return attached;
  return records.filter(record => {
    const relative = path.relative(record.directory, directory);
    return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }).sort((a, b) => b.directory.length - a.directory.length)[0];
}
export function conversationLabel(title, messages, sourceID) {
  if (nonEmpty(title)) return { title: nonEmpty(title), titleOrigin: 'source' };
  const first = messages.find(message => message.role === 'user' && nonEmpty(message.text));
  if (first) {
    const text = first.text.replace(/\s+/g, ' ').trim(), characters = Array.from(text);
    return { title: characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : ''), titleOrigin: 'first-message' };
  }
  return { title: '空白对话 · ' + sourceID.slice(-8), titleOrigin: 'empty' };
}
