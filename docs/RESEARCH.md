# DeepSeek Harness → OpenCode：源码调研与实现边界

调研日期：2026-11-20（Asia/Singapore）。先完成本记录，再实现迁移链路。

## 1. 结论

链路分成三个部分，而不是让 DSH 插件直接改 OpenCode 数据库：

```text
DSH Host 插件（手动斜杠命令）
  └─ sessionQuery：完整事件日志 + 同一截面的有效 surface
      └─ 版本化 JSON 包 / gzip + SHA-256 + 本地接收令牌
          └─ 本地中间件：验包 → 留存原件 → 转换 → 幂等任务记录
              ├─ OpenCode 1.x：opencode import FILE
              ├─ OpenCode 2.x：opencode session import FILE
              └─ OpenCode 2.x GUI 所连服务器：原生 session import HTTP API
                  └─ CLI / GUI 查看同一后端的同一会话
```

**原始日志、当前模型上下文、运行时状态不是同一个东西。** 可以迁移对话、已记录的 reasoning、工具调用结果、压缩后上下文及状态的文字快照；历史执行进程、待审批请求、运行中的工具、沙箱、模型 KV cache 不会因此复活。已有记录不重新执行。

## 2. 本次核对的版本

| 对象 | 核对基线 |
| --- | --- |
| 本机 OpenCode | `1.18.31`（实际执行 `opencode --version`） |
| OpenCode 1.x 源码 | tag `v1.18.31` |
| OpenCode 当前 dev | `7b6b2858d943ea4bda4a1ea325a4609b633d0f04` |
| DeepSeek Harness master | `2e39e70496aa02986ca6a820c5d497e816b69d7e` |
| 插件开发指南 | [用户指定指南](https://lgiang517.github.io/deepseek-harness-plugin-guide/)；已下载并阅读，其中部分 `ctx.session` 简写应以官方 `ctx.sessions` / `agent.session` 为准 |

不能把当前 dev 的结构当成本机 1.x 的结构。实现分别输出 v1 和 v2 transcript，目标版本自动探测，也允许显式指定。

## 3. OpenCode 的会话存储

### 3.1 1.x

[导入命令源码](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/cli/cmd/import.ts) 接收：

```js
{ info: sessionInfo, messages: [{ info: messageInfo, parts: [...] }] }
```

[SQL 表](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/core/src/session/sql.ts) 同时有旧 transcript 的 session/message/part 表及新架构会话表，具体以该版本源码为准。不要只看到一个 SQLite 文件，就假定所有版本字段相同。

[v1 schema](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/schema/src/v1/session.ts) 要求 user 有 agent/model，assistant 有 parentID、providerID、modelID、mode、path、cost、tokens。工具结果在 assistant 的 tool part 中，不是另建一个 `role=tool` 消息。reasoning 是独立 part。

原生 import 会把项目与 directory 重绑到命令运行目录。它逐条写入且冲突时忽略已有消息，**不是全包事务，也不是可靠的更新接口**。中间件因此给每个内容版本分配新 ID，重试使用同一组 ID，并在导入后 export 回读核对；部分失败不声称成功。

数据目录通常在 `~/.local/share/opencode`，数据库路径必须通过 `opencode db path` 确认。`XDG_DATA_HOME`、`OPENCODE_DB`、开发渠道可能改变位置。

### 3.2 2.x

[SQL 表](https://github.com/anomalyco/opencode/blob/7b6b2858d943ea4bda4a1ea325a4609b633d0f04/packages/core/src/session/sql.ts) 使用 `session_v2` 和 `session_message`；消息的 JSON `data` 包含 content parts，大的媒体内容可进入 blob/blob_ref。不是 1.x 的独立 part 表方案。

[SessionTransfer.Data](https://github.com/anomalyco/opencode/blob/7b6b2858d943ea4bda4a1ea325a4609b633d0f04/packages/schema/src/session-transfer.ts) 的消息是原生 `SessionMessage.Info[]`，如 `{type:'user',text,...}` 或 `{type:'assistant',content:[...],...}`。

[CLI import](https://github.com/anomalyco/opencode/blob/7b6b2858d943ea4bda4a1ea325a4609b633d0f04/packages/cli/src/commands/handlers/session/import.ts) 调用 `POST /api/experimental/session/import`，body 为 transcript 加 `location:{directory}`。已存在的 ID 返回 409。中间件遇到冲突要 export 核对，不能把任意 409 当成功。

当前 [CLI 文档](https://opencode.ai/docs/cli/) 说明，本地客户端默认共享一个用户级后台服务；[API 文档](https://opencode.ai/docs/api) 提供导入、导出和删除会话的入口。2.x 默认路径可用 `opencode debug paths db` 查询。

### 3.3 CLI 与 GUI

GUI 是客户端，不需要另外发明一套聊天存储。GUI 和 CLI 使用同一数据目录/用户/后台服务，导入一次即可；GUI 中打开相同项目并刷新。如果 GUI 连接另一台服务器或另一数据目录，应将它视为另一个导入目标。2.x 用该服务器的 HTTP import API，不能把“本地 CLI 导入成功”写成“远端 GUI 导入成功”。本次实现不通过 prompt/noReply 伪造历史，也不触发模型。

## 4. DSH 如何读取历史

[官方 session-query 说明](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session-query/session-query/README.md) 和 [实际实现](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/session-query/session-query/src/index.ts)：

- `ctx.sessionQuery.listSessions()` 列出 live 与 persisted 的逻辑会话。
- `readSession(id)` 返回 `{session, inheritedEventCount, events}`，包括完整原始日志；优先读取 live 对象，不必把旧会话恢复运行。
- `readSurface(id)` 返回同类 header、`capturedThroughSeq` 和按模型顺序排列的有效事件。压缩替换的旧消息不在当前 surface，但还在 raw log。
- 读取完整日志和 surface 是两次调用；插件比较最高 seq，若期间增长则重试，不能拼接两个不同截面。
- `sessionQuery` 由实际 backend 提供，常见组合是 session-query-sqlite；仅安装抽象包并不会有服务。

[SessionEvent 类型](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/core/session/src/types.ts) 定义：user/message 的 data 就是 UserMessage；system/developer/assistant/message 和 tool/result 的消息在 data.message。不能把所有 `data.content` 直接当成消息。流式 chunk、attempt、turn/step 边界不是独立聊天消息。

## 5. 插件制作方式

指南和官方命令插件采用 Cordis Host 插件，具名导出 `name`、`inject`、`Config`、`apply`。本项目注册 `/oc-migrate`，依赖 `commands` 与 `sessionQuery`：

- 默认只导出当前 `invocation.agent.session.id`；`list` 列出历史；显式 `all` 才批量发送。
- `recordInput:false` 避免令牌或导出参数进入用户输入日志；不注册模型可自动调用的导出工具。
- 配置本地 receiver URL 和 token 文件，收集日志，打包，传递 `invocation.signal`。
- 插件运行在 Host，不是浏览器扩展，因此没有浏览器跨域限制。DSH 在远程服务器上运行时，loopback 指远程 Host，应使用 SSH 端口转发到本地接收端。
- npm 包的根导出是插件；bin 是中间件 CLI。使用本地 `.tgz` 安装到 DSH profile，保持插件可独立分发。

## 6. 转换策略

| DSH 内容 | OpenCode 表达 |
| --- | --- |
| 当前 user/message | user 文本与可识别的内容块 |
| assistant 文本 / reasoning | 原生 text / reasoning part |
| 工具调用与结果 | assistant 的已结束 tool part；缺失结果标成历史中断，不创建 pending 工具 |
| system/developer 快照 | 标注来源的历史上下文文本；不替换 OpenCode 自己的系统提示词 |
| 压缩替换后的消息 | 有效 surface 进入可继续对话的会话；存在旧内容时另建 `[归档全文]` 会话；原始包另存全部日志 |
| todo/goal/request header 等状态 | 原始事件保留；可读状态附录明确标为快照 |
| 未识别块/附件引用 | 文字说明与原始 JSON 留存；不偷偷下载引用或伪称附件字节已迁移 |
| 子会话 | 批量导出时独立会话；原始 parentSession 保留在迁移 metadata，不伪造可恢复的子代理进程 |

选择目标 provider/model 是继续对话时的配置，不代表跨供应商 reasoning 签名或缓存可重放。缺省使用明确的迁移模型标识，实际继续对话前在 OpenCode 选择已配置模型。

## 7. 第一阶段验收

1. 插件包能加载，斜杠命令可以打包当前/指定/全部历史。
2. 本地接收端完成鉴权、大小校验、校验和、原件持久化、幂等任务、失败重试。
3. 双版本原生 transcript 转换通过测试，顺序、父消息、工具配对和压缩语义有回归覆盖。
4. 本机 1.x 使用隔离的数据目录实际 import/export/delete，不接触现有历史。
5. 2.x 接口以源码协议测试核对，并在本地临时安装的 2.3.2 二进制上做隔离验收。
6. GUI 真实显示和真实 DSH profile 操作需分别验收，不用 mock 测试冒充。

## 8. 后续工作

真实 DSH 导出样本与 profile 验收、多媒体附件二进制打包、更多 1.x/2.x 小版本回归、GUI 端到端展示、超大日志流式接收。按迁移单回滚已实现并经过真实双版本验收；回滚不会删除正文已变化的会话。
