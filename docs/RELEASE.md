## Tauri 桌面版

- 默认一键迁移：自动识别本机 DSH 日志与 OpenCode，不用安装插件或填写连接配置。
- 完整读取 v4 JSONL / 多帧 Zstandard；原始物理日志先备份，按原项目逐会话导入、回读核对，坏记录独立报告。
- 自动去重、迁移进度、停止后续处理、重开中断提示；原目录消失时归入 `OpenCode/DSH 历史`。
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

macOS 包使用 ad-hoc 签名，尚未配置 Developer ID 公证；Windows 包没有开发者证书签名。本版本没有自动更新。OpenCode 与 DSH 需要分别安装；插件接收和所有自定义连接选项位于高级流程。附件引用保留，附件字节暂不复制；DSH 已删除或未记录的历史不包含在导出中。本地直读单会话解压后上限 256 MiB，其他格式与仍在写入的日志会明确报告。
