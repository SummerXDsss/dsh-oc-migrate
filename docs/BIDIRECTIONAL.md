# 双向迁移（0.4）

桌面工作台只增加一个方向选择：**DSH → OpenCode** / **OpenCode → DSH**。默认自动发现位置，不开启后台同步。

## OpenCode → DSH

- OpenCode 1.x 通过原生 CLI 的只读 `db` 查询列出全局会话；2.x 通过无项目、父会话、归档过滤的原生 API 游标分页。逐条使用原生 export，不直接写 OpenCode 数据库。
- 保留源项目绝对路径、标题、文本、思考和历史工具调用/结果；未完成工具关闭为历史错误，不执行任何工具。
- 写入 DSH 原生 v4 JSONL/Zstd，路径遵循官方 project-key 规则。自动沿用目标目录编码；新目录默认 Zstd。使用固定版本的 DSH 官方 Session / format catalog 严格检查生命周期、工具配对、surface 与消息结构，再原子发布完整新日志。
- 原始 OpenCode export JSON、生成的日志和 SHA-256 保存在本地任务目录。二次导出一致后才导入；源仍在生成时报告错误。单条失败不阻断其他会话，停止操作在当前会话结束后生效。
- 同一完整截面重复导入去重；源内容或元数据变化后生成新快照，**不会合并覆盖已继续的目标对话**。
- 不伪造 DSH 执行状态：OpenCode 分支各自成为独立历史，原父会话 ID 和项目 ID 保留在原件；压缩、system、shell、扩展事件以文本快照保存，原始压缩/revert 状态不作为 DSH 当前执行状态恢复。
- 附件引用保留，原 export 包含的内联内容也留在原件；不自动复制外部附件文件或为 DSH 重建 attachment store。
- DSH 需要重新打开或刷新会话列表发现外部历史。原项目目录和 project-key 保留；未在 DSH 注册的工作区可能位于 Ungrouped，工作区列表不是日志目录映射的自动复制。原生格式校验与 DSH 桌面真实窗口验收分别记录，不将回读通过等同于 GUI 完整性通过。

## 回滚边界

只回滚任务自己创建且日志哈希未变、无子分支、目录没有额外文件的历史。已有会话不会据为己有。DSH 一旦出现 `session.lock`（客户端取得过写入权）也保留，不移除官方稳定锁 inode；即便客户端后来关闭，也不会猜测锁已释放。原件始终保留，可再次导入。

## CLI

```sh
# 默认读取本机 OpenCode 的全部项目、分支、归档；优先 GUI 自带 CLI。
dsh-oc-migrate to-dsh
# 单个原生 export，或自定义/隔离的目标位置。
dsh-oc-migrate to-dsh export.json --dsh-root /absolute/path/sessions
# 可指定另一个 OpenCode 版本 / XDG 存储。
dsh-oc-migrate to-dsh --binary /absolute/path/opencode --data-home /absolute/path/data
# 反向任务自动使用记录的原目标，无需再填写 --directory。
dsh-oc-migrate jobs
dsh-oc-migrate rollback JOB_ID
dsh-oc-migrate retry JOB_ID
```

官方存储实现参考：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session)。运行时 Session / codec 固定为 `0.2.1-rc.2`，日志格式 v4。遇到新格式显式报错，不静默降级。
