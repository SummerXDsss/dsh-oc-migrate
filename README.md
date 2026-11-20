# dsh-oc-migrate


## 一键桌面版

从 [Releases](https://github.com/SummerXDsss/dsh-oc-migrate/releases/latest) 下载对应系统安装包，打开后选择 **DSH → OpenCode** 或 **OpenCode → DSH**，点击「一键迁移全部对话」。自动发现本机 DSH 与 OpenCode，原件先备份、逐对话回读验证；无需安装插件或填写端口、令牌。原有插件与 CLI 工作链保留在高级流程。[桌面使用说明](docs/DESKTOP.md)。

也可点击 **「指定对话导入」**，在 **「项目与对话」** 中按项目浏览、搜索、预览上下文，设置本地显示名称/收藏，再批量迁移勾选的项目或对话。也可粘贴源对话 ID 精确选中，或在预览中仅导入当前一条；工作台与管理器均可直接切换方向。[管理器说明](docs/MANAGER.md)。

## 桌面应用（Tauri 2）

中文 GUI 是主要入口：选择方向 → 自动发现 → 一键迁移全部对话 → 原生回读验证。内置中间件与运行时；插件接收、手动连接和 CLI 保留为高级方式。

[下载桌面版](https://github.com/SummerXDsss/dsh-oc-migrate/releases/latest) · [桌面使用与开发](docs/DESKTOP.md) · [Windows / 普通 Linux 安装](docs/PLATFORMS.md)

```bash
npm ci
npm run desktop:dev
```

推送版本 tag 后，CI 并行回归与构建，全部成功才发布 macOS / Windows / Linux（DEB、RPM、AppImage）安装包和插件包。

GitHub CI 额度不足时，可直接在本机打包：`npm run release:local`。自动完成本地检查、构建本机安装包、附带插件与 SHA-256 清单，输出到 `artifacts/releases/`，不调用 GitHub Actions。[本地构建说明](docs/LOCAL_RELEASE.md)。

将 **DeepSeek Harness 的完整对话历史**经本地中间件迁移到 **OpenCode 1.x / 2.x**，供 CLI 和 GUI 查看、继续对话。

这是独立社区项目，与 DeepSeek 或 OpenCode 官方没有隶属关系。

```text
DSH Host 插件 → gzip 迁移包 → 本地中间件 → OpenCode 原生 import / export
                                                   ├─ CLI
                                                   └─ 同一后端的 GUI
```

## 许可证

从 **v0.5.9** 起，本项目自身代码以 [PolyForm Noncommercial 1.0.0](LICENSE) 公开源码。该许可范围之外的商业使用，请联系[作者](https://github.com/SummerXDsss)另行授权。分发新版时请附上许可证（或许可证中的网址）与 [NOTICE](NOTICE)。

**v0.5.8 及更早版本**仍按对应版本所附的 [MIT 许可证](https://github.com/SummerXDsss/dsh-oc-migrate/blob/v0.5.8/LICENSE)提供；新许可不追溯已按 MIT 发放的副本。第三方依赖继续适用各自的许可。

## 双向迁移

OpenCode → DSH 使用原生 export 读取全部项目、分支、归档，生成 DSH 原生 v4 JSONL/Zstd。保留标题、项目路径、正文、思考、历史工具结果与原始 JSON；重复截面去重，已修改/已取得 DSH 写入权的会话回滚时保留。不是实时同步，也不覆盖合并已继续的历史。扩展事件和压缩状态作为快照留存，附件保留引用。[边界、回滚与 CLI 用法](docs/BIDIRECTIONAL.md)。

```sh
# 自动发现本机 OpenCode，迁移全部对话到 DSH
node bin/dsh-oc-migrate.mjs to-dsh
```

## 当前进展

- 双向格式按双方原生 Schema 转换：正文/思考、工具配对/多段结果/错误、用量、时间和终止状态逐字段核对；同代往返恢复经校验的原始结构，跨代有独立适配器。[格式映射与不等价项](docs/FORMATS.md)。

- 已实现：`/oc-migrate current|list|all|SESSION_ID`、完整原始日志归档、压缩截面一致性检查、分批传输、本地持久化、双版本转换、原生导入适配、回读校验、重试和回滚保护。
- 对话分为“有效上下文”和“归档全文”。存在被压缩替换的消息时，默认额外生成 `[归档全文]` 会话，保留压缩前对话；原始事件日志始终另外留存。
- 已通过 OpenCode **1.18.31 / 2.3.2** 真实二进制隔离导入、导出回读、幂等和删除回滚；真实 DSH profile 与 GUI 显示验收另行记录，不以模拟测试代替。
- 文件/图片引用会保留；OpenCode export 自带的附件 data 也保留并可回程恢复。外部附件字节不自动读取，尚未写入 DSH 原生附件库；目标不支持的项明确显示快照/转换提示。历史进程、工具、审批、KV cache 不会恢复执行。

调研、版本与源码依据：[docs/RESEARCH.md](docs/RESEARCH.md)。

## 1. 安装与初始化

Node.js ≥ 22.19：

```bash
npm ci
npm run check
npm test
npm pack

node bin/dsh-oc-migrate.mjs init --state "$HOME/.local/share/dsh-oc-migrate"
```

令牌只写入权限为 `0600` 的文件，不打印到终端。以下命令中的项目路径请替换成实际 OpenCode 工作目录。

## 2. 启动本地中间件

```bash
node bin/dsh-oc-migrate.mjs serve \
  --directory /absolute/path/to/project \
  --token-file "$HOME/.local/share/dsh-oc-migrate/receiver.token" \
  --auto-import
```

默认只监听 `127.0.0.1:48765`。省略 `--auto-import` 时只接收并转换，检查后用 `retry JOB_ID` 导入。接收端目标目录和二进制由本机启动参数决定，导出包不能指定执行命令。

- `--binary /path/to/opencode`：选择二进制；默认执行 PATH 中的 `opencode`。
- `--generation auto|v1|v2`：自动读取版本，或强制校验版本。
- `--data-home /path/to/isolated/data`：隔离 OpenCode 数据目录；GUI 也必须连接相同后端才会看到会话。
- `--provider deepseek --model deepseek-chat`：显式重绑历史模型标识。继续对话前在 OpenCode 选择可用模型。
- `--no-archive`：只导入有效上下文，仍保存完整原始包。
- `--no-state-snapshots`：不向会话追加 goal/todo 文字快照，原始事件仍保留。

### GUI 连接的是另一台 2.x 服务器

```bash
node bin/dsh-oc-migrate.mjs serve \
  --directory /absolute/server/project \
  --token-file /absolute/path/receiver.token \
  --server http://127.0.0.1:4096 \
  --password-file /absolute/path/opencode-server-password \
  --auto-import
```

HTTP 适配器使用 OpenCode 2.x 原生 `/api/experimental/session/import`，并导出回读验证；认证默认为用户名 `opencode` 的 Basic Auth。使用 GUI 实际连接的服务器，不要把独立本地数据库的成功当作远端 GUI 成功。

## 3. DSH 插件

将 `npm pack` 生成的 `dsh-oc-migrate-0.3.0.tgz` 安装进 DSH 对应 profile，或在该 profile 中安装本仓库。参考配置如下（完整步骤见 [插件配置](docs/PLUGIN.md)）：

```yaml
- id: dsh-oc-migrate
  config:
    receiver: http://127.0.0.1:48765
    tokenFile: /absolute/path/receiver.token
    batchSize: 20
```

上例用于覆盖插件管理器已经创建的同 id 条目。手动新增时必须使用 `insert`，见插件配置文档。

插件依赖 `commands` 和 `sessionQuery`；需要 profile 已挂载官方查询 backend，例如 session-query-sqlite。它是 **Host 插件**，不是浏览器脚本。

```text
/oc-migrate list       # 列出所有可查询的 live / persisted 会话
/oc-migrate all        # 尽量完整迁移全部会话，包含压缩前原始事件
/oc-migrate current    # 当前会话（缺省）
/oc-migrate SESSION_ID # 指定会话
```

DSH Host 在远程机器时，`127.0.0.1` 是远程机器，需要 SSH 反向隧道与远程 token 文件，详见插件文档。

## 4. 本地导出文件与离线转换

输入为本项目版本化迁移包，不是任意 DeepSeek 网页 JSON，也不是 DSH 官方 ZIP 的直接解压内容。

```bash
node bin/dsh-oc-migrate.mjs convert /absolute/path/source.json \
  --directory /absolute/path/to/project --generation v1 --out /absolute/path/output

node bin/dsh-oc-migrate.mjs import /absolute/path/source.json \
  --directory /absolute/path/to/project
```

每个任务目录保留 `source.json`、逐会话原生 transcript 和 `report.json`。令牌、原始聊天、导出包、数据目录不要提交到仓库。

## 5. 回归与回滚

```bash
node bin/dsh-oc-migrate.mjs jobs
node bin/dsh-oc-migrate.mjs retry JOB_ID --directory /absolute/path/to/project
node bin/dsh-oc-migrate.mjs rollback JOB_ID --directory /absolute/path/to/project
```

重试/回滚时复用原来的 `--state`、`--binary`、`--data-home` 或 `--server`。回滚先回读核对，不删除已经新增或修改正文的会话、有新子会话的会话，也不删除由其他迁移任务提前创建的相同会话。失败导入保留原件及进度，重试不会执行历史工具。

开发回归：`npm run check && npm test`。真实二进制回归：`npm run test:integration`，使用隔离数据目录，不访问现有 OpenCode 历史。

## 后续

真实 DSH profile 与 GUI 验收、附件字节导出、超大单会话流式分片、DSH 旧版本格式矩阵。`all` 只覆盖查询 backend 当前可列出的会话，不声称能读取已经删除或不可访问的历史。

### 第一次使用

同机安装 OpenCode 1.x 和 2.x 时，默认会分别导入两代的原生历史；界面会先显示检测到的目标版本。两份历史的后续聊天不会自动同步。高级模式手动指定程序时，只导入该版本。回到 OpenCode 后请打开对应项目，从会话列表选择新记录；已撤销记录的旧标签页不会恢复。

扫描时，系统可能出现权限弹窗，请授予对话所在文件夹必要的文件读取权限。若读取被拒绝，界面会提示检查权限并重新扫描。

首次打开会显示可跳过的三步教程：选方向 → 决定搬哪些对话 → 了解检查与撤销。教程本身不会开始迁移；完成或跳过后不再自动显示，左侧「使用教程」可以重看。普通工作台不需要填路径、端口或连接信息；特殊安装位置、插件接收与文件导入统一放在「高级模式」。左下角可一键打开 GitHub 作者或项目主页。
