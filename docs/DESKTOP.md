# Tauri 桌面应用

## 使用

桌面安装包最低 macOS 13（内置 Bun 运行时要求）；Windows 10 1809+；Linux 需系统 WebKitGTK 4.1。

从仓库 Releases 下载系统对应安装包。应用内置 JavaScript 运行时与迁移内核；用户无需安装 Node.js / Bun / Rust。OpenCode 与 DSH 由用户原有安装提供。

1. 在「迁移工作台」选择目标项目文件夹、OpenCode 可执行文件，点击「检测并连接」。可以查找本机二进制；macOS 包内 CLI 也可选择。
2. 点击「启动本地接收」。端口默认 48765，可关闭「收到后自动导入」，先保存原件后在任务详情导入。
3. 在「连接 DSH 插件」查看随包附带的 `.tgz` 路径和本机令牌文件路径；按 DSH profile 插件管理器流程安装并启用。已有配置只更新 config。
4. 在 DSH 执行 `/oc-migrate list`，再 `/oc-migrate all`。也可在工作台选择本地 JSON 导入。
5. 「迁移记录」显示真实状态。只有原生回读一致才显示「已回读验证」。重试和回滚始终重连该任务的原目标，不随当前界面选择而改变。

原始日志、转换结果、报告、目标快照都留在操作系统的应用数据目录。设置不保存密码值；2.x 服务密码从选定文件读取。退出应用会终止 sidecar 并关闭本地接收端；下次打开需重新连接和启动。

### OpenCode CLI / GUI

CLI 方式使用所选二进制的默认本地存储；同版本桌面 GUI 指向同一存储和项目时能读到导入记录。自定义 `XDG_DATA_HOME` 必须与 OpenCode 启动环境一致。2.x GUI 连接已有服务时，可填服务 origin 与密码文件，使用原生 HTTP 导入。1.x 使用 CLI 方式。

### 原始数据覆盖

完整 raw events 先留存；有效上下文进入主会话，被压缩 / 替换的全文单独归档。工具调用只转换为已完成 / 已中断的历史，不重新运行。媒体引用与未知事件保留为引用或原文 JSON，不自动下载附件字节。

## 开发

```bash
npm ci
npm test
npm run desktop:dev
# 发布模式；桌面构建前自动生成 Bun sidecar 和插件包
npm run desktop:build
```

构建环境需要 Tauri 2 对应平台依赖、Rust、Node >=22.19 与 Bun 1.3.14。前端使用 TypeScript + Vite，原生宿主使用 Rust；业务内核沿用现有模块。前端没有通用 shell 权限，只有固定 RPC 操作和文件选择 / 确认弹窗。

本地只构建应用 bundle 可用：`npm run desktop:build -- --bundles app`（macOS）。输出在 `src-tauri/target/release/bundle/`。

## CI / Release

- 每次 push / PR：Node 22 / 24 单元、语法、前端构建、插件打包、macOS Rust 格式与编译检查，以及原生 OpenCode 1.18.31 / 2.3.2 CLI 与服务回归。
- 推送 `v<package.json version>` tag：并行回归与四平台构建，并实际运行每个平台的编译 sidecar JSONL 测试。
- 所有构建成功后才发布 Release，包含 DMG（ARM64 / Intel）、NSIS、DEB、AppImage、DSH 插件 `.tgz` 和 SHA256SUMS.txt。失败不会发布半套新 Release。手动运行默认只产出构建 artifacts，勾选 publish 才发布；已存在 Release 不覆盖，请提升版本。
- 工作流不上传应用数据、用户导出历史或令牌。macOS 使用 ad-hoc 签名并验证 bundle 完整性，尚未配置 Developer ID 公证；Windows 未配置开发者证书。当前不包含自动更新服务。

侧车集成采用 Tauri 官方 [externalBin / sidecar](https://v2.tauri.app/develop/sidecar/) 机制；发布矩阵参照 [GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/) 文档。

实机窗口操作与自动回归结果见 [桌面验收记录](DESKTOP_VALIDATION.md)。
