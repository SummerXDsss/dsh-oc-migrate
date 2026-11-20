# 0.4.1 · 双向一键迁移与 GUI 历史可读性

- 桌面工作台新增 DSH → OpenCode / OpenCode → DSH 方向切换，普通迁移仍无需配置。
- 支持 OpenCode 1.18.31 / 2.3.2 全项目、分支、归档枚举和原生导出，写入 DSH v4 JSONL/Zstd；标题、项目路径、文本、思考与历史工具结果保留。
- 原始 JSON 与日志备份、逐会话稳定性检查、严格原生格式回放、幂等、停止、重试和原目标回滚。
- CI 加入真实双版本往返、编译 sidecar 反向迁移及 DSH 原生持久化冷读取。修正官方 dsh-llm 动态 package.json 路径在单文件打包中的兼容问题。

迁移是历史快照，不是实时同步或仓库文件复制。OpenCode 压缩/revert/扩展事件作为快照保留，分支各自成为历史；附件保留引用，不重建 DSH 附件存储。源变化后生成新快照，不覆盖已继续的目标历史。DSH 已取得写入权、内容已变或出现分支时，回滚保留该会话。

反向迁移后重新打开 DSH 查看。已在 DSH NEXT 2.0.19-next 实际打开迁入的中文对话，展开核对助手回复、思考、工具参数与输出，并用 Open in Finder 核对原项目。OpenCode 2.3.2 已实际检查两个项目、主会话与压缩前归档。

0.4.1 为 DSH 工具加入直接可读的历史参数/结果快照，同时保留原生工具记录，解决 OpenCode 通用工具卡片展不开输出的问题。转换版本隔离新旧任务；重新迁移会生成新快照而非覆盖旧历史。窗口标题和上次迁移的方向标识同步修正。最终补丁窗口验收见验收记录。

安装与格式边界见 [双向迁移说明](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/BIDIRECTIONAL.md) 与 [桌面验收记录](https://github.com/SummerXDsss/dsh-oc-migrate/blob/main/docs/DESKTOP_VALIDATION.md)。
