export const APP_VERSION = '0.5.8';
export type Page = 'guide' | 'migrate' | 'catalog' | 'jobs' | 'advanced' | 'plugin';
export const GITHUB_LINKS = { author: 'https://github.com/SummerXDsss', project: 'https://github.com/SummerXDsss/dsh-oc-migrate' } as const;
export const pageInfo: Record<Page, { label: string; title: string; description: string }> = {
  guide: { label: '首次使用', title: '三步，把对话搬过去。', description: '不用填地址和端口。先选方向，再找到要搬的对话。' },
  migrate: { label: '迁移对话', title: '换个工具，继续对话。', description: '选择方向，然后全部搬走，或先扫描再挑选。原工具里的记录会保留。' },
  catalog: { label: '项目与对话', title: '先找到，再决定搬哪些。', description: '按项目和标题找对话，查看内容后再勾选。扫描不会开始迁移。' },
  jobs: { label: '迁移记录', title: '每次迁移，都有迹可循。', description: '查看结果、处理未完成的对话，或者撤销某一次迁移。' },
  advanced: { label: '高级模式', title: '特殊情况，再来这里设置。', description: '普通迁移不用改。只有找不到对话、自定义安装或使用插件时，才需要这里的选项。' },
  plugin: { label: '高级模式 · 插件说明', title: '把 DSH 对话发到 OpenCode。', description: '插件只用于 DSH → OpenCode。反向迁移请使用迁移工作台；本机对话通常不需要插件。' },
};

export function sidebarHTML(page: Page, theme: string, jobs: number, icon: (name: string) => string) {
  const item = ([id, glyph, label]: string[]) => {
    const active = page === id || id === 'advanced' && page === 'plugin';
    return `<button data-action="nav" data-page="${id}" class="nav-item ${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span>${id === 'jobs' && jobs ? `<b>${jobs}</b>` : ''}</button>`;
  };
  return `<aside class="sidebar"><a class="brand" href="#" data-action="nav" data-page="migrate"><span class="brand-mark">${icon('arrow')}</span><span>对话搬家<small>DSH ↔ OpenCode</small></span></a>
    <div class="nav-label">工作区</div><nav aria-label="主导航">${[['migrate', 'inbox', '迁移工作台'], ['catalog', 'folder', '项目与对话'], ['jobs', 'history', '迁移记录']].map(item).join('')}</nav>
    <div class="nav-label secondary-label">帮助与设置</div><nav aria-label="帮助与设置">${[['guide', 'book', '使用教程'], ['advanced', 'settings', '高级模式']].map(item).join('')}</nav>
    <div class="sidebar-bottom"><button class="theme-button" data-action="theme">${icon(theme === 'dark' ? 'sun' : 'moon')}${theme === 'dark' ? '切换浅色外观' : '切换深色外观'}</button>
      <a class="author-link" href="${GITHUB_LINKS.author}" data-action="github" data-target="author" target="_blank" rel="noopener noreferrer" aria-label="在浏览器打开 GitHub 作者 SummerXDsss">${icon('github')}<span><strong>SummerXDsss</strong><small>GitHub 作者</small></span>${icon('external')}</a>
      <a class="project-link" href="${GITHUB_LINKS.project}" data-action="github" data-target="project" target="_blank" rel="noopener noreferrer">查看项目源码${icon('external')}</a>
    </div></aside>`;
}
