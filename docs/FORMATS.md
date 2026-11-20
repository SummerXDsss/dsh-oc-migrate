# 双向对话格式转换

关联 [Issue #3](https://github.com/SummerXDsss/dsh-oc-migrate/issues/3)。本次对照版本：DSH `0.2.1-rc.2` / v4，OpenCode `1.18.31`、`2.3.2`。

## 格式由各自源码决定

- [DSH 消息与内容块](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/llm/llm/src/types.ts)：日志事件与有效 surface 分开，工具结果是独立消息；工具参数为原始 JSON 字符串，图片/文件是 attachmentId 引用，不等于图片/文件字节。
- [OpenCode 1.x 消息](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/schema/src/session-v1.ts)：`{ info, parts }`，工具结果放在 tool part 的 state 中。
- [OpenCode 2.x 消息](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/schema/src/session-message.ts)：用户为 `text/files/agents/skills`，助手为 `content`；工具结果为 `state.content`，不同于 1.x 的 `state.output`。
- [2.x 附件](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/schema/src/prompt.ts)：原生附件含 base64 `data`，或服务器媒体引用；不能把 DSH attachmentId 直接当 OpenCode URL 使用。
- [2.x 工具内容](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/schema/src/tool.ts)：text / file 两种内容块，不能只取第一段文字。

## 验收重点

逐项核对正文与换行、角色、思考块、工具参数/调用 ID/多段结果/错误、用量、时间、终止状态及附件引用。只有可等价字段才写入目标原生字段；非等价字段必须在原件及转换记录中保留，并明确告知。工具历史只作记录，迁移不执行工具。

完整原始 DSH 日志 / OpenCode export 始终保存在本地迁移任务中。活动上下文与压缩前归档分开；引用存在不代表附件字节已迁移。

## 当前实现的字段映射

| 内容 | DSH v4 | OpenCode 1.x | OpenCode 2.x |
| --- | --- | --- | --- |
| 用户正文 | `user/message.content[]` | `info.role=user` + text parts | `type=user,text` |
| 助手正文、思考 | assistant content text / reasoning | text / reasoning parts | assistant content text / reasoning |
| 工具调用 | tool-call 原始 JSON 字符串 | tool part `callID/tool/state.input` | tool content `id/name/state.input` |
| 工具结果 | 独立 tool/result、多块 content | `state.output/error`，单字符串；文件由 attachments 表达 | `state.content[]`、结构化 error |
| 工具错误/未完成 | `isError`、原始状态另存 | error state | error state；原始 streaming/running 不恢复执行 |
| token 用量 | `inputTokens/outputTokens/reasoningTokens/cacheReadTokens/cacheWriteTokens` | `tokens.input/output/reasoning/cache` | 同 1.x |
| 中断、终止 | interrupted / 原始 finish stream | finish/error | finish/error |
| 时间与模型 | event.time / model source | info.time、tool.state.time、providerID/modelID | message.time、tool.time、model |
| 已有原生图片/文件 | 作为快照与回程结构保留，不冒充已入 DSH 附件库 | data URL file part | files 中 base64 data 或原始 URI |
| 系统/开发者、特殊事件 | 原始角色/数据保留 | 不等价项用显式历史快照，不改目标系统配置 | 可验证的同代回程恢复原生消息类型 |

### 往返保真，而非反复拼接文字

- DSH → OpenCode：在允许的 metadata 字段保存 `dshSource` 和语义 SHA-256。返回 DSH 时，只有原生正文、工具参数、附件、用量、时间等仍匹配，才恢复原始消息角色、分块、参数字符串及工具结果。已修改的内容按现值转换，绝不用旧原件覆盖。
- OpenCode → DSH：使用官方支持的 `ignorable: true` 日志扩展 `migration/opencode-message` 保存原生记录与 surface 校验值。官方 codec 严格校验完整日志；DSH 当前上下文只使用原生 surface，不把回程元数据当成模型消息。
- 返回同代 OpenCode：校验 surface 未被替换/编辑后恢复原生记录，重新绑定新的 session/message/part ID 与目标项目；保留原始时间、files/agents/skills、工具多段内容、错误和 finish。
- 返回另一代：使用独立适配器做原生字段转换；data URL ↔ inline files、工具结果/错误、模型/用量/时间逐字段映射。多段工具文字变成 1.x 的单 output 等非等价项给出提示，原始结构仍保留。
- 工具可读副本带 hash 标识，反向时只去除验证匹配的自动副本；不会凭文字前缀删除用户正文。同代/跨代往返均不会越迁越多。
- 导入回读不再只比正文：同时检查附件、工具内容、模型/用量、终止原因和时间。旧版反向任务按旧转换版本重试/撤销，不拿新版本重算历史路径。

### 明确区别：保留引用、保留字节、原生可用

原始 OpenCode export 若自带附件 data，迁移包和回程结构会保留这些字节，并能在返回 OpenCode 时恢复原生附件。**DSH 阶段尚未把这些字节写入 DSH 附件库**，因此在 DSH 内显示为有提示的历史快照，不能称为原生可点开图片。DSH 自身的 attachmentId、OpenCode `file:`/`media:` 外部引用不自动读取或下载；它们没有内嵌字节时，只保留引用及原始结构。此类转换会在任务 warnings 中明确展示。

转换版本升级不会覆盖已迁入且正在使用的历史；再次主动迁移相同源会生成新版格式的独立会话，可单独核对和撤销。
