# README 界面图

这些图片由 **0.5.9 桌面前端的正式构建资源**在 Chromium 中渲染截取，不是重新设计的概念稿。页面布局、样式、按钮和交互使用当前代码；仅文档预览替换 Tauri IPC 为固定的合成数据。

所有图片顶部都有「文档演示 · 合成数据」标记。项目路径使用 `/demo/`，对话编号使用 `DEMO-` 或 `ses_demo_`。示例数量、已核对/已撤销等任务状态只用于解释界面，不作为真实迁移验收证据。图片中没有实际用户对话、个人目录或凭据。

## 复现

```bash
npm ci
npm run desktop:web:build
DOCS_PREVIEW_PORT=4187 npm run docs:preview
```

打开打印的本机地址。预览只绑定 `127.0.0.1`，不引入 DesktopService、不读取本机历史、不提供真实导入或撤销。普通桌面安装包不会启动此预览服务。

| 文件 | 画面与操作 | 截图尺寸 |
| --- | --- | --- |
| `workbench-dark.png` | 根地址，默认 DSH → OpenCode，等待版本检测完成 | 1360 × 960 |
| `guide-dark.png` | `/?view=guide`，点击「下一步」，显示第 2 步 | 1360 × 960 |
| `catalog-dark.png` | 根地址点击「先扫描，挑选对话」，勾选并预览「整理登录页交互」，关闭扫描提示 | 1360 宽，全页 |
| `reverse-dark.png` | `/?view=reverse`，等待版本检测完成 | 1360 × 960 |
| `history-dark.png` | 点击「迁移记录」，再打开 `demo-verifie` 的详情；不点击撤销 | 1360 × 960 |

浏览器截图写到 `output/playwright/readme-日期/`，检查可读性后复制到本目录。可用 Playwright CLI 的 `resize`、`snapshot`、`click` 和 `screenshot --filename=...` 重复以上过程；不要通过修改截图文字来伪造产品状态。

```bash
npm run docs:preview -- --check
```

图片采用 PNG，单张小于 700 KB，保持中文文字清晰并控制 README 加载体积。更新产品界面后，重新渲染相关图片，而不是继续沿用旧图。
