## Tauri 桌面版

- 中文图形化工作台：选择项目和 OpenCode 可执行文件、自动识别 1.x / 2.x。
- 内置本地中间件及 Bun sidecar，不需要额外安装 Node.js。
- DSH 插件分批传输全部可列出历史；也可选择本地 JSON 迁移包导入。
- 本地接收状态、任务记录、原生回读验证、重试及带确认的回滚。
- 插件包随应用附带，并独立发布 `.tgz`；历史原件与令牌仅保存在本机。
- macOS Apple Silicon / Intel、Windows x64、Linux x64 自动构建；附 SHA256SUMS.txt。

### 下载

- macOS：选择对应 `aarch64`（Apple Silicon）或 `x64`（Intel）DMG。
- Windows：选择 x64 setup.exe。
- Linux：选择 amd64.deb 或 amd64.AppImage。

macOS 包使用 ad-hoc 签名，尚未配置 Developer ID 公证；Windows 包没有开发者证书签名。本版本没有自动更新。OpenCode 与 DSH 需要分别安装；应用中的插件连接页提供本机资源路径及配置。附件引用保留，附件字节暂不复制；DSH 已删除或未记录的历史不包含在导出中。
