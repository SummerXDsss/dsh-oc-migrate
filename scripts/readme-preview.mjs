// Documentation-only preview: real built frontend, synthetic read-only data.
// This server never imports DesktopService or reads application/user history.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const demoProjects = [
  { id: 'website', name: '示例网站', directory: '/demo/projects/website', count: 3 },
  { id: 'docs', name: '文档工具', directory: '/demo/projects/docs', count: 3 },
  { id: 'todo', name: '待办应用', directory: '/demo/projects/todo', count: 2 },
];
const titles = ['整理登录页交互', '补齐深色模式', '检查表单提示', '核对历史格式映射', '整理使用教程', '记录接口约定', '修复列表滚动', '规划下一次迭代'];
export const demoEntries = titles.map((title, index) => {
  const project = demoProjects[index < 3 ? 0 : index < 6 ? 1 : 2];
  return { id: `demo-${index + 1}`, sourceID: `DEMO-SESSION-${String(index + 1).padStart(2, '0')}`, title, titleOrigin: 'source', projectID: project.id, directory: project.directory, messageCount: 4, eventCount: 6, starred: index === 0 || index === 3, updated: Date.parse('2026-11-20T12:00:00Z') - index * 3600000 };
});

export function createDocsBridge(view = 'workbench') {
  if (!['workbench', 'guide', 'reverse'].includes(view)) throw new Error('未知文档视图');
  const fixture = {
    projects: demoProjects, entries: demoEntries,
    jobs: [
      { id: 'demo-verified-01', direction: 'dsh-to-oc', generation: 'v2', status: 'imported', createdAt: '2026-11-20T12:30:00Z', sessions: [
        { sessionID: 'ses_demo_login', title: '整理登录页交互', status: 'verified' },
        { sessionID: 'ses_demo_theme', title: '补齐深色模式', status: 'verified' },
      ] },
      { id: 'demo-rollback-02', direction: 'oc-to-dsh', status: 'rolled-back', createdAt: '2026-11-19T09:00:00Z', sessions: [{ sessionID: 'demo_dsh_notes', title: '记录接口约定', status: 'rolled-back' }] },
    ],
  };
  return `(() => {
    const fixture = ${JSON.stringify(fixture)}, view = ${JSON.stringify(view)};
    localStorage.setItem('desktop-theme', 'dark');
    localStorage.setItem('migration-direction', view === 'reverse' ? 'oc-to-dsh' : 'dsh-to-oc');
    if (view === 'guide') localStorage.removeItem('migration-guide-v1');
    else localStorage.setItem('migration-guide-v1', 'done');
    let catalog = null, sequence = 0;
    const targets = [{ version: '1.18.31', generation: 'v1' }, { version: '2.3.2', generation: 'v2' }];
    const snapshot = () => ({ settings: {}, receiver: null, jobs: fixture.jobs, catalog, quick: null,
      stateDirectory: '/demo/migration-backups', tokenFile: '/demo/migration-backups/receiver.token', pluginFile: '/demo/dsh-oc-migrate-plugin.tgz' });
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return ++sequence; },
      async invoke(command, args = {}) {
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:event|unlisten') return;
        if (command !== 'desktop_request') throw new Error('这是文档演示页面，请在桌面应用中执行操作。');
        const { method, payload = {} } = args;
        if (method === 'snapshot') return snapshot();
        if (method === 'discoverQuick') return { total: fixture.entries.length, sourceRoot: payload.direction === 'oc-to-dsh' ? '/demo/opencode' : '/demo/deepseek-harness/sessions', directory: '/demo/projects', target: targets[1], targets: payload.direction === 'oc-to-dsh' ? [targets[1]] : targets, errors: [] };
        if (method === 'scanCatalog') {
          catalog = { id: 'demo-scan', direction: payload.direction || 'dsh-to-oc', input: {}, scannedAt: '2026-11-20T12:30:00Z', plan: { target: targets[1], targets, sourceRoot: '/demo/deepseek-harness/sessions' }, projects: fixture.projects, entries: fixture.entries, errors: [] };
          return catalog;
        }
        if (method === 'catalogPreview') return { id: payload.id, offset: 0, total: 4, messages: [
          { role: 'user', text: '请整理登录页交互：先核对表单提示，再检查深色模式。', active: true, seq: 1 },
          { role: 'assistant', text: '先检查现有页面结构与提示文案，保留已完成的修改。', active: true, seq: 2 },
          { role: 'tool', text: 'read_file · src/pages/login.tsx\\n已读取表单、输入校验与按钮状态。', active: true, seq: 3 },
          { role: 'assistant', text: '已整理三项检查：必填提示、提交状态、深色背景对比。', active: true, seq: 4 },
        ] };
        throw new Error('文档演示只提供扫描与预览；真实迁移请使用桌面应用。');
      }
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  })();`;
}

export async function startReadmePreview({ port = 0, dist = fileURLToPath(new URL('../desktop/dist', import.meta.url)) } = {}) {
  const index = await readFile(path.join(dist, 'index.html'), 'utf8');
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-ancestors 'none'");
      if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (url.pathname === '/') {
        const view = url.searchParams.get('view') || 'workbench';
        if (!['workbench', 'guide', 'reverse'].includes(view)) { response.writeHead(400); response.end('Unknown view'); return; }
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(index.replace('<head>', `<head><script src="/__docs/bridge.js?view=${view}"></script><link rel="stylesheet" href="/__docs/label.css">`)); return;
      }
      if (url.pathname === '/__docs/bridge.js') {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(createDocsBridge(url.searchParams.get('view') || 'workbench')); return;
      }
      if (url.pathname === '/__docs/label.css') {
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        response.end('body::after{content:"文档演示 · 合成数据";position:fixed;top:18px;left:50%;z-index:20;font:11px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;letter-spacing:.04em;color:#c8bfa8;padding:4px 10px;border:1px solid #46433b;border-radius:4px;background:#211f1b;pointer-events:none}*,*::before,*::after{animation:none!important;transition:none!important}'); return;
      }
      if (/^\/assets\/[\w.-]+\.(?:css|js)$/.test(url.pathname)) {
        response.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        response.end(await readFile(path.join(dist, url.pathname))); return;
      }
      response.writeHead(404); response.end();
    } catch { response.writeHead(500); response.end('Preview error'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--check')) {
    const images = ['workbench-dark', 'guide-dark', 'catalog-dark', 'reverse-dark', 'history-dark'];
    for (const image of images) {
      const file = new URL(`../docs/images/${image}.png`, import.meta.url);
      const data = await readFile(file);
      if (data.subarray(1, 4).toString() !== 'PNG' || (await stat(file)).size > 700000) throw new Error(`文档图片异常：${image}`);
    }
    console.log('readme-preview: PASS (5 screenshots; synthetic data; no live history)');
  } else {
    const server = await startReadmePreview({ port: Number(process.env.DOCS_PREVIEW_PORT || 0) });
    console.log(`README preview (synthetic data only): http://127.0.0.1:${server.address().port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  }
}
