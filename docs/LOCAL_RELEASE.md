# 本地构建，不消耗 GitHub Actions 额度

安装依赖后，提交源码，再执行一条命令：

```sh
npm ci
npm run release:local
```

只想看当前机器会构建什么，可以执行 `npm run release:local -- --plan`。

## 会得到什么？

输出目录为 `artifacts/releases/v版本-平台-时间/`。每次创建新目录，不覆盖之前的安装包；只有所有构建和核对成功才交付最终目录。

| 本机环境 | 本机产物 |
| --- | --- |
| Apple 芯片 Mac | ARM64 DMG、`.app.tar.gz` |
| Intel Mac | x64 DMG、`.app.tar.gz` |
| Windows x64 | NSIS `.exe` 安装器 |
| Linux x64 | DEB、RPM、AppImage、无 FUSE 启动脚本 |

每份输出另外包含 DSH 插件 `.tgz`、`BUILD-MANIFEST.json`（精确源码提交、本地测试步骤与签名状态）及 `SHA256SUMS.txt`。Mac 可直接打开 DMG，将应用拖入 Applications。本命令不修改已安装的应用、迁移设置或聊天记录。

构建前执行语法、单测、插件打包回归和 Rust 测试；Tauri 构建含 TypeScript/Vite 和内嵌 sidecar。随后实际运行编译后的 sidecar 测试。Mac 还会核对 `.app` 原生版本、严格 codesign 和 DMG 完整性。

## 构建环境

依赖 Node ≥ 22.19、Bun 1.3.14、Rust stable 和当前系统的 Tauri 2 构建依赖。Mac 安装 Xcode Command Line Tools；Windows 安装 MSVC Build Tools 与 WebView2；Linux 安装 WebKitGTK 4.1、AppIndicator、librsvg、patchelf 和 rpm 等依赖，参照 [Tauri 官方构建前置说明](https://v2.tauri.app/start/prerequisites/)。

本地模式只构建当前原生系统/架构，不在 Mac 上冒充 Windows/Linux 构建通过，也不替代四平台正式 Release 的完整性检查。默认 Mac 签名为 ad-hoc；严格签名校验通过不等于 Apple Developer ID 签名或公证，未改变 Gatekeeper 设置。[官方 DMG 说明](https://v2.tauri.app/distribute/dmg/)。

## 可选：同时回归真实 OpenCode 1.x / 2.x

开发者准备好两代二进制后，可在本次本地打包中一并完成原生双向回归：

```sh
OPENCODE_V1_BIN=/absolute/path/to/opencode-v1 \
OPENCODE_V2_BIN=/absolute/path/to/opencode-v2 \
npm run release:local
```

必须同时提供两个路径。未提供时，清单明确记为未运行，不会写成原生回归通过。回归使用隔离样例，不迁入实际用户对话。

可以通过 `CARGO_TARGET_DIR` 复用本机 Rust 缓存；不接受与本机不同的交叉编译目标。构建失败时命令返回非零，不产生标记成功的交付目录。检查日志修复环境后重试即可，旧版本产物保留。

校验下载/复制后的文件：Mac/Linux 在交付目录执行 `shasum -a 256 -c SHA256SUMS.txt`；Windows 可用 PowerShell `Get-FileHash -Algorithm SHA256 文件名` 与清单逐项比较。
