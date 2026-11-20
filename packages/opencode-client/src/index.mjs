import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonical, digest } from '../../core/src/protocol.mjs';

const execute = promisify(execFile);
// 只比较历史正文；原生导入会重绑 project、directory 并重新计算会话统计。
export function transcriptShape(transcript) {
  return { id: transcript.info.id, messages: transcript.messages.map(message => message.info ? {
    id: message.info.id, role: message.info.role,
    parts: message.parts.map(part => part.type === 'tool'
      ? { type: part.type, id: part.callID, name: part.tool, status: part.state.status, input: part.state.input, output: part.state.output ?? part.state.error }
      : { type: part.type, text: part.text }),
  } : { id: message.id, role: message.type, text: message.text, content: message.content?.map(part => part.type === 'tool'
    ? { type: part.type, id: part.id, name: part.name, status: part.state.status, input: part.state.input, content: part.state.content, error: part.state.error }
    : { type: part.type, text: part.text }) }) };
}
export function verifyTranscript(expected, actual) {
  if (canonical(transcriptShape(expected)) !== canonical(transcriptShape(actual))) throw new Error(`会话 ${expected.info.id} 回读不匹配：请保留任务原件检查，未标记导入成功`);
}
const parseJSON = stdout => {
  // 1.x 首次启动可能在 JSON 前输出迁移提示；仅接受实际 JSON 对象起点。
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('OpenCode 未返回 JSON transcript');
  return JSON.parse(stdout.slice(start));
};
const parseArray = stdout => {
  const start = stdout.search(/^\s*\[/m);
  if (start < 0) throw new Error('OpenCode 未返回 JSON 列表');
  const value = JSON.parse(stdout.slice(start));
  if (!Array.isArray(value)) throw new Error('OpenCode 列表格式异常');
  return value;
};


// No directory/project/parent/archive filter: include every project, fork and archive.
export async function listSessionPages(fetchPage) {
  const result = new Map(), cursors = new Set();
  let cursor;
  do {
    const page = await fetchPage(cursor);
    if (!Array.isArray(page?.data)) throw new Error('OpenCode 会话列表格式异常');
    for (const item of page.data) {
      if (typeof item.id !== 'string') throw new Error('OpenCode 会话列表缺少 id');
      if (result.has(item.id)) throw new Error('会话列表在读取期间变化，请在 OpenCode 空闲时重试');
      result.set(item.id, item);
    }
    if (page.cursor != null && (typeof page.cursor !== 'object' || Array.isArray(page.cursor))) throw new Error('OpenCode 会话分页格式异常');
    cursor = page.cursor?.next;
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('OpenCode 会话分页游标重复');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...result.values()];
}

export async function createCliClient(config) {
  const binary = config.binary ?? 'opencode';
  const env = { ...process.env, ...config.env };
  if (config.dataHome) env.XDG_DATA_HOME = config.dataHome;
  const run = async args => {
    try {
      return await execute(binary, args, { cwd: config.directory, env, timeout: config.timeout ?? 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      throw Object.assign(new Error(`OpenCode 命令失败 (${error.code}): ${error.stderr || error.stdout || error.message}`), { cause: error });
    }
  };
  const version = (await run(['--version'])).stdout.trim();
  const major = version.match(/(?:^|\s)v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?(?:$|\s)/)?.[1];
  const detected = major ? `v${major}` : undefined;
  if (!detected) throw new Error(`未验证的 OpenCode 版本：${version}`);
  const generation = config.generation && config.generation !== 'auto' ? config.generation : detected;
  if (generation !== detected) throw new Error(`目标版本 ${generation} 与二进制 ${version} 不一致`);
  const flags = generation === 'v1' ? ['--pure'] : ['--standalone'];
  const prefix = generation === 'v1' ? [] : ['session'];
  return {
    generation, version,
    identity: digest({ adapter: 'cli', binary, directory: config.directory, dataHome: env.XDG_DATA_HOME ?? '', db: env.OPENCODE_DB ?? '', generation }),
    async listProjects() {
      return generation === 'v1'
        ? parseArray((await run(['db', 'SELECT id, name, worktree FROM project ORDER BY id', '--format', 'json', ...flags])).stdout)
        : parseArray((await run(['api', 'GET', '/api/project', ...flags])).stdout);
    },
    async listAll({ pageSize = 100 } = {}) {
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('OpenCode 分页大小需要 1–100');
      if (generation === 'v2') return listSessionPages(async cursor => parseJSON((await run(['api', 'GET', `/api/session?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, ...flags])).stdout));
      const { stdout } = await run(['db', 'SELECT id, directory, parent_id, title, time_updated, time_archived FROM session ORDER BY id', '--format', 'json', ...flags]);
      const start = stdout.search(/^\s*\[/m);
      const rows = JSON.parse(stdout.slice(start));
      if (start < 0 || !Array.isArray(rows)) throw new Error('OpenCode 1.x 会话列表格式异常');
      return rows;
    },
    async export(sessionID) {
      try { return parseJSON((await run([...prefix, 'export', sessionID, ...flags])).stdout); }
      catch (error) {
        if (/(?:not found|does not exist|no session|NotFoundError)/i.test(error.message)) return null;
        throw error;
      }
    },
    async import(file, expected) {
      const existing = await this.export(expected.info.id);
      if (existing) { verifyTranscript(expected, existing); return { status: 'existing-verified' }; }
      const { stdout } = await run([...prefix, 'import', file, ...flags]);
      const actual = await this.export(expected.info.id);
      if (!actual) throw new Error('原生 import 结束后未找到会话');
      verifyTranscript(expected, actual);
      return { status: 'imported-verified', output: stdout.trim() };
    },
    async remove(sessionID) {
      await run(['session', 'delete', sessionID, ...flags]);
      if (await this.export(sessionID)) throw new Error(`删除后会话仍存在：${sessionID}`);
    },
    async assertNoChildren(sessionID) {
      if (!/^ses_[a-f0-9]{26}$/.test(sessionID)) throw new Error('回滚 session id 无效');
      // 1.x 没有通用 api CLI；只读查询原生数据库，不直接写表。
      const result = generation === 'v1'
        ? JSON.parse((await run(['db', `SELECT id FROM session WHERE parent_id = '${sessionID}' LIMIT 1`, '--format', 'json', '--pure'])).stdout.trim())
        : parseJSON((await run(['api', 'GET', `/api/session?parentID=${sessionID}&limit=1`, ...flags])).stdout).data;
      if (!Array.isArray(result)) throw new Error('子会话预检查返回格式异常');
      if (result.length) throw new Error(`会话 ${sessionID} 已有子会话，回滚保留该会话及其分支`);
    },
  };
}

export function createHttpClient(config) {
  const url = new URL(config.server);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('OpenCode server 应为不含凭据的 HTTP(S) origin');
  const headers = { 'content-type': 'application/json' };
  if (config.password) headers.authorization = `Basic ${Buffer.from(`${config.username ?? 'opencode'}:${config.password}`).toString('base64')}`;
  const request = async (route, init = {}) => fetch(new URL(route, url), { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(config.timeout ?? 120000) });
  return {
    generation: 'v2', version: 'v2-http',
    identity: digest({ adapter: 'http', server: url.origin, directory: config.directory, generation: 'v2' }),
    async listProjects() {
      const response = await request('/api/project');
      if (!response.ok) throw new Error(`OpenCode projects HTTP ${response.status}`);
      const value = await response.json();
      if (!Array.isArray(value)) throw new Error('OpenCode 项目列表格式异常');
      return value;
    },
    async listAll({ pageSize = 100 } = {}) {
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('OpenCode 分页大小需要 1–100');
      return listSessionPages(async cursor => {
        const response = await request(`/api/session?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!response.ok) throw new Error(`OpenCode list HTTP ${response.status}`);
        return response.json();
      });
    },
    async export(sessionID) {
      const response = await request(`/api/experimental/session/${encodeURIComponent(sessionID)}/export`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`OpenCode export HTTP ${response.status}`);
      const value = await response.json();
      return value.info ? value : value.data;
    },
    async import(_file, expected) {
      const response = await request('/api/experimental/session/import', { method: 'POST', body: JSON.stringify({ ...expected, location: { directory: config.directory } }) });
      if (!response.ok && response.status !== 409) throw new Error(`OpenCode import HTTP ${response.status}`);
      const actual = await this.export(expected.info.id);
      if (!actual) throw new Error('OpenCode HTTP 导入后未找到会话');
      verifyTranscript(expected, actual);
      return { status: response.status === 409 ? 'existing-verified' : 'imported-verified' };
    },
    async remove(sessionID) {
      const response = await request(`/api/session/${encodeURIComponent(sessionID)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error(`OpenCode delete HTTP ${response.status}`);
      if (await this.export(sessionID)) throw new Error('OpenCode 删除后会话仍存在');
    },
    async assertNoChildren(sessionID) {
      const response = await request(`/api/session?parentID=${encodeURIComponent(sessionID)}&limit=1`);
      if (!response.ok) throw new Error(`OpenCode 子会话预检查 HTTP ${response.status}`);
      const result = await response.json();
      if (!Array.isArray(result.data)) throw new Error('子会话预检查返回格式异常');
      if (result.data.length) throw new Error(`会话 ${sessionID} 已有子会话，回滚保留该会话及其分支`);
    },
  };
}
