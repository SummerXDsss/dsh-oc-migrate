# DSH Host 插件安装

本包的根 ESM 导出为 `name / inject / Config / apply`，遵循用户指定指南和官方 Cordis 插件契约。所有导出都由手动 `/oc-migrate` 发起，不增加模型自动调用工具。

## 本地安装

1. 在仓库运行 `npm ci && npm pack`，得到 `.tgz`。
2. 使用 DSH 的 profile 插件管理安装这个本地包；若当前 DSH CLI 支持本地包参数，可使用 `dsh plugin --profile web add /absolute/path/dsh-oc-migrate-0.1.0.tgz`。具体参数以本机 `dsh plugin --help` 为准。
3. 在对应 profile 的 `cordis.patch.yml` 中配置插件。插件管理器已有条目时按实际 id 覆盖 config，不要重复挂载。手动新增插件行的完整 patch 是：

```yaml
- insert:
    - id: dsh-oc-migrate
      name: dsh-oc-migrate
      config:
        receiver: http://127.0.0.1:48765
        tokenFile: /absolute/path/receiver.token
        batchSize: 20
```

4. 确认该 profile 有 `commands` 和 `sessionQuery` 服务。官方查询 backend 同时覆盖 live 与 persisted 日志，插件不扫描 SQLite，也不依赖浏览器 DOM。
5. 启动中间件后，在 DSH 输入 `/oc-migrate list`，再输入 `/oc-migrate all`。检查返回的每批任务 ID 与状态。

本次仓库测试验证了插件入口、命令和查询契约；真实 DSH profile 安装结果应另行记录。

## 远程 DSH → 本地接收

从本地机器建立 SSH 反向隧道：

```bash
ssh -N -R 48765:127.0.0.1:48765 user@DSH_HOST
```

将本地 receiver.token 通过自己的 SSH 通道复制到远程的私有文件，设置 `chmod 600`，并让插件 tokenFile 指向远程文件。插件 receiver 仍是 `http://127.0.0.1:48765`。OpenCode 目标目录由**本地中间件**配置，不使用远程 DSH header.cwd 写入本地文件系统。

## 完整性

- `all` 会读取全部可列出的会话，包括不在 live store 中的持久化会话与子会话。
- 每个包包含完整 raw events、原始 header、继承前缀长度、有效 surface seq 列表。
- 插件比较 readSession/readSurface 的截面，持续变化时最多重试四次，随后明确报错；不拼接错位数据。
- 中间件独立折叠 surfaceOp，检查原始日志与有效上下文一致，再做转换；标题直接从同一 raw log 的 session/title 事件读取，避免另一截面的标题混入。
- `all` 遇到某个会话读取失败会继续读取其他会话，并在结果中列出失败 id 和已接收数量，不以部分成功冒充全量完成。
- 每批默认 20 个会话；解压后最多 64 MiB，压缩传输最多 16 MiB。大量会话分批落盘。单个超大日志需要后续分片支持。
- DSH 未记录的内容、已删除的会话与附件字节不在本阶段完整性承诺内。
