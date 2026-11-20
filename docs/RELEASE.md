# 0.4.0 · 双向一键迁移

- 桌面工作台新增 DSH → OpenCode / OpenCode → DSH 方向切换，普通迁移仍无需配置。
- 支持 OpenCode 1.18.31 / 2.3.2 全项目、分支、归档枚举和原生导出，写入 DSH v4 JSONL/Zstd；标题、项目路径、文本、思考与历史工具结果保留。
- 原始 JSON 与日志备份、逐会话稳定性检查、严格原生格式回放、幂等、停止、重试和原目标回滚。
- CI 加入真实双版本往返、编译 sidecar 反向迁移及 DSH 原生持久化冷读取。修正官方 dsh-llm 动态 package.json 路径在单文件打包中的兼容问题。

迁移是历史快照，不是实时同步或仓库文件复制。OpenCode 压缩/revert/扩展事件作为快照保留，分支各自成为历史；附件保留引用，不重建 DSH 附件存储。源变化后生成新快照，不覆盖已继续的目标历史。DSH 已取得写入权、内容已变或出现分支时，回滚保留该会话。

反向迁移后重新打开 DSH 查看。原生数据回归与 GUI 窗口验收分别记录；本轮新增 DSH GUI 窗口点验仍待 Mac 解锁，不能以存储回读通过代替界面完整性通过。先前 OpenCode 2.3.2 原生工具卡片展开输出的展示问题仍保留记录。

安装与格式边界见 [双向迁移说明](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/BIDIRECTIONAL.md) 与 [桌面验收记录](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/DESKTOP_VALIDATION.md)。
