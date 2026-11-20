# 0.5.6 · 首次教程与简洁导航

- 第一次打开显示三步教程：选择方向、决定搬哪些对话、了解迁移后检查与撤销。可以跳过，也能从「使用教程」随时重看。
- 教程不会自动迁移；选择挑选会先扫描，选择全部会先回到工作台，仍需点击迁移按钮。完成或跳过后记住状态。
- 高级模式拥有独立导航，集中放置自定义路径、连接、文件导入与插件说明；普通工作台只保留迁移操作。
- 调整界面文案，用「核对」「撤销这次迁移」等表达替代内部术语。左下角移除处理说明、版本号和 Tauri 标识，改为 GitHub 作者及项目快捷链接，用默认浏览器打开。
- 保留深浅外观切换、双向迁移、指定对话、项目与对话管理器，以及 Windows / 普通 Linux 的构建支持。

---

# 0.5.5 · Windows 与普通 Linux 桌面适配

- Windows 自动发现 OpenCode 2.x 桌面端暂存 CLI、常见 resources 安装目录、npm 原生程序与 Scoop；npm 脚本入口解析为原生 exe，不依赖 shell 拼接。
- Windows 安装器采用当前用户模式、中文界面与 WebView2 引导程序；sidecar 使用 x64 baseline。文件占用采用有限退避重试，持续失败仍保留目标原件。
- Linux 自动发现 XDG 下的桌面 CLI 和常见发行包目录；进程检查不依赖 macOS 专属参数，DSH_HOME 遵循官方规则。
- Linux 提供 DEB、RPM 和 AppImage；附 start-linux.sh，在缺少 FUSE 时使用解包运行模式。Linux GUI 构建基线为 Ubuntu 22.04 / WebKitGTK 4.1，不依赖 WSL、Node 或 Bun。
- CI 增加 Windows 2022 / Ubuntu 22.04 原生回归、Node 22/24 矩阵及包含中文/空格路径的双版本迁移与回滚。六份安装包与回归全部成功才发布；配置完成不代表 runner 或 GUI 已通过。

[平台安装说明](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/PLATFORMS.md) · [验收记录](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/DESKTOP_VALIDATION.md)。

---

# 0.5.4 · 方向切换与指定对话导入

- 工作台与项目/对话管理器共用方向控件，支持 DSH → OpenCode / OpenCode → DSH；记住上次方向，运行期间锁定。
- 管理器切换后扫描新来源，清空旧选择与预览；保留自定义源/目标路径，不把隐藏设置清空。扫描失败不沿用另一方向的列表。
- 工作台增加明确的「指定对话导入」入口；支持按标题/项目勾选、粘贴源对话 ID 精确选中，或从预览直接「仅导入此对话」。
- 精确 ID 支持多个、去重；未知或歧义 ID 整组报错，不更改原勾选。单条按钮不连带其他选择，空选或失败不会变成全量迁移。
- 沿用 OpenCode 1.x / 2.x 原生导入、标题/项目名保留与任务回滚。

[使用说明](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/MANAGER.md) · [验收记录](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/DESKTOP_VALIDATION.md)。

---

# 0.5.3 · 双向保留对话标题与项目名称

- 扫描列表与迁入目标共用同一标题解析：优先原生标题，无标题时使用首条用户消息提示；空白记录单独标注，不把 ID 当作正式标题。原生回读同时核对标题和正文。
- DSH → OpenCode：从工作区读取正式项目名，通过 OpenCode 1.x/2.x 支持的原生接口写入并回读。多个迁移任务共享项目名持有记录，最后一次回滚恢复迁入前名称；后续用户自定义改名保持不动。
- DSH 冷启动列表：补齐 v7 标题投影缓存，只写已落盘标题的派生行；首次展开项目即可看到标题，无需先打开对话。缓存与工作区都有独立回滚凭据，不覆盖既有缓存。
- OpenCode → DSH：保存原生项目自定义名、cwd 和对话标题，登记 DSH 工作区 v2 与会话成员。DSH 必须先退出，迁移完成后重新打开以加载项目；回滚同时清理本任务登记的信息，并保留其他项目及后续修改。
- 源元数据自扫描后变化会要求重扫；既有自定义项目名冲突会明确报错，不静默覆盖。原目录不存在时保留原件及 cwd，并在任务详情提示暂未分组；OpenCode 全局项目不会被单一源项目改名。
- 修复旧迁移默认 ID 标题：正文相同且目标仍是默认标题时按原件修复；回滚恢复原标题，不删除原有会话。用户自行修改过的标题保留。
- 插件端可从原生 workspaceRegistry 读取项目名并打包传输；本机一键、扫描选择和管理器路径继续保留。高级连接指定单一目标目录时不替源端移动项目文件。

[使用说明](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/MANAGER.md) · [验收记录](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/DESKTOP_VALIDATION.md)。CLI、原生数据回归与窗口点验分别记录，不互相替代。
