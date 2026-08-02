# Changelog

## [0.1.4] — 2026-08-02

### 性能：IMAP / SMTP 连接池
- **IMAP 连接池**（`backend/imap-backend.mjs`）：per-email 单连接复用（TLS 握手只做一次）。
  - `poolAcquire` / `poolRelease` + `withImap` 统一执行器：连接建立期间置 busy 占位（防并发重复建连），同账号并发请求排队、唤醒后递归重试；
  - 凭据变更（acquire 时 password 不一致）自动销毁重建 —— 账号编辑后即时生效；
  - 操作抛错即销毁连接（不复用可能损坏的会话）；空闲 60s 回收（定时器 `unref`，不阻塞 CLI 模式进程退出）；
  - `closeAllImap()` / `closeAll()` 导出，worker 退出时优雅关闭。
- **SMTP transporter 池**：`nodemailer pool: true`（maxConnections 2 / maxMessages 200），send / reply / forward 复用 TLS 连接，配置或凭据变更自动重建。
- **worker.mjs**：退出时调用 `closeAll()` 关闭全部 IMAP/SMTP 连接。
- 全部 IMAP/SMTP 操作（list/read/delete/send/reply/forward/download/folders/markRead/markSpam/move/appendToSent）改为池化执行。
- 验证：连接池算法单测 11 项 PASS（建连/复用/并发排队/凭据变更重建/错误销毁/异账号隔离），全量语法检查通过。

## [0.1.3] — 2026-08-02

### 性能重构：常驻 Worker 后端
- **新增 `backend/worker.mjs`**：常驻进程，经 stdin/stdout JSON-RPC 接收命令，复用 `inbox.mjs` 的 `COMMANDS` / `parseOptions` 命令表执行（与 CLI 行为一致）。日志走 stderr，stdout 只承载协议。
- **新增 `backend/worker-client.mjs`**：宿主侧客户端，模块级单例。懒启动（首个请求时 spawn）、等待就绪信号后放行、按 id 匹配响应支持并发、请求超时（默认 90s）、崩溃指数退避自动重启、`shutdownWorker()` 优雅关闭。
- **routes/ui.js 与 tools/folders|messages|send|sync.js**：`runInbox` 从「每次 execFile 冷启 node 子进程」改为 `workerClient.runCli` IPC 调用——**调用点与 CLI 参数格式完全不变**，行为等价。
- **并发安全**：每个请求前注入该账号凭据 env + `inbox.resetAccountCache()`；env 应用与命令入口同步段在 Node 单线程内原子完成，不同账号并发请求不会互相污染。
- **生命周期**：`index.js onunload` 关停 worker；`cleanup.cjs` 同时扫描/清理 `worker.mjs` 进程（pid 文件 `.worker.pid`）。
- `inbox.mjs` 新增导出：`COMMANDS` / `parseOptions`（供 worker 复用）、`resetAccountCache()`（清账号配置缓存）。
- 收益：消除每次请求的 node 冷启动 + 模块加载（约 400–600ms/请求），列表/摘要补抓等并发场景提速明显；ClawEmail 的 5s 列表缓存与 client 连接池在常驻进程内真正生效。

## [0.1.2] — 2026-08-02

### 移除（半成品清理）
- **删除 `backend/identity.mjs`（访客意识引擎）**：自动回复 / 验证码提取 / 隐私脱敏规则全链路无消费者（ws-monitor 定义了 `getAwareness` 但从未调用，inbox 的 `needsConfirmation` 恒为 false），属半成品。连同 ws-monitor 的 `getAwareness`、缓存对象中的 `identity` / `isExternal` / `replyDecision` 字段一并移除。
- **删除 `_pending_send` 待发送队列**（inbox.mjs 的 `queuePendingSend` / `needsConfirmation`）：该队列无消费者、`needsConfirmation` 恒返回 false（邮件实际直接发出），属死代码。send / reply / forward 现直接执行，不再有"排队却发不出"的假成功路径。
- **删除 `email-monitor` 本地存档回退**（routes/ui.js 与 tools/sync.js 的 `readEmailMonitorData`）：开发期残留（硬编码 `W:\Games\Hanako\Work\projects\email-monitor\data`），与插件产品逻辑无关，开源分发不应携带。

### 功能新增
- **账号编辑**：`POST /accounts` 支持 `action: update`（按 id 更新名称/邮箱/provider；apiKey 仅非空时更新；config 按字段合并，`imapPass` / `smtpPass` 传空字符串可清除）。前端账号卡片新增「改」按钮：回填表单进入编辑模式，密码字段不回显、留空即保留原值；「删」按钮增加二次确认。

## [0.1.1] — 2026-08-02

### 安全修复（Security）
- **修复命令注入（高危）**：`backend/agentqq-backend.mjs` 此前用 `spawn(cmd, { shell: true })` 拼接命令行，`\"` 转义在 cmd.exe 下无效，正文/收件人/主题含 `&` `|` 等元字符可触发任意命令执行。现改为解析 `agently-cli.cmd` 的真实 JS 入口（`@tencent-qqmail/agently-cli/scripts/run.js`），用 `spawn(node, [entry, ...args], { shell: false })` 传参，用户输入不再经过 shell。
- **修复 mail-cli 同源风险**：`backend/clawemail-backend.mjs` 的 `runMailCli` 移除 `shell: true`，改为数组参数直连 node。
- **修复图片代理 SSRF 绕过**：`assets/_proxy-fetch.cjs` 现在对**每次 302 重定向后的 URL 重新校验**（协议 + host），并增加 DNS 解析后 IP 校验（防 rebinding）、IPv4-mapped IPv6 拦截、响应体积上限（8MB）。
- **修复 IMAP TLS 证书校验被关闭**：`backend/imap-backend.mjs` 移除 `tlsOptions.rejectUnauthorized: false`，邮箱链路易受中间人攻击的问题消除。
- **凭据加密升级**：新增 `backend/cred-crypto.mjs` 统一加解密；密钥从「用户名 + 硬编码盐」升级为「用户名 + per-install 随机盐」（`.cred-salt`），并自动兼容解密旧格式。routes / tools / ws-monitor 三处读写统一走同一套实现，消除明文写、密文读的不对称。
- **LLM Key 不再进前端**：`routes/ui.js` 的 `buildLlmOpts` / `postLlmTest` 不再信任前端传入的明文 apiKey，一律服务端回源（宿主 `provider:credentials` > agent `config.yaml` > 环境变量）；前端移除 Base URL / API Key 手填表单，页面加载自动检测配置。

### Bug 修复（Fixes）
- **IMAP 移动邮件回退分支**：`moveMessage` 的 COPY+DELETE 回退此前误用 `delFlags \Seen` 导致原件不删、邮件重复；改为 `addFlags \Deleted` + `expunge`，并对删除/移动/标记已读统一使用可写 box 打开。
- **`postLlmTest` 参数名**：`maxTokens` → `max_tokens`（此前测试请求实际发 1500 token）。
- **`tools/send.js` 长正文**：发送参数改走 `--json=<file>` 通道，避免 Windows 32KB 命令行限制与特殊字符错位。

### 改进（Improvements）
- `tools/accounts.js` 读写 accounts.json 复用统一加密（此前明文写会破坏加密格式）。
- `backend/ws-monitor.mjs` 读取账号后解密 apiKey（此前直接拿密文，实时收件可能失效）。

## [Unreleased] — 2026-07-29

### 修复 (Bug Fixes)
- **AgentQQ 附件**：`inbox.mjs` 的 `getAttachmentData` 对 AgentQQ 后端不再 `throw`，改为调用 `agentqq-backend.downloadAttachment` 下载并读取文件返回 base64，与 ClawEmail / IMAP 行为对齐。
- **转发打通**：
  - `inbox.mjs` 的 `forward` 对 ClawEmail 后端不再抛错，改为读取原文后用 `sendMail` 转发（带原文引用与附件）。
  - 新增 `routes/ui.js` 的 `POST /forward` 路由（原前端转发实际走了 `/send` 被当作新邮件发送，已修正）。
  - `imap-backend.forwardMail` 支持 `cc` / `bcc` / `attachments`。
- **写信增强**：写信表单新增 CC / BCC 字段与附件上传入口；`imap-backend.sendMail` / `replyToMail` / `forwardMail` 均支持 `cc` / `bcc` / `attachments`，AgentQQ 通过 `uploadAttachment` 转 `fileIds`。
- **totalCount bug**：`common.mjs` 的 `normalizeFolder` 原误用 `unread` 作为 `totalCount`，改为取 `total` / `totalCount`。
- **AgentQQ 取消已读**：保持明确报错（CLI 不支持），由路由透传为前端提示，避免静默失败。

### 改进 (Improvements)
- **图标规范化（P0）**：全量移除 emoji 功能图标（附件 📎、通知 📩、文件类型图标、导航/按钮装饰 ✦✚✓✕ 等），统一替换为 `svgIcon()` 内联描边 SVG。覆盖 `assets/plugin-page-template.html` 与 `helper/mail-toast.cjs`。全仓 emoji 扫描通过。
- **搜索栏常驻**：`searchBar` 不再在列表中隐藏，所有页面（除写信页）常驻显示，用户随时可搜。
- **批量操作按文件夹类型自适应**：新增 `folderRole()` 分类（inbox / sent / drafts / trash / spam）。批量工具栏的「标已读」仅在收件箱类文件夹显示；已发送 / 草稿 / 垃圾箱 / 垃圾邮件下自动隐藏（这些文件夹的已读状态无意义）。
- **AI 总结 / 翻译（走 Hanako 本体 LLM）**：
  - 新增 `backend/llm.mjs`：OpenAI 兼容 `/chat/completions` 客户端，端点由 `HANAKO_LLM_BASE_URL` / `HANAKO_LLM_API_KEY` / `HANAKO_LLM_MODEL` 环境变量配置（不写死厂商）。
  - 新增 `POST /summarize` 与 `POST /translate` 路由：`runInbox read` 取正文 → 调 LLM → 返回纯文本；未配置 LLM 时返回明确错误而非静默失败。
  - 详情页新增「总结」「翻译」按钮（内联 SVG 图标）+ `ai-panel` 结果面板（含加载/错误态）。
- **结构化发送参数**：`inbox.mjs` 的 `parseOptions` 支持 `--json=<file>`，`routes/ui.js` 的 `postSend` / `postForward` 将 cc/bcc/附件写入临时 JSON 透传，避免 CLI 参数无法表达数组/二进制。
- **依赖自动安装体验**：`checkBackendDeps` 在检测到后台安装进行中时返回 HTTP 202 `{ installing: true }` 而非 400 报错；新增 `GET /deps-status` 端点；UI 在同步/发送时收到 202 会自动轮询等待安装完成后重试，用户不再需要手动 `npm install`。
- **优雅卸载 / 进程清理**：
  - `index.js` 的 `onunload()` 现在主动终止 `ws-monitor.mjs` 后台进程（含 Windows `taskkill /T /F` 兜底），并写入 `backend/data/.ws-monitor.pid` 以便精准清理；卸载后不再自动重启。
  - `ws-monitor.mjs` 新增 SIGTERM / SIGINT / SIGBREAK 信号处理，收到信号后干净退出（Linux/Mac）。
  - 新增 `cleanup.cjs` 兜底脚本：按 pid 文件或扫描命令行终止残留进程，`--delete` 可额外清理 backend 目录，解决「删除插件时因后台进程占用无法程序化删除」的问题。

### 文档 (Docs)
- README 新增：后端能力矩阵、安全模型、环境变量参考、故障排查、图标规范。
- 新增 CHANGELOG.md。
