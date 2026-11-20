# 回归记录

2026-11-20，macOS arm64。所有本机原生测试使用临时项目与独立 HOME / XDG 目录 / OPENCODE_DB，不接触用户现有会话。

## 已实际执行

| 层 | 验证内容 | 结果 |
| --- | --- | --- |
| 插件契约 | Host 插件具名导出、当前截面读取、完整 raw log、all 分批、坏会话继续、标题同截面、取消 | 通过；查询服务使用 fixture，不是真实 DSH profile |
| 本地中间件 | 实际 HTTP 接收、gzip/SHA-256、Bearer、大小限制、持久化、重复任务、失败重试、回滚保护 | 通过 |
| OpenCode 1.18.31 | 真实原生 import → export 核对 → 重复导入 → session delete → 确认不存在 | 通过 |
| OpenCode 2.3.2 | 真实原生 session import/export/delete，包含已失败工具记录 | 通过 |
| 2.3.2 服务器 | 真实 HTTP import、CLI 用 --server 连接同一后端 export、GUI 使用的 session-list API 读取、HTTP delete | 通过 |
| npm 包 | pack、临时目录安装、根插件导入、可执行 CLI 帮助、示例转换 | 通过；`npm run test:package` 可复现 |

测试入口：

```bash
npm run check
npm test
npm run test:package
OPENCODE_V1_BIN=/absolute/path/to/opencode-v1 \
OPENCODE_V2_BIN=/absolute/path/to/opencode-v2 \
npm run test:integration
```

CI 固定安装 `opencode-ai@1.18.31` 和 `@opencode/cli@2.3.2`，在 Linux 上重复原生回归。兼容 1.x/2.x 是两条版本适配路径，不等于每个历史小版本都经过验证；较老版本应先运行对应回归。

本地最新一轮：24 项单元/接收链路测试 + 3 项真实二进制/服务器测试均通过，0 skipped。Linux 原生 CI 已在 [a656109 对应运行](https://github.com/SummerXDsss/dsh-oc-migrate/actions/runs/44658267226) 通过；每批后续提交继续执行相同回归。

## 回归发现与修正

1. 2.x 的版本输出为 `opencode v2.3.2`，不是纯 `2.3.2`；已修正自动识别。
2. 压缩替换与状态快照可能把原始时间较早的事件追加到当前上下文末尾。1.x export 会因此重排消息。现在输出时间非递减，原始时间保留在 metadata 与 raw log；双版本回读顺序一致。
3. 当前 DSH 标题是 `session/title` 事件；直接在同一 raw 截面中提取，避免依赖另一读取截面的标题。
4. 自定义日志事件允许标量 data，不能因为扩展事件不是对象而阻断完整会话导出。
5. 回滚时先检查全部拟删除会话。已继续聊天或创建子会话的会话不删除；其他任务先前创建的相同会话也不删除。子会话保护已通过真实双版本创建分支、阻止回滚、清理分支后的正常回滚测试。
6. `/oc-migrate` 自己会产生审计事件。raw 包仍完整保存这些记录，但原生会话 ID 只跟随实际对话与状态变化，避免仅因导出命令尾巴变化而复制聊天。

## 尚未实机验收

- 真实 DSH profile 安装与用户历史导出。本机没有 PATH 可调用的 DSH CLI；本项目没有修改已有 DSH profile。
- OpenCode 原生桌面 GUI 的实际画面展示。服务器导入和 GUI 查询 API 已验证，不等于 UI 已点验。
- 附件字节、超大单会话分片、已删除历史恢复。当前保留附件引用与原始 JSON，并生成显式告知。

## 增量提交

- `8ce113e`：初始插件、中间件与双版本转换，单元测试。
- `f07bc1e`：真实双版本回归、时间顺序修复、全量读取错误隔离。
- 后续提交继续独立记录 CI 与回归结果。代码回滚优先使用 `git revert COMMIT`，不重写 main 历史。
