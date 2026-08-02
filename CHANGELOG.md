# Changelog

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
