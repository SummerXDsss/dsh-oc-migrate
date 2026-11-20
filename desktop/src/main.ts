import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import './style.css';
import { catalogHTML, newCatalogView, filteredEntries, directionControlHTML, normalizeDirection, quickInputFor, resolveConversationIDs, selectionPayload, type Catalog, type Preview } from './catalog';

type Job = { direction?: string; id: string; status: string; generation?: string; createdAt?: string; error?: string; workspace?: { warning?: string }; projectNames?: { warning?: string }[]; sessions?: { sessionID: string; title?: string; status: string; view?: string; warnings?: string[] }[] };
type QuickRun = { selected?: boolean; direction?: string; id: string; status: string; stage: string; total: number; finished: number; imported: number; nativeSessions: number; skipped: number; errors: {file?: string; error: string}[]; target: {version: string}; jobs: {id?: string}[] };
type QuickPlan = {total: number; sourceRoot: string; directory: string; target: null | {binary: string; version: string}; errors: {error: string}[] };
type Snapshot = { catalog?: Catalog | null; quick?: QuickRun | null; settings: Record<string, unknown>; receiver: null | { url: string; autoImport: boolean; version: string; directory: string }; jobs: Job[]; stateDirectory: string; tokenFile: string; pluginFile: string | null };
let theme = localStorage.getItem('desktop-theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
const root = document.querySelector<HTMLDivElement>('#app')!;
let state: Snapshot = { settings: {}, receiver: null, jobs: [], stateDirectory: '', tokenFile: '', pluginFile: null };
let direction = normalizeDirection(localStorage.getItem('migration-direction'));
const rememberDirection = () => localStorage.setItem('migration-direction', direction);
let catalogView = newCatalogView(), scanProgress = '';
let previewRequest = 0;
let plan: QuickPlan | null = null, probing = false;
let page = 'migrate', busy = false, connected = '', notice = '', isError = false, selected = '';
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]!);
const icons: Record<string, string> = { arrow: '<path d="M4 8h14m-4-4 4 4-4 4M20 16H6m4-4-4 4 4 4"/>', inbox: '<path d="M4 4h16v16H4zM4 14h5l1 3h4l1-3h5"/>', history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2"/>', plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8zm6 9v4"/>', folder: '<path d="M3 6h7l2 3h9v11H3z"/>', check: '<path d="m5 12 4 4L19 6"/>', chevron: '<path d="m9 5 7 7-7 7"/>', refresh: '<path d="M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6m-5 5a8 8 0 0 0 14 4l3-3m0 6v-6h-6"/>' };
const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.arrow}</svg>`;
const statusName: Record<string, string> = { received: '等待导入', importing: '导入中', imported: '已回读验证', failed: '需要处理', 'rolled-back': '已回滚', incomplete: '记录不完整', verified: '已验证', pending: '待导入', 'preserved-existing': '保留已有会话' };
const rpc = <T = unknown>(method: string, payload = {}): Promise<T> => invoke('desktop_request', { method, payload });
const val = (id: string) => (document.getElementById(id) as HTMLInputElement)?.value ?? '';
const checked = (id: string) => (document.getElementById(id) as HTMLInputElement)?.checked ?? false;
const setting = (key: string, fallback = '') => esc(state.settings[key] ?? fallback);
const input = (id: string, label: string, value: string, placeholder: string, browse?: string) => `<label class="field" for="${id}"><span>${label}</span><div class="input-row"><input id="${id}" value="${value}" placeholder="${placeholder}" autocomplete="off" spellcheck="false">${browse ? `<button class="icon-button" type="button" data-action="browse" data-field="${id}" data-kind="${browse}" aria-label="选择${label}">${icon('folder')}</button>` : ''}</div></label>`;
function quickInput() { return quickInputFor(state.settings, direction); }
async function probeQuick() { const payload = quickInput(); probing = true; plan = null; render(); try { plan = await rpc<QuickPlan>('discoverQuick', payload); } catch (error) { notice = String(error); isError = true; } finally { probing = false; render(); } }
function config() {
  const draft = { ...state.settings };
  for (const id of ['directory', 'binary', 'generation', 'server', 'dataHome', 'passwordFile', 'sourceRoot', 'dshRoot']) {
    const field = document.getElementById(id) as HTMLInputElement | null;
    if (field) draft[id] = field.value;
  }
  for (const [id, key] of [['archive', 'includeArchive'], ['snapshots', 'stateSnapshots'], ['customQuick', 'customQuick']]) {
    const field = document.getElementById(id) as HTMLInputElement | null;
    if (field) draft[key] = field.checked;
  }
  return draft;
}
function render() {
  const count = state.jobs.filter(j => j.status === 'imported').length;
  root.innerHTML = `<aside class="sidebar"><a class="brand" href="#" data-action="nav" data-page="migrate"><span class="brand-mark">${icon('arrow')}</span><span>对话搬家<small>DSH ↔ OpenCode</small></span></a><div class="nav-label">工作区</div><nav aria-label="主导航">${[['migrate', 'inbox', '迁移工作台'], ['catalog', 'folder', '项目与对话'], ['jobs', 'history', '迁移记录'], ['plugin', 'plug', '高级连接']].map(([id, glyph, label]) => `<button data-action="nav" data-page="${id}" class="nav-item ${page === id ? 'active' : ''}" ${page === id ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span>${id === 'jobs' && state.jobs.length ? `<b>${state.jobs.length}</b>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><button class="theme-button" data-action="theme">${theme === 'dark' ? '☼ 浅色外观' : '◐ 深色外观'}</button><div class="local-indicator"><i></i> 全程在本机处理</div><p>原始记录留存 · 导入可回滚</p><div class="version">DESKTOP <span>v0.5.4 · Tauri</span></div></div></aside><main><header class="topbar"><span>DeepSeek Harness <span class="route-arrow">↔</span> OpenCode</span><span class="pill ${state.receiver ? 'live' : ''}"><i></i>${state.receiver ? '插件接收中' : state.quick?.status === 'running' ? '正在迁移' : '本机直读 · 无需连接'}</span></header><div class="content"><div class="page-heading"><div class="eyebrow">${page === 'migrate' ? 'YOUR CONTEXT, CONTINUED' : page === 'catalog' ? 'CONTEXT LIBRARY' : page === 'jobs' ? 'MIGRATION JOURNAL' : 'CONNECT THE SOURCE'}</div><h1>${page === 'migrate' ? '换个工具，继续对话。' : page === 'catalog' ? '你的项目，你的对话。' : page === 'jobs' ? '每次迁移，都有迹可循。' : '把 DSH 的上下文带过来。'}</h1><p>${page === 'migrate' ? '选一个方向，一键搬走本机对话。不用填写连接信息，原工具的历史仍然保留。' : page === 'catalog' ? '先扫描，再选择。按项目整理，读过以后再搬走。' : page === 'jobs' ? '查看真实导入状态、回读结果，或回滚尚未继续的迁移会话。' : '本机对话请用一键迁移；远程 DSH 或最新内存截面可用插件接收。'}</p></div>${notice ? `<div class="notice ${isError ? 'error' : 'success'}" role="${isError ? 'alert' : 'status'}"><span>${esc(notice)}</span><button data-action="dismiss" aria-label="关闭提示">×</button></div>` : ''}${page === 'migrate' ? migrate() : page === 'catalog' ? catalogHTML(state.catalog?.direction === direction ? state.catalog : null, catalogView, state.quick?.status === 'running' || probing, direction) : page === 'jobs' ? jobs() : plugin()}<footer><span>${icon('check')} OpenCode 1.x / 2.x 原生格式</span><span>${count} 个任务已回读验证</span></footer></div></main><div class="working" ${busy ? '' : 'hidden'} role="status"><span class="spinner"></span>${esc(scanProgress || '正在处理，请稍候…')}</div>`;
  root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { if (busy && !['nav', 'dismiss'].includes(button.dataset.action || '')) button.disabled = true; });
}
function migrate() {
  const run = state.quick, running = run?.status === 'running', reverse = direction === 'oc-to-dsh';
  const ready = plan?.target && plan.total > 0;
  return `${directionControlHTML(direction, !!running || probing)}<section class="quick-migrate"><div class="quick-route"><div><span class="eyebrow">从这里出发</span><h2>${reverse ? 'OpenCode' : 'DeepSeek Harness'}</h2><p>${probing ? '正在查找本机对话…' : plan ? `找到 ${plan.total} 个${reverse ? '全项目' : '本地'}对话${reverse && plan.target ? ` · ${esc(plan.target.version)}` : ''}` : '自动读取本机对话'}</p></div><span class="transfer-arrow">${icon('arrow')}</span><div><span class="eyebrow">继续对话</span><h2>${reverse ? 'DeepSeek Harness' : 'OpenCode'}</h2><p>${probing ? '正在识别已安装版本…' : reverse ? '原生 v4 历史 · 自动识别存储位置' : plan?.target ? esc(plan.target.version) : '自动识别已安装的 1.x / 2.x'}</p></div></div><div class="quick-action"><button class="button primary one-click" data-action="${running ? 'cancelQuick' : 'startQuick'}" ${probing && !running ? 'disabled' : ''}>${running ? '停止迁移' : '一键迁移全部对话'}${icon(running ? 'history' : 'arrow')}</button>${!running ? `<button class="button secondary" data-action="scanCatalog">指定对话导入${icon('chevron')}</button><button class="text-button" data-action="probeQuick">${icon('refresh')}重新检测</button>` : ''}</div><p class="quick-hint">${running ? '当前对话处理完成后可以停止；已完成的记录会保留。' : reverse ? '包含全部项目、分支和归档；原生历史写入 DSH，重新打开 DSH 查看。' : ready ? '保留原来的项目归属；目录已不存在时自动放入「OpenCode / DSH 历史」。' : '默认读取本机 DSH；特殊安装位置可在下方高级设置中调整。'}</p></section>${run ? `<section class="section quick-result" aria-live="polite"><div class="section-heading"><h2>${esc(run.selected ? '所选对话 · ' + run.stage : run.stage)}</h2><span class="subtle">${(run.direction ?? 'dsh-to-oc') === direction ? '本次迁移' : '上次迁移'} · ${run.direction === 'oc-to-dsh' ? 'OpenCode → DSH' : 'DSH → OpenCode'}</span><span class="subtle">${run.finished} / ${run.total} 个源对话</span></div><progress max="${Math.max(1, run.total)}" value="${run.finished}" aria-label="迁移进度"></progress><div class="quick-stats"><span><b>${run.imported}</b> 个对话已验证</span><span><b>${run.nativeSessions}</b> 个原生会话（含归档）</span><span><b>${run.skipped}</b> 个空记录或重复副本已留存</span></div>${run.errors.length ? `<details class="quick-errors"><summary>${run.errors.length} 项需要处理 · 展开查看</summary><ul>${run.errors.map(item => `<li>${item.file ? `<code>${esc(item.file)}</code><br>` : ''}${esc(item.error)}</li>`).join('')}</ul></details>` : ''}<div class="section-actions"><button class="text-button" data-action="nav" data-page="jobs">查看迁移记录与回滚${icon('chevron')}</button><span class="subtle">${esc(run.target.version)} · 当前会话状态见迁移记录</span></div></section>` : ''}<div class="integrity-note">${icon('check')}原件先备份，逐对话回读核对；不重新执行历史工具。附件保留引用；迁移后继续写入的会话会在下次生成新快照。</div>${!running ? `<details class="advanced-mode"><summary>高级设置与其他迁移方式</summary><div class="advanced-intro"><p>普通迁移无需调整。仅自定义安装、隔离存储或远程插件接收时使用。</p><label class="inline-check"><input type="checkbox" id="customQuick" ${state.settings.customQuick ? 'checked' : ''}>一键迁移使用下方自定义位置</label>${input(reverse ? 'dshRoot' : 'sourceRoot', reverse ? 'DSH sessions 目标文件夹（可选）' : 'DSH sessions 源文件夹（可选）', setting(reverse ? 'dshRoot' : 'sourceRoot'), '留空自动读取 ~/.dsh/sessions', 'directory')}</div>${reverse ? `<div class="reverse-advanced"><div class="form-grid">${input('binary', 'OpenCode 可执行文件（可选）', setting('binary'), '默认优先使用已安装 GUI 的 CLI', 'file')}${input('dataHome', 'OpenCode XDG_DATA_HOME（可选）', setting('dataHome'), '留空使用默认存储', 'directory')}</div><p class="subtle">保留项目路径和原始 JSON；系统、压缩与扩展事件以历史快照呈现。不是实时同步。迁入项目名称前请退出 DSH，完成后重新打开。</p></div>` : advancedMigrate()}</details>` : ''}`;
}
function advancedMigrate() {
  return `<div class="flow-line"><span><b>01</b> 连接目标</span><i></i><span><b>02</b> 接收 / 导入</span><i></i><span><b>03</b> 回读验证</span></div><section class="section target-section"><div class="section-heading"><h2><span class="step">01</span> OpenCode 目标</h2><span class="subtle">CLI 与桌面端共享同一历史存储</span></div><div class="form-grid">${input('directory', '目标项目文件夹', setting('directory'), '选择迁入会话所属的项目', 'directory')}${input('binary', 'OpenCode 可执行文件', setting('binary'), 'opencode 或绝对路径', 'file')}</div><details class="advanced"><summary>高级连接与保留选项</summary><div class="form-grid"><label class="field"><span>目标版本</span><select id="generation"><option value="auto">自动检测（推荐）</option><option value="v1" ${state.settings.generation === 'v1' ? 'selected' : ''}>OpenCode 1.x</option><option value="v2" ${state.settings.generation === 'v2' ? 'selected' : ''}>OpenCode 2.x</option></select></label>${input('server', '2.x 服务地址（可选）', setting('server'), 'http://127.0.0.1:4096')}${input('dataHome', '自定义 XDG_DATA_HOME（可选）', setting('dataHome'), '留空使用 OpenCode 默认存储', 'directory')}${input('passwordFile', '服务密码文件（可选）', setting('passwordFile'), '从文件读取，不在界面展示', 'file')}</div><div class="options"><label><input type="checkbox" id="archive" ${state.settings.includeArchive !== false ? 'checked' : ''}>保留被压缩 / 替换的历史全文</label><label><input type="checkbox" id="snapshots" ${state.settings.stateSnapshots !== false ? 'checked' : ''}>附带任务与目标状态快照</label></div></details><div class="section-actions"><button class="button secondary" data-action="detect">${icon('refresh')}查找本机 OpenCode</button><button class="button primary" data-action="connect">检测并连接${icon('chevron')}</button><span class="connection-state">${connected ? `${icon('check')}${esc(connected)}` : '尚未验证目标'}</span></div><div id="candidates"></div></section><section class="section receive-section"><div class="section-heading"><h2><span class="step">02</span> 选择迁移方式</h2></div><div class="receive-grid"><div><div class="source-heading">${icon('plug')}从 DSH 插件接收<span class="tag">全部对话</span></div><p class="description">启动接收后，在 DSH 运行 <code>/oc-migrate all</code>。<br>插件会分批传输原始事件与有效上下文。</p><div class="receiver-controls"><label class="port-label">本地端口<input id="port" type="number" min="1" max="65535" value="${state.receiver ? new URL(state.receiver.url).port : '48765'}" ${state.receiver ? 'disabled' : ''}></label><label class="inline-check"><input id="autoImport" type="checkbox" checked ${state.receiver ? 'disabled' : ''}>收到后自动导入</label></div><div class="section-actions"><button class="button ${state.receiver ? 'secondary' : 'primary'}" data-action="${state.receiver ? 'stop' : 'start'}">${state.receiver ? '停止接收' : '启动本地接收'}</button><button class="text-button" data-action="nav" data-page="plugin">插件连接说明 ↗</button></div>${state.receiver ? `<p class="endpoint"><i></i>${esc(state.receiver.url)} · ${esc(state.receiver.version)}<br><small>目标：${esc(state.receiver.directory)}</small></p>` : ''}</div><div class="file-source"><div class="source-heading">${icon('folder')}导入本地迁移包</div><p class="description">已有插件导出的 JSON 文件？<br>直接选择，导入后会逐会话回读核对。</p><button class="button secondary" data-action="importFile">${icon('inbox')}选择 JSON 文件</button><p class="file-note">支持 dsh-oc-migrate v1 格式 · 最大 64 MiB</p></div></div></section><div class="integrity-note">${icon('check')}原件先落盘，回读通过后才标记成功。迁移不会重新执行历史工具调用。</div>`;
}
function jobWarnings(job: Job) { return [...new Set([...(job.sessions ?? []).flatMap(s => s.warnings ?? []), ...(job.projectNames ?? []).flatMap(p => p.warning ? [p.warning] : []), ...(job.workspace?.warning ? [job.workspace.warning] : [])])]; }
function jobs() {
  const ordered = [...state.jobs].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const detail = state.jobs.find(j => j.id === selected);
  return `<section class="section journal"><div class="section-heading"><h2>迁移任务 <span class="count">${state.jobs.length}</span></h2><button class="button secondary compact" data-action="refresh">${icon('refresh')}刷新</button></div>${!ordered.length ? `<div class="empty-state">${icon('history')}<h3>还没有迁移记录</h3><p>选择迁移方向，开始第一次一键迁移。</p><button class="button primary" data-action="nav" data-page="migrate">开始第一次迁移</button></div>` : `<div class="table-wrap"><table><thead><tr><th>任务 / 时间</th><th>会话</th><th>目标</th><th>状态</th><th></th></tr></thead><tbody>${ordered.map(j => `<tr><td><button class="job-link" data-action="detail" data-id="${j.id}">${esc(j.id.slice(0, 12))}</button><small>${j.createdAt ? esc(new Date(j.createdAt).toLocaleString('zh-CN', { hour12: false })) : '未知时间'}</small></td><td>${j.sessions?.length ?? '—'}</td><td>${j.direction === 'oc-to-dsh' ? 'DSH v4' : `OpenCode ${esc(j.generation?.replace('v', '') || '—')}.x`}</td><td><span class="status-badge ${esc(j.status)}">${esc(statusName[j.status] || j.status)}</span></td><td><button class="text-button" data-action="detail" data-id="${j.id}">详情${icon('chevron')}</button></td></tr>`).join('')}</tbody></table></div>`}</section>${detail ? `<section class="section detail"><div class="section-heading"><h2>任务详情</h2><span class="mono">${esc(detail.id.slice(0, 16))}</span></div>${jobWarnings(detail).length ? `<details class="quick-errors"><summary>迁移格式说明与保留方式</summary><ul>${jobWarnings(detail).map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}${detail.error ? `<p class="error-text">${esc(detail.error)}</p>` : ''}<ul class="session-list">${detail.sessions?.map(s => `<li><div><strong>${esc(s.title || s.sessionID)}</strong><code>${esc(s.sessionID)}</code></div><span>${esc(statusName[s.status] || s.status)}</span></li>`).join('') || ''}</ul><div class="section-actions"><button class="button secondary" data-action="retry" data-id="${detail.id}">导入 / 重新验证</button><button class="button danger" data-action="rollback" data-id="${detail.id}">回滚此任务</button><span class="subtle">只回滚本任务创建、未继续使用的历史；DSH 已打开或已产生分支的会话会保留。</span></div></section>` : ''}<p class="storage-line">原始迁移包与报告保存在 <code>${esc(state.stateDirectory)}</code></p>`;
}
function plugin() {
  const url = state.receiver?.url || 'http://127.0.0.1:48765';
  const patch = `- insert:\n    - id: dsh-oc-migrate\n      name: dsh-oc-migrate\n      config:\n        receiver: ${url}\n        tokenFile: ${JSON.stringify(state.tokenFile)}\n        batchSize: 20`;
  return `<section class="section plugin-guide"><div class="guide-row"><span class="step">01</span><div><h2>在 DSH profile 安装插件包</h2><p>使用 DSH 插件管理器添加安装包内附带的本地 npm 包。插件包路径：</p><code class="path-block">${esc(state.pluginFile || '正在读取资源路径…')}</code><p class="subtle">插件安装在 DSH Host 中，不是浏览器扩展。启用后按 DSH 提示重载 profile。</p></div></div><div class="guide-row"><span class="step">02</span><div><h2>配置接收地址与令牌文件</h2><p>在相应 profile 的 <code>cordis.patch.yml</code> 配置下方内容。已有插件条目时，更新该条目的 config，避免重复挂载。</p><textarea class="config-code" aria-label="DSH 插件配置" readonly rows="9">${esc(patch)}</textarea><p class="subtle">令牌由桌面应用自动创建；仅显示文件路径，不展示令牌内容。</p></div></div><div class="guide-row"><span class="step">03</span><div><h2>启动接收，然后导出全部对话</h2><p>先返回迁移工作台连接 OpenCode 并启动接收，再在 DSH 输入：</p><div class="command-pair"><code>/oc-migrate list</code><span>确认可读取的对话</span><code>/oc-migrate all</code><span>分批传输全部可列出对话</span></div><p class="subtle">可用 current 或会话 ID 单独导出；原始事件始终本地留存。附件引用会保留，附件字节暂不传输。</p><button class="button primary" data-action="nav" data-page="migrate">返回迁移工作台${icon('chevron')}</button></div></div></section>`;
}
async function scanCatalog(payload: Record<string, unknown>) {
  previewRequest++; catalogView = newCatalogView(); scanProgress = '正在扫描本机对话…';
  await act(async () => {
    state.catalog = await rpc<Catalog>('scanCatalog', payload);
    direction = normalizeDirection(state.catalog.direction); rememberDirection(); page = 'catalog';
    notice = `扫描完成：${state.catalog.projects.length} 个项目、${state.catalog.entries.length} 个对话；尚未导入。`; isError = false;
  });
  scanProgress = '';
}
async function refresh() { const draft = state.settings; state = await rpc<Snapshot>('snapshot'); if (Object.keys(draft).length) state.settings = draft; render(); }
async function act(task: () => Promise<void>, success?: string) {
  if (busy) return;
  busy = true; render();
  try { await task(); if (success) { notice = success; isError = false; } }
  catch (error) { notice = String(error); isError = true; }
  finally { busy = false; try { const draft = state.settings; state = await rpc<Snapshot>('snapshot'); if (Object.keys(draft).length) state.settings = draft; } catch (error) { notice = String(error); isError = true; } render(); }
}
root.addEventListener('input', event => {
  const field = event.target as HTMLInputElement;
  if (field.id === 'catalogIDs') { catalogView.idsText = field.value; return; }
  if (field.id === 'catalogSearch') { const cursor = field.selectionStart; catalogView.query = field.value; catalogView.page = 0; render(); const search = document.getElementById('catalogSearch') as HTMLInputElement; search.focus(); if (cursor !== null) search.setSelectionRange?.(cursor, cursor); return; }
  if (field.dataset.catalogSelect) { if (field.checked) catalogView.selected.add(field.dataset.catalogSelect); else catalogView.selected.delete(field.dataset.catalogSelect); render(); return; }
  if (['directory', 'binary', 'generation', 'server', 'dataHome', 'passwordFile', 'archive', 'snapshots', 'sourceRoot', 'dshRoot', 'customQuick'].includes(field.id)) {
    state.settings = { ...state.settings, ...config() }; connected = '';
  }
});
root.addEventListener('click', async event => {
  const button = (event.target as Element).closest<HTMLElement>('[data-action]');
  if (!button) return;
  event.preventDefault(); const action = button.dataset.action;
  if (action === 'nav') { page = button.dataset.page!; render(); return; }
  if (action === 'theme') { theme = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('desktop-theme', theme); render(); return; }
  if (action === 'dismiss') { notice = ''; render(); return; }
  if (action === 'detail') { selected = button.dataset.id!; render(); return; }
  if (busy) return;
  if (action === 'direction') {
    if (state.quick?.status === 'running' || probing) return;
    const next = normalizeDirection(button.dataset.direction);
    if (next === direction) return;
    state.settings = config(); direction = next; rememberDirection(); plan = null;
    catalogView = newCatalogView(); previewRequest++; notice = '';
    if (page === 'catalog') await scanCatalog(quickInput()); else await probeQuick();
    return;
  }
  if (action === 'scanCatalog') {
    if (state.quick?.status === 'running' || probing) return;
    const next = normalizeDirection(button.dataset.direction || direction);
    const payload = button.dataset.reuse && state.catalog?.direction === next ? state.catalog.input : quickInput();
    direction = next; rememberDirection(); await scanCatalog({ ...payload, direction }); return;
  }
  if (action === 'catalogApplyIDs' && state.catalog?.direction === direction) {
    try {
      const ids = resolveConversationIDs(state.catalog, catalogView.idsText);
      catalogView.selected = new Set(ids); catalogView.idsError = '';
      catalogView.project = ''; catalogView.query = ''; catalogView.onlyStarred = false; catalogView.page = 0;
      notice = `已匹配并选中 ${ids.length} 个对话；确认列表后点击“迁移已选”，尚未导入。`; isError = false;
    } catch (error) { catalogView.idsError = error instanceof Error ? error.message : String(error); }
    render(); return;
  }
  if (action === 'catalogProject') { catalogView.project = button.dataset.id || ''; catalogView.page = 0; render(); return; }
  if (action === 'catalogFilter') { catalogView.onlyStarred = !catalogView.onlyStarred; catalogView.page = 0; render(); return; }
  if (action === 'catalogPage') { catalogView.page = Number(button.dataset.pageIndex); render(); return; }
  if (action === 'catalogClear') { catalogView.selected.clear(); render(); return; }
  if (action === 'catalogSelectVisible' && state.catalog) { for (const e of filteredEntries(state.catalog, catalogView)) catalogView.selected.add(e.id); render(); return; }
  if (action === 'catalogPreview' && state.catalog) {
    const id = button.dataset.id!, request = ++previewRequest, scanID = state.catalog.id;
    catalogView.focused = id; catalogView.loading = true; catalogView.error = ''; catalogView.preview = null; render();
    try { const preview = await rpc<Preview>('catalogPreview', { scanID, id, offset: Number(button.dataset.offset || 0) }); if (request === previewRequest) catalogView.preview = preview; }
    catch (error) { if (request === previewRequest) catalogView.error = error instanceof Error ? error.message : String(error); }
    finally { if (request === previewRequest) { catalogView.loading = false; render(); } } return;
  }
  if (['catalogAlias', 'catalogProjectAlias', 'catalogStar'].includes(action || '') && state.catalog) {
    const kind = action === 'catalogProjectAlias' ? 'project' : 'entry', id = button.dataset.id!, scanID = state.catalog.id;
    const patch = action === 'catalogStar' ? { starred: !state.catalog.entries.find(e => e.id === id)?.starred } : { alias: val(kind === 'project' ? 'projectAlias' : 'catalogAlias') };
    await act(async () => { state.catalog = await rpc<Catalog>('catalogUpdate', { scanID, kind, id, patch }); }, '已保存本地管理信息，源工具中的名称保持不变。'); return;
  }
  if (['startSelected', 'importOne'].includes(action || '') && state.catalog) {
    const catalog = state.catalog, ids = action === 'importOne' ? [button.dataset.id!] : [...catalogView.selected];
    await act(async () => {
      const payload = selectionPayload(catalog, direction, ids);
      state.quick = await rpc<QuickRun>('startSelected', payload);
      direction = normalizeDirection(catalog.direction); rememberDirection(); page = 'migrate'; notice = ''; plan = null;
    }); return;
  }
  if (action === 'probeQuick') { await probeQuick(); return; }
  if (action === 'cancelQuick') { await rpc('cancelQuick'); notice = '正在完成当前对话，然后停止迁移。'; isError = false; render(); return; }
  if (action === 'startQuick') { const payload = quickInput(); await act(async () => { state.quick = await rpc<QuickRun>('startQuick', payload); notice = ''; }); return; }
  if (action === 'browse') {
    const file = await open({ directory: button.dataset.kind === 'directory', multiple: false });
    if (typeof file === 'string') { (document.getElementById(button.dataset.field!) as HTMLInputElement).value = file; state.settings = { ...state.settings, ...config() }; connected = ''; }
    return;
  }
  if (action === 'connect') { const payload = config(); await act(async () => { const target = await rpc<{version: string; generation: string}>('connect', payload); connected = target.version; }, 'OpenCode 已连接，可以开始迁移。'); }
  if (action === 'detect') {
    await act(async () => {
      const result = await rpc<{ candidates: { binary: string; version: string }[] }>('detect');
      if (!result.candidates.length) throw new Error('没有找到 OpenCode，请手动选择已安装的可执行文件。');
      state.settings.binary = result.candidates[0].binary;
      connected = '';
      notice = `找到 ${result.candidates.length} 个 OpenCode，已选择 ${result.candidates[0].version}。请检测并连接。`; isError = false;
    });
  }
  if (action === 'start') { if (!connected) { notice = '请先检测并连接当前 OpenCode 目标。'; isError = true; render(); return; } const payload = { port: Number(val('port')), autoImport: checked('autoImport') }; await act(async () => { await rpc('start', payload); }, '本地接收已启动。请在 DSH 运行 /oc-migrate all。'); }
  if (action === 'stop') await act(async () => { await rpc('stop'); }, '本地接收已停止。已保存的迁移记录仍然保留。');
  if (action === 'refresh') await act(refresh);
  if (action === 'importFile') {
    if (!connected) { notice = '请先检测并连接当前 OpenCode 目标。'; isError = true; render(); return; }
    const file = await open({ multiple: false, filters: [{ name: 'DSH 迁移包', extensions: ['json'] }] });
    if (typeof file !== 'string') return;
    await act(async () => { const report = await rpc<Job>('importFile', { file }); selected = report.id; page = 'jobs'; if (report.status === 'failed') throw new Error(report.error || '导入失败，请查看任务'); }, '导入完成，历史正文已回读核对。');
  }
  if (action === 'retry' || action === 'rollback') {
    if (action === 'rollback' && !await confirm('回滚将删除本任务创建且未继续使用的目标会话（DSH 或 OpenCode）。DSH 已取得写入权的会话会保留。原始导出包会保留，可再次导入。确认回滚？', { title: '回滚迁移任务', kind: 'warning' })) return;
    await act(async () => { const report = await rpc<Job>(action, { id: button.dataset.id }); if (report.status === 'failed') throw new Error(report.error || '任务未完成'); }, action === 'rollback' ? '回滚完成，原始导出包已保留。' : '导入与回读验证完成。');
  }
});
render();
listen<{type: string}>('desktop-event', event => {
  if (event.payload.type === 'catalog-progress') { const progress = event.payload as unknown as { finished: number; total: number }; scanProgress = `正在扫描 ${progress.finished} / ${progress.total} 个对话…`; const working = root.querySelector('.working'); if (working) working.innerHTML = `<span class="spinner"></span>${esc(scanProgress)}`; }
  else if (event.payload.type === 'quick-progress') { state.quick = (event.payload as unknown as {quick: QuickRun}).quick; render(); }
  else if (event.payload.type === 'backend-exited') { notice = '迁移内核已退出，请重新打开应用。'; isError = true; render(); }
  else if (!busy) refresh().catch(error => { notice = String(error); isError = true; render(); });
}).catch(console.error);
refresh().then(() => probeQuick()).catch(error => { notice = String(error); isError = true; render(); });
// While a long native import is running, the persisted report still exposes progress.
setInterval(() => { if (!busy && !document.hidden && (state.quick?.status === 'running' || page === 'jobs' && state.jobs.some(j => j.status === 'importing'))) refresh().catch(console.error); }, 5000);
