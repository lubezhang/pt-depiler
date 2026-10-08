# 阶段 C 本地实现与验收

日期：2026-10-08。目标平台：macOS arm64。基线：`c3deef0`；结果对应当前工作区。

## AP-11：统一 JSON 恢复

生产恢复由 `BackupService` 组装选中域，经 `restore_backup_snapshot` 提交。配置、metadata、用户历史、搜索快照、辅种任务及下载历史均写入同一 `app-state.json`；不再分别调用 `mergeBatch` 和 `replace_download_history`。不含 Cookie 的恢复只替换一次文件，业务值与 `completed` 标记一起落盘。预先校验域类型、历史 ID/重复 ID、metadata 集合、实体 ID、host 映射及默认下载器引用；校验失败保留原文件。全局 revision 比较拒绝恢复准备期间的并发修改。

含 Cookie 的日志保存所选域的前后镜像；完成/回滚时将镜像裁剪，仅保留 ID、Cookie 标识和阶段。其他 Repository 写入在未决恢复或 Cookie 补偿文件存在时拒绝。文件替换后目录同步失败进入提交不确定状态，重新读取磁盘核对后才继续。

旧 IndexedDB `restore_journal` 仅在主窗口读取，统一 JSON 标记提交后才清理；辅助窗口等待旧恢复检查完成，再进入历史迁移。清理失败保留源，下次启动重试。兼容输入支持 `storageBefore`/`storageAfter`（或 `before`/`after`）与 `downloadHistoryBefore`/`downloadHistoryAfter`；按当前值与两份镜像比较后回滚。已完成日志只登记导入，不回滚。无可识别镜像、Cookie 旧操作或并发冲突转 `manualRecovery`，保留源并阻断业务启动，不猜测旧 payload。

| 恢复日志阶段                   | 活动 JSON          | 启动行为                                             |
| ------------------------------ | ------------------ | ---------------------------------------------------- |
| 尚无对应日志、存在 Cookie 副本 | 恢复前             | 按副本确认 Cookie 未出现并发修改后回滚孤立副本       |
| `prepared`                     | 恢复前业务值       | 回滚 Cookie 和所选 JSON 域，标记 `rolledBack`        |
| `jsonCommitted`                | 恢复后业务值及历史 | 条件确认 JSON 和 Cookie 镜像，继续 Cookie 提交并完成 |
| `completed`                    | 恢复后             | 幂等清理同操作 Cookie 副本                           |
| `rolledBack`                   | 恢复前             | 幂等清理恢复副本                                     |
| `manualRecovery`               | 保留现场           | 阻断业务写入，诊断仅返回 ID/阶段                     |

## AP-12：Cookie 补偿

Cookie 的恢复前/后完整 Store 保存于独立敏感文件 `cookies.v2.restore.json`，通过同目录临时文件、文件同步、原子替换及目录同步持久提交。文件由 `NamedTempFile` 创建，macOS 使用私有文件权限。统一 JSON 日志仅保存操作关联和所选 JSON 域镜像，不存 Cookie 正文。

实际顺序为：所有数据校验与容量预检 → Cookie 补偿文件 → JSON `prepared` → JSON 业务域/历史及 `jsonCommitted` → Cookie 文件替换 → JSON `completed` → 清理补偿文件。Cookie Store 锁覆盖整个提交过程。Tauri setup 在开放 IPC 与业务页面前核对恢复；Cookie 与 JSON 并发冲突保留资料，稳定错误码为 `STORAGE_RECOVERY_REQUIRED`/`STORAGE_CONFLICT`。正常恢复没有选择 Cookie 时完全不触碰 Cookie 文件。

定向测试覆盖五个边界的独立子进程直接退出，再由父进程重开 Repository/Store 并执行生产恢复函数；另覆盖模拟重启、幂等恢复、Cookie 并发冲突、无效输入、同步失败核对和历史冲突不覆盖。

## AP-13：备份格式与选项

| 格式                             | 散列/大小                            | 加密                                                                                            | 恢复语义                                               |
| -------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 无 `formatVersion` 的旧 ZIP / v1 | MD5；导入执行容量限制                | 保留旧 CryptoJS AES-CBC + MD5 派生兼容读取                                                      | 先完整解析校验，再恢复选中域；凭据/Cookie 仍需显式选择 |
| 本轮 v2 ZIP、数据版本 1          | 每文件 UTF-8 字节数、SHA-256、域清单 | AES-256-GCM，PBKDF2-SHA-256，210000 次，16 字节 salt、12 字节 nonce；认证头绑定版本/域/安全选项 | 所有文件通过大小、散列、认证、域和版本检查后才返回数据 |
| 第三方专用格式                   | 原适配器约定                         | CookieCloud/Gist 等专用字段格式保留                                                             | 适配器解码后仍进入应用恢复用例及 Rust 校验             |

当前检出代码实际上只有旧 CryptoJS AES-CBC；文档较早的 GCM 记录不能作为实现证据。本轮仅在新 v2 ZIP 补齐上述认证加密，旧 `encryptData`/`decryptData` 继续服务兼容格式，不将旧 v2 SHA-256 + CBC 草稿伪装为正式认证格式。

容量限制：归档 64 MiB，单文件 32 MiB，manifest 64 KiB，文件数最多 32。解压前检查 ZIP 声明大小及原始归档路径（含 JSZip 会规范化的 `../`），解压时累计实际字节数，拒绝多余文件、缺失文件、错误路径、未知域、未来版本和损坏认证。输入对象保持不变。

默认导出即使配置了密钥也不包含凭据；本地导出有独立“包含账号凭据”开关，Cookie 通过域开关单独选择。包含凭据或 Cookie 必须配置密钥，备份密钥始终排除。数据与密钥来自一次 Repository 快照；显式 Cookie 导出再核对一次 Cookie 快照，变化时拒绝。默认恢复不选择 Cookie、不恢复备份中的凭据，保留匹配实体的本地凭据和本地备份密钥；新实体或类型变化不继承旧凭据，标记待配置。

## AP-14 / AP-15：生产调用链

| 调用                                          | 生产装配                                                           | 注入端口                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 搜索 → `getSiteInstance` → 站点基类/定义      | `offscreen/utils/search.ts`、`adapter/site.ts`                     | 搜索上下文 HTTP、设置和日志；站点时钟/延迟；资源 ID `site:<id>`       |
| 用户信息、下载链接、Avistaz 专用请求、favicon | `offscreen/utils/site.ts`、相同站点工厂                            | HTTP、设置、时钟、日志；favicon 显式 HTTP                             |
| 下载器管理/种子提交                           | `DownloadService` / `DownloadSubmission`、`adapter/downloader.ts`  | 当前配置读取、客户端工厂、HTTP、种子 HTTP、专用 WebSocket             |
| 备份导出/恢复/远端核对                        | `BackupService` / `RemoteBackupService`、`adapter/backupServer.ts` | 已提交快照、恢复提交、清理投影、时钟、当前资源配置、HTTP、专用 WebDAV |
| 登录表单、验证码、交互登录、账号校验          | `createAccountService`、options 装配                               | 资源 HTTP、Cookie 查询、交互窗口、当前站点配置/实例、延迟             |

站点基类、下载器和备份适配器不再默认读取 legacy HTTP；缺少端口明确失败。Avistaz 自定义请求、Zhuque/HDsky 运行设置与 favicon 的旁路已接入注入端口；删除站点包的 entries 导入及三项旧边界例外。旧无调用客户端常量和全局 WebDAV 补丁的完全删除保留为 AP-17；WebDAV 现在由专用端口登记资源 HTTP，Aria2 延迟通过专用 WebSocket 端口建连。

应用用例不读取 Pinia，不调用任意 `invoke`。下载器实例复用前重读完整配置，配置变化重建实例；备份每次请求重读服务配置；账号校验重读站点配置并拒绝过时 origin。Rust 策略支持显式站点 ID 和指定备份供应商 ID，删除/修改资源后旧请求不能借其他资源获得授权。

## 验证结果及范围

新增并发回归还验证：Repository 显式释放文件锁，即使其他线程启动的子进程在 exec 前暂时继承文件描述符，释放后也能立即重开；stderr 容量夹具批量生成 5,000 字节，保留 4,096 字节上限断言。

`pnpm verify:desktop` 包含格式、TypeScript、架构、诊断、全部前端测试、前端构建、Rust fmt/Clippy/测试和 macOS debug 构建。独立入口与断言范围见 [AP-11](./AP-11.md)、[AP-12](./AP-12.md)、[AP-13](./AP-13.md)、[AP-14](./AP-14.md)、[AP-15](./AP-15.md)。

最终 `pnpm verify:desktop` 退出码 0：前端 **53 文件、189 项**，Rust **76 项**通过；格式、TypeScript、架构、诊断、Vite、Rust fmt/Clippy 和 macOS debug 构建均通过。独立 AP 前端入口分别为 3/2/1/2/3 项；Rust AP-11/12/13 分别为 8/6/1 项。恢复子进程中断的 5 个边界均重开生产文件验证。结构化门禁与定向结果见 [AP-C-verification.json](./AP-C-verification.json)。`git diff --check` 无错误。

本轮完成本地实现及自动化验收。真实外部账号、WebDAV/云备份和下载器服务的联调、GUI 全阶段故障及并发恢复演练、真实历史规模容量复核仍按计划 AP-19/AP-20 验收；项目当前仅支持 macOS，Windows/Linux 不属于验收范围。未知旧日志转人工恢复的安全阻断已实现；人工处置界面及完整运维诊断收口属于 AP-18，不宣称在本轮完成。

## 隔离原生 GUI 证据

使用新的 `/tmp/ptd-stage-c-gui.*` 临时目录，同时隔离 Rust 文件和 WKWebView 数据存储；Vite 使用专用 5193 端口。`pnpm tauri dev` 实际退出码 0；主窗口完成启动、已提交快照、默认导出、v2 ZIP 加解密、错误密钥拒绝、默认恢复保留 Cookie、显式恢复 Cookie/JSON 一致及脱敏状态检查，然后正常释放关闭。固定数据只包含 `isolated-*` 哨兵值，不连接外部服务。结果见 [AP-C-gui.json](./AP-C-gui.json)，不含配置、凭据或 Cookie 正文。

复现命令：

```sh
cat > /tmp/ptd-stage-c-dev-config.json <<'JSON'
{"build":{"devUrl":"http://localhost:5193","beforeDevCommand":"pnpm dev --port 5193 --strictPort"}}
JSON
PTD_E2E_DATA_DIR="$(mktemp -d /tmp/ptd-stage-c-gui.XXXXXX)" \
PTD_STAGE_A_GUI=1 VITE_STAGE_A_GUI=1 VITE_STAGE_C_GUI=1 \
pnpm tauri dev --no-watch --config /tmp/ptd-stage-c-dev-config.json
```

验收入口只在显式 debug 环境变量下运行；生产构建不进入该路径。此结果证明本机新安装开发启动及生产备份链，不替代 AP-20 的旧版本升级/跨窗口/分阶段 GUI 故障演练。
