# Windows 与普通 Linux 桌面

两个系统都使用同一个 Tauri 界面：选择方向 → 指定对话导入/一键全部 → 回读验证 → 迁移记录中回滚。无需 WSL、macOS、Homebrew 或另外安装 Node/Bun。插件与命令行高级方式仍保留。

## Windows 10 / 11 x64

- 使用 Release 中的 NSIS `.exe` 安装包，默认仅为当前用户安装，不要求管理员权限；界面提供简体中文。
- 安装器内嵌 WebView2 引导程序；若系统尚无 WebView2，安装器会联网安装该运行时，迁移数据仍只在本机处理。不是完全离线的 WebView2 安装包。
- 自动查找 OpenCode 2.x 桌面端 `%APPDATA%\ai.opencode.desktop\cli\<版本>-x64\opencode-cli.exe`、常见安装目录的 `resources\opencode-cli.exe`、旧版 GUI、`.opencode\bin`、npm 原生包、Scoop 与 PATH。
- 从高级选择器指定 npm `opencode.cmd` / `.ps1` 时，读取相邻官方包的原生 `opencode.exe`，而非交给 `cmd.exe` 拼接执行。中文、空格与 `&` 不会拆成命令。自定义 npm prefix 在 PATH 中时也会解析其 `opencode.cmd`；特殊布局可直接选择原生 `.exe`。
- Windows 首次扫描允许较长的版本检测时间。目标文件短暂被杀毒软件/索引器占用时有限重试；持续占用则保留旧文件并报告错误，不先删除原件。
- DSH 默认 `%USERPROFILE%\.dsh\sessions`；若设置 `DSH_HOME`，则使用该目录下的 `sessions`。也支持在高级设置里选择自定义位置。

## 普通 Linux x86_64（glibc）

不依赖 WSL。构建基线是 Ubuntu 22.04；目标为具备 WebKitGTK 4.1 的常规 Linux 桌面，如 Ubuntu 22.04+、Debian 12+，以及较新的 Fedora 系列。需要桌面会话，SSH 纯终端使用 CLI。

### Ubuntu / Debian

下载 `.deb` 后，在文件所在目录运行：

```sh
sudo apt install ./DSH*.deb
```

安装器声明并通过系统包管理器处理 GTK/WebKitGTK 依赖，不要求用户安装 Node/Bun。

### Fedora / RPM 系

```sh
sudo dnf install ./DSH*.rpm
```

### 通用 AppImage

把 `start-linux.sh` 与一个 AppImage 放在同一目录：

```sh
sh ./start-linux.sh
# 或明确指定一个文件（支持中文、空格路径）
sh ./start-linux.sh './DSH OpenCode Migrate.AppImage'
```

启动脚本只为下载的 AppImage 补执行权限；缺少可用 FUSE 时自动使用 AppImage 的解包运行模式，不要求 root。也可自行执行 `APPIMAGE_EXTRACT_AND_RUN=1 ./文件.AppImage`。

- 自动查找 OpenCode 桌面端 `$XDG_CONFIG_HOME/ai.opencode.desktop/cli/<版本>-x64/opencode-cli`（未设置时为 `~/.config`）、`/opt/OpenCode/resources`、`/opt/opencode/resources`、`/usr/lib[64]/opencode/resources`、用户 `.opencode/bin`、`.local/bin` 与系统 PATH。
- DSH 默认为 `~/.dsh/sessions`，遵循 `DSH_HOME`，支持中文路径。反向写入项目名/回滚前需退出 DSH；进程检查使用系统 `ps`（通常由 `procps` 提供）。
- AppImage 不是适用于所有 Linux 的静态程序：glibc、WebKitGTK 基线与桌面环境仍需满足。Alpine/musl 和 Linux ARM64 不在当前 GUI 安装包矩阵中。

## CI 与验收口径

- Windows 2022 原生 runner 与 Ubuntu 22.04 runner：Node 22/24 单元、Web 构建、打包测试；Node 24 再跑真实 OpenCode 1.18.31 / 2.3.2 双向、选择、sidecar 和回滚回归。
- 原生回归将 CLI 与测试目录放进包含中文、空格的路径；Windows 同时隔离 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、DSH_HOME 和 XDG 目录，不接触原有历史。
- Release 构建两份 macOS DMG、Windows NSIS、Linux DEB/RPM/AppImage；六份安装包全部齐备且回归成功后才发布，另附 Linux 启动脚本、插件包与 SHA256SUMS。
- Windows/macOS/Linux 的模拟路径单元测试、Linux 容器原生测试、GUI 真机窗口点验是不同证据，不互相冒充。GitHub 因账户额度未启动的 job 不算通过。

实现依据：[OpenCode 桌面 CLI 暂存源码](https://github.com/anomalyco/opencode/blob/dev/packages/desktop/src/main/service/desktop-cli.ts)、[Tauri Windows 安装](https://v2.tauri.app/distribute/windows-installer/)、[Tauri AppImage 基线](https://v2.tauri.app/distribute/appimage/)。
