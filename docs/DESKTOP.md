# Tauri 桌面应用

## 使用

桌面安装包最低 macOS 13（内置 Bun 运行时要求）；Windows 10 1809+；Linux 需系统 WebKitGTK 4.1。

从仓库 Releases 下载系统对应安装包。应用内置 JavaScript 运行时与迁移内核；用户无需安装 Node.js / Bun / Rust。OpenCode 与 DSH 由用户原有安装提供。

### 一键迁移（默认）

1. 打开应用，自动扫描 `~/.dsh/sessions`，识别本机 OpenCode；优先使用已安装桌面版内附的 CLI，避免 PATH 中另一个版本导入到不同存储。
2. 点击「一键迁移全部对话」。无需插件安装、项目路径、版本、端口或令牌配置。逐个备份原始日志、转换、原生导入与回读核对；实时显示已完成数量和错误，单个失败不会阻断其他对话。
3. 在 OpenCode 打开原项目查看历史。原项目已不存在时，迁入 `~/OpenCode/DSH 历史`。再次点击会核对去重，已中断任务可重跑。点击「停止迁移」会在当前对话处理完成后停止。
4. 在「迁移记录」查看详情、重试或回滚。回滚始终使用该任务的原始目标，不随当前界面选择改变；原始包与物理日志备份保留。

本地直读支持 DSH v4 的 JSONL 与多帧 Zstandard 日志，完整读取所有帧，保留压缩前历史及继承边界。会话仍在写入、格式不支持、文件损坏或解压后超过 256 MiB 时会单独报告，不把残缺日志当作成功。旧格式可先在 DSH 打开完成格式升级，或使用 Host 插件导出。已删除或尚未持久化到磁盘的历史不在本地扫描内。

### 高级方式

自定义 DSH 位置、OpenCode 二进制或隔离存储，可展开「高级设置与其他迁移方式」，勾选一键迁移使用自定义位置。普通安装无需展开。远程 DSH 或需要读取内存中最新截面时，仍支持原来的 Host 插件 → 本地接收端流程：连接目标、启动接收、安装随包插件，运行 `/oc-migrate all`。也可选择现有 JSON 迁移包导入。

原始日志、转换结果、报告、目标快照都留在操作系统的应用数据目录。一键迁移物理原件存于 `quick-runs/<run-id>/sources/`，并记录 SHA-256。设置不保存密码值；高级模式的 2.x 服务密码从选定文件读取。退出应用会终止 sidecar 并关闭接收端；中断的迁移在重开后明确显示，可重新一键迁移；高级接收端下次需重新连接和启动。

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
