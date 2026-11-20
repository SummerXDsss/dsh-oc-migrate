# 双向对话格式转换

关联 [Issue #3](https://github.com/SummerXDsss/dsh-oc-migrate/issues/3)。本次对照版本：DSH `0.2.1-rc.2` / v4，OpenCode `1.18.31`、`2.3.2`。

## 格式由各自源码决定

- [DSH 消息与内容块](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/core)：日志事件与有效 surface 分开，工具结果是独立消息；工具参数为原始 JSON 字符串，图片/文件是 attachmentId 引用，不等于图片/文件字节。
- [OpenCode 1.x 消息](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/core/src/session/message.ts)：`{ info, parts }`，工具结果放在 tool part 的 state 中。
- [OpenCode 2.x 消息](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/schema/src/session-message.ts)：用户为 `text/files/agents/skills`，助手为 `content`；工具结果为 `state.content`，不同于 1.x 的 `state.output`。
- [2.x 附件](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/schema/src/prompt.ts)：原生附件含 base64 `data`，或服务器媒体引用；不能把 DSH attachmentId 直接当 OpenCode URL 使用。
- [2.x 工具内容](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/schema/src/tool.ts)：text / file 两种内容块，不能只取第一段文字。

## 验收重点

逐项核对正文与换行、角色、思考块、工具参数/调用 ID/多段结果/错误、用量、时间、终止状态及附件引用。只有可等价字段才写入目标原生字段；非等价字段必须在原件及转换记录中保留，并明确告知。工具历史只作记录，迁移不执行工具。

完整原始 DSH 日志 / OpenCode export 始终保存在本地迁移任务中。活动上下文与压缩前归档分开；引用存在不代表附件字节已迁移。
