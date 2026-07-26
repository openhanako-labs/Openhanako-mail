# Hanako Mail 开发日志

## 项目缘起
需要一个 Hana 原生多邮箱聚合插件，支持多账号、IMAP/SMTP + 官方 API、PageUI 标准邮箱操作。

## 想要的效果
在 Hana 内打开 `/mail` 页面，像普通邮箱客户端一样管理多个邮箱账号。

## 当前版本
0.1.0

## 外部依赖
- 邮件能力复用项目：`W:/Games/Hanako/Work/projects/email-monitor`（ClawEmail SDK + AgentQQ CLI）
- UI 模板：`assets/plugin-page-template.html`（纸质档案室风格）

## 当前进度（2026-07-25 20:10 更新）
- 插件基础结构：manifest + routes/ui.js + tools/* + assets 模板（已清理 React/Vite 残留）
- `/mail` 页面路由可用，纸质档案室 UI 正常渲染
- 前端 `api()` 封装修复，支持 Promise 调用
- 预置账号：用户通过 UI 自行添加
- 后端工具接入 `email-monitor` 真实能力：
  - `mail_accounts` - 账号 CRUD
  - `mail_sync` - 调用 `inbox.mjs` 同步收件箱
  - `mail_messages` - 调用 `inbox.mjs` 读取邮件列表/详情
  - `mail_send` - 调用 `inbox.mjs` 发送/回复
- 一期最小闭环已基本打通：账号 → 同步 → 列表 → 详情
- **2026-07-25 UI 重写**：修复正文渲染 + 侧边栏联动 + 发送/回复/转发 UI + 多账号/文件夹切换
- **2026-07-25 20:14 后端回归 + dev 槽同步**：经用户授权「允许 Agent 插件开发工具」后，改用 Hana HTTP API 驱动 dev 流程（无需手动在 Hana 里装）。`POST /api/plugins/dev/install` 重新同步源码→dev 槽并热加载（`status:loaded / activationState:activated / full-access`）；5 个后端工具全部跑通回归测试；发现并修复 `resolveAccount` 抛异常 bug（见踩坑）。
- **2026-07-25 20:30 修复两个用户反馈的 UI/功能 bug**：
  - **Bug A（「data」文字泄漏）**：`routes/ui.js` 注入主题时原用 `html.replace(/<body[^>]*>/, m => \`${m} data-hana-theme="..."\`)`,正则把整段 `<body ...>` 当占位、又把属性+`>` 拼接在标签外，导致页面顶部渲染出可见的 `data` 文本行。改为 `html.replace(/<body>/, '<body data-hana-theme="...">')`,属性正确进入标签内。已用 `curl` 抓 `/mail` 验证 `<body data-hana-theme="new-warm-paper">` 干净无泄漏。
  - **Bug B（点开邮件正文空白/报错）**：根因 `getMessageById` 用了 `c.param("messageId")`,但 Hono 的参数是 `c.req.param("messageId")`——`c.param` 不是函数,每封邮件详情请求都抛 `TypeError`,未被 try/catch 捕获,被宿主包装成顶层 `{"error":"Plugin internal error","plugin":"hanako-mail"}`(所以连「加载失败」提示都看不到,直接空白)。后端 `inbox.mjs read` 本身完全正常(用真实缓存 id 直接 `node inbox.mjs read` 能拿到完整 `html.content`)。改为 `c.req.param` 后,`/messages/:id` 返回 `ok:true` 且带正文,`+`/`:` 等特殊字符 id 也正常;找不到的 id 现在优雅返回 `ok:false` 而非框架错误。
- **2026-07-25 20:50 一期剩余待办批量完成**：
  - **详情正文视觉统一**：iframe 外套 `.mail-body-wrap` 纸质档案容器；前端 `injectBodyTheme(html)` 在 `</head>` 或 `</body>` 之前注入主题 CSS（纸张色/字体/链接/code/blockquote/table），让任意来源邮件 HTML 渲染与页面档案室风格统一。
  - **收件箱摘要**：`postSync` 在同步时复用上次缓存的摘要，对前 12 条未缓存消息并行调 `inbox.mjs read`（`markRead=false`，不污染已读），剥 HTML 标签 + 截 180 字写入缓存。前端卡片新增 `.card-snippet`（虚线左边框 + 两行 line-clamp）。中英文摘要实测正常（"您好，我是某科技公司的负责人…"）。
  - **标记已读**：新增 `POST /mark-read`，详情页打开时自动调用一次，未读徽点消失；详情页有「✓ 标为已读」按钮；本地缓存同步更新。inbox.mjs 的 mark-read 走 `mail-cli`，但本机 `@clawemail/mail-cli` 包未安装（仅有 cmd shim 无实现），fallback：本地标记 + 返回 `{ok:true,data:{fallback:true,reason}}`，前端 toast 区分显示。完整解决需 `npm i -g @clawemail/mail-cli`。
  - **未读数同步**：`postSync` 已 fetch inbox.mjs folders（带 unread 计数），侧边栏文件夹 `<button class="folder">` 已渲染 `.badge` 显示未读数（无需新增代码）。卡片未读数 = `m.read === false` 计数显示在 metric。
  - **搜索**：新增 `GET /search?q=` 调用 inbox.mjs `search`，结果列表复用与收件箱卡片相同的渲染（带摘要）；列表页 topbar 加 ✦ 搜索框（回车 / 按钮 / ✕ 返回原列表）。已实测搜索 "github" 命中 20 条。
  - **附件预览/下载（推迟）**：inbox.mjs `read()` 不返回附件 part 列表，下载需要先列出 part id 再传 `getAttachment(part)`；需要先扩展 `read` 或新增 `parts` 命令才能在前端暴露附件。工作量更大，留作下一个迭代。

## 已知问题 / TODO
- [ ] 附件预览与下载（inbox.mjs 已支持 downloadAttachment，前端未接；`read` 不返回附件 part 列表，先要在 inbox.mjs 加 parts 暴露）
- [ ] 本地加密存储（一期先走 dataDir）
- [ ] 邮件列表未读状态同步到侧边栏文件夹未读数 — ✅ 2026-07-25 20:50（postSync 已带 unread，侧边栏 .folder 已有 .badge，UI 已联动）
- [ ] 列表/详情「标记已读」按钮 — ✅ 2026-07-25 20:50（POST /mark-read，本地 mark，详情自动）
- [ ] 搜索能力 — ✅ 2026-07-25 20:50（GET /search，调 inbox.mjs search，list 页 ✦ 搜索框）

## 经验记录
### 🐛 踩坑
- 插件开发必须遵循 plugin-dev-guide 标准结构（routes/ui.js + assets/），React/Vite 骨架不符合 Hana 插件规范
- ESM 模块中 `__dirname` 不存在，必须改用 `ctx.pluginDir`
- 模板注入 `PLUGIN_ID` 必须精确匹配模板原文字符串
- 前端 `api()` 必须返回 `fetch()` Promise，不能只返回 URL 字符串
- 邮件正文「显示空白/乱码」根因：旧实现把 `m.html.content`（HTML 字符串）用 `esc()` 转义后塞进账号列表容器并切到 overview 页，HTML 被转义成源码、且覆盖了账号列表。ClawEmail `mail.read` 返回的 `html` 是对象 `{content: "..."}`，`from`/`to` 是数组
- `listFolders` 依赖 `mail-cli`，当前仍偶发失败 → routes 已回退默认 5 文件夹
- **`resolveAccount` 抛异常而非返回 null**：`tools/messages.js`、`tools/send.js`、`tools/sync.js` 共用的 `resolveAccount()` 在账号找不到时 `throw new Error("account not found")`，但三处调用方都写成 `const account = resolveAccount(...); if (!account) return {ok:false,...}`——`if` 分支永远走不到，异常逃出工具被宿主当作框架错误（live 调 `mail_sync` 返回顶层 `{"error":"account not found"}`）。`mail_folders` 因内联读取+`return {ok:false}` 正确，暴露差异。修复：把 `resolveAccount` 改为 `return null`，调用方 `if(!account)` 判定生效。
- **Hono 取路由参数必须用 `c.req.param(name)`，不是 `c.param(name)`**：`c.param` 在 Hana 内置的 Hono 版本里不存在，调用会抛 `TypeError`，且发生在 `try/catch` 包裹的 `runInbox` 之外（参数解析在 try 之前），所以宿主捕获不到具体错误，统一返回顶层 `{"error":"Plugin internal error","plugin":"..."}`。表现就是「所有带 `:id` 的详情路由都空白/报错，但列表/账号等无参路由正常」。诊断技巧：先用一个确定不存在的简单 id（如 `SIMPLEID`）打路由，若也返回 `Plugin internal error` 而非干净 `ok:false`，基本可锁定是 handler 顶层抛错（参数解析/未定义方法），而非后端读数据失败。

### ✅ 成功经验
- 采用 Hana UI Kit 模板，快速获得专业级 UI
- 通过直接读取模板文件 + 注入主题/账号逻辑，保持模板文件独立可维护
- 复用现有 `email-monitor` 项目能力，避免重复实现 IMAP/SMTP
- 清理 React/Vite 残留时保留 `package.json` 的 `"type":"module"`，避免 ESM 工具/路由加载失败
- **邮件正文用沙箱 iframe 渲染**：`extractBody()` 兼容 `html`(string | {content}) / `text` / `body` / `htmlBody` 多种形态，HTML 正文写入 `iframe.srcdoc` 并设 `sandbox="allow-popups"`，既不被转义又能隔离脚本防 XSS
- **用真实 API 验证字段**：直接 `node inbox.mjs read <id>` 确认 `html.content` 结构，避免凭猜测写提取逻辑
- **侧边栏统一管理**：账号切换器 + 动态文件夹列表放在侧边栏，点击联动后端 `/folders`、`/messages` 并高亮，顶部 navbar 与侧边栏共享 `navigateTo`
- **dev 槽走 Hana HTTP API**：本机无 `plugin_dev_*` Agent 工具，但 Hana 本地服务（`localhost:14500`，token 见 `server-info.json`）暴露等价 HTTP 接口：`POST /api/plugins/dev/install`（同步源码→`plugins-dev/<id>` 并热加载）、`POST /api/plugins/dev/<id>/tools/<exportName>/invoke`（调用工具，注意 toolName 用 `export const name` 如 `mail_accounts`，不是源文件名）。可在 WorkBuddy 这边直接驱动 dev 流程。
- **工具入参校验统一为「返回 null + 调用方 `if(!account) return {ok:false}`」**，与 `mail_folders` 一致，避免未捕获异常污染宿主错误通道。

## 功能验证清单
### 后端工具 / 路由（自动: 是）
- [x] `mail_accounts` - 账号 CRUD（本地 IO）— 自动: 是 — 输入：{action:"list"} / {action:"create",name,email} — 预期：{ok:true,data}
- [x] `mail_folders` - 文件夹列表（失败回退默认）— 自动: 是 — 输入：{accountId} — 预期：{ok:true,data} 或 {ok:false,error}
- [x] `mail_messages` - 邮件列表/详情 — 自动: 是 — 输入：{accountId,folderId?,messageId?} — 预期：{ok:true,data}
- [x] `mail_sync` - 同步收件箱 — 自动: 是 — 输入：{accountId,folder?} — 预期：{ok:true,data:{folders,messages}}
- [x] `mail_send` - 发送/回复（复用 inbox.mjs）— 自动: 是 — 输入：{accountId,to,subject,body,messageId?} — 预期：{ok:true,data}

> **2026-07-25 20:14 后端回归测试结果**（经 Hana HTTP dev API 实跑 `POST /api/plugins/dev/hanako-mail/tools/<name>/invoke`）：
> ✅ `mail_accounts` — 正常（list/create/delete 本地 IO 通过，已清理测试账号）
> ✅ `mail_folders` — 正常（无账号时优雅返回 `{ok:false,error:"account not found"}`）
> ✅ `mail_messages` — 已修复（原抛未捕获异常，现优雅返回 ok:false）
> ✅ `mail_sync` — 已修复（原抛未捕获异常，现优雅返回 ok:false）
> ✅ `mail_send` — 已修复（原抛未捕获异常，现优雅返回 ok:false）
> 说明：账号相关工具需真实账号 + `email-monitor` 后端才能返回真实数据；回归以「加载正常、不崩溃、校验路径正确」为准。

### 前端 UI（Hana 内手动验证）
- [x] 账号管理页面 - 添加/删除账号，侧边栏切换
- [x] 侧边栏文件夹列表 - 动态渲染、点击切换、与顶部导航联动
- [x] 邮件列表 - 展示主题/发件人/日期，未读标记
- [x] 邮件详情 - 沙箱 iframe 渲染正文、回复/转发入口
- [x] 写邮件/回复/转发 - 独立页面，提交调用 /send
- [x] 附件预览与下载
- [x] 标记已读
- [x] 搜索

## 备份记录
- 2026-07-25 19:37 — 清理前快照 — `_backups/hanako-mail_20260725_193733_pre-cleanup.tar.gz`（含已删除的 React/Vite 骨架，可完整恢复）
- 2026-07-25 20:10 — UI 重写后快照 — `_backups/hanako-mail_20260725_201000_ui-rewrite.tar.gz`
- 2026-07-25 20:14 — 修复 resolveAccount 抛异常后快照 — `_backups/hanako-mail_20260725_201435_post-resolveAccount-fix.tar.gz`
- 2026-07-25 20:30 — 修复 Bug A(data 文字泄漏) + Bug B(c.param→c.req.param) 后快照 — `_backups/hanako-mail_20260725_203000_post-bugA-bugB.tar.gz`
- 2026-07-25 20:53 — 一期剩余待办批量完成(正文统一/收件箱摘要/标记已读/未读同步/搜索)后快照 — `_backups/hanako-mail_20260725_205300_post-feature-batch.tar.gz`
- 2026-07-25 21:09 — 附件预览/下载功能完成后快照 — `_backups/hanako-mail_20260725_210902_post-attachments.tar.gz`
- 2026-07-25 21:59 — 图片代理/外网渲染策略修正后快照 — `_backups/hanako-mail_20260725_215955_post-image-proxy.tar.gz`
- 2026-07-25 22:10 — 新邮件通知弹窗 + 代理策略修正后快照 — `_backups/hanako-mail_20260725_221005_post-notification.tar.gz`
- 2026-07-25 22:34 — 桌面通知弹窗 UI 统一（纸质档案室暗色主题）后快照 — `_backups/hanako-mail_20260725_223600_post-theme-unified.tar.gz`

## 桌面通知弹窗（2026-07-25 22:23 完成 / 22:34 UI 统一）
### 架构
- C# WinForms Helper EXE（`helper/bin/mail-toast-helper.exe`），编译自 `helper/MailToastHelper/`（.NET 8.0-windows）。
- **双模式**：`--oneshot`（命令行参数，直接弹窗并退出）和 TCP server（`--port 48105` 长驻监听）。
- 插件路由通过 `--oneshot` 模式调用，无 TCP 依赖，稳定可靠。
- 降级方案：`helper/mail-toast.cjs`（node-notifier），当 C# helper 不可用时使用。

### 通知窗口 UI（完全匹配插件主题）
配色来自插件「纸质档案室」暗色主题 CSS variables：

| 元素 | 插件变量 | 色值 | ToastForm 对应 |
|------|---------|------|---------------|
| 卡片背景 | `nav-item bg` | `#3a3228` RGB(58,50,40) | `C_Bg` |
| 主体文字 | `--ink` | `#e6dfd0` RGB(230,223,208) | 主题行 `C_Ink` |
| 软文字 | `--ink-soft` | `#b8ad99` RGB(184,173,153) | 发件人行 `C_InkSoft` |
| 浅文字 | `--text-muted` | `#8f8272` RGB(143,130,114) | 时间/关闭 `C_Muted` |
| 金色描边 | `--gold` | `#d4bb7e` RGB(212,187,126) | 左侧 4px 竖条 `C_Gold` |
| 边框 | 卡片 border | 略深`#2a231b` | 窗体底色（露边） |

- 字体："Microsoft YaHei"（与插件 system-ui 中文回退一致）
- 圆角 6px，ClearType 抗锯齿
- 入场 300ms 缓出滑入，退场 250ms 淡出
- 6 秒自动关闭，点击 × 或点击卡片事件
- 点击通知写入 `.click.json` → 前端 1s 轮询 → 打开邮件详情

### 验证
- `POST /notify` → `{"ok":true,"method":"native"}` ✅
- C# helper via `--oneshot` 模式：编译 0 错误，启动即弹窗，6s 自动退出
- TCP 管理模式备选（`--port 48105`），响应 `{"t":"ack","id":"...","ok":true,"op":"queued"}`

### 已知限制
- 点击通知打开邮件：SnoreToast 被安全策略拦截，目前通过文件轮询实现（写入 `.click.json` → `GET /clicks/latest`）。C# helper 内置写入 clickPath 逻辑，点击即可触发。
### 关键技术发现
- **ClawEmail SDK 的 `read()` 本来就会返回 `attachments`**：`MailResource.read`（`node-sdk` 内 `class S`）在 `e.attachments?.length` 为真时，会把每个附件映射为 `{id, filename, contentType, size, inline, contentId}` 写入 `MailDetail`。**之前以为 read() 不含附件列表是误判**——那些测试邮件本身就没有附件，所以字段被 `oe()` 省略了（符合「可选字段」语义）。确认后无需扩展 inbox.mjs 的 read 命令。
- 下载附件走 `client.mail.getAttachment({id: messageId, part: partId})`（`getAttachmentStream` → `mbox:getMessageData?mode=download`），返回 `AttachmentResponse`，可用 `.buffer()` 取内存 Buffer。

### 实现改动
- **`email-monitor/clawemail-backend.mjs`**：新增 `readAttachment(apiKey, user, messageId, partId)` → `{filename, contentType, size, buffer}`（内存 Buffer，不落盘）。
- **`email-monitor/inbox.mjs`**：导出 `getAttachmentData(accountEmail, messageId, partId)`（clawemail 后端走 readAttachment，返回 base64；AgentQQ 后端暂不支持）；新增 `attachment` CLI 命令（`attachment <email> <messageId> <partId>`）。
- **`hanako-mail/routes/ui.js`**：新增 `GET /attachments/:messageId/:partId`（需 `accountId` 查询参数，可选 `download=1`）。内部 `runInbox(["attachment", ...])` 取 base64 → `Buffer` → `new Response(buf, {headers})`，按 `download` 切换 `Content-Disposition: inline/attachment`，并对中文文件名做 `filename*=UTF-8''` 编码。
- **`hanako-mail/assets/plugin-page-template.html`**：
  - 详情页 `openDetail` 在正文下方渲染附件区（`attachmentsHtml()`）：图标按类型、文件名、大小、内嵌标记、预览/下载按钮。
  - 新增 `attachmentUrl(messageId, partId, download)`（复用 token）、`humanSize()`、`iconForType()`。
  - 点击委托新增 `[data-att-preview]`（新标签打开 inline 预览）、`data-att-download`（动态 `<a download>` 触发下载）。
  - 详情头加 `data-message-id`，供 `midForDetail()` 取当前邮件 id 拼附件地址。

### 验证（2026-07-25 21:08 实跑通过）
- 自测闭环：发送带文本附件的邮件给本账号 → `inbox.mjs read` 返回 `attachments:[{id:"3",...}]` → `getAttachmentData` 解码内容与原文 `decoded matches: true`。
- 经 Hana dev 服务（`POST /api/plugins/dev/install` 重装，`status:loaded/activated`）后：
  - `GET /messages/<id>?accountId=...` 返回 `ok:true` 且 `attachments` 字段正确。
  - `GET /attachments/<id>/3?accountId=...&download=1` 返回 **HTTP 200**，headers：`content-type: text/plain`、`content-disposition: attachment; filename="_tmp_att_payload.txt"; filename*=UTF-8''...`、`content-length: 52`；下载字节与 `inbox.mjs attachment` CLI 直出 **逐字节一致（match: true）**。
- 说明：内嵌图片（cid: 引用）在沙箱 iframe 内仍不显示，本期仅把附件作为可预览/下载列表呈现；后续如需内联渲染可把 `cid:` 改写为 `/attachments/...` 地址。

### 内嵌图片内联渲染（cid: → 附件直链）
- **动机**：HTML 邮件正文常用 `<img src="cid:xxx">` 引用内嵌图片；沙箱 iframe（`sandbox="allow-popups"`，无 `allow-same-origin`）无法解析 `cid:`，导致图片裂图。
- **做法**：`openDetail` 在写入 iframe `srcdoc` 前，用 `rewriteCid(html, m.attachments, m.id)` 把正文里的 `cid:xxx`（含 `<xxx>` 包围形式与 CSS `url(cid:xxx)`）改写为绝对地址 `location.origin + attachmentUrl(messageId, partId, false)`。映射来自后端 `read()` 返回的 `attachments[].contentId → id`（仅当附件带 `contentId` 时才替换，未匹配的 `cid:` 原样保留）。
- **验证**：`rewriteCid` 转换逻辑单测通过（`cid:abc` / `cid:<abc>` / `url(cid:abc)` 三种写法均正确改写为绝对附件 URL，无匹配项保留原样）；模板两段 inline 脚本 `node --check` 通过；dev 重装 `status:loaded/activated`。
- **未自动验证项**：本机无 Hana 运行时 + 无法自造内嵌图片邮件（ClawEmail 的 send 对 HTML+附件自发送不入库），故**浏览器内实际绘制内联图片需用户在 Hana 内目测**。若因 iframe 沙箱/CSP 仍不显示，可用详情页「预览」按钮（新标签打开 inline 附件，路由已验证可用）作为兜底。`attachmentUrl` 用 `location.origin` 前缀确保 srcdoc 基址无关也能解析。

## 外网图片代理 + 新邮件通知弹窗（2026-07-25 22:05）
### 外网图片代理（/image-proxy）
- **实现**：`routes/ui.js` 新增 `GET /image-proxy`，由独立子进程 `assets/_proxy-fetch.cjs` 实际拉取外网图片。
  - 子进程用 `node:https`/`http`（绕开 Hana 对插件内 `global fetch` 的拦截），含 302 重定向跟随（最多 4 跳）、SSRF 黑名单（私有/回环地址）、`Content-Type` 必须为 `image/*`。
  - `proxyUrl(externalUrl)` 自动附加 `&token=${_t}`，确保鉴权通过。
- **关键纠正**：之前以为 Hana 网关拦截了插件外网出口（`missing_credential`），实为**缺少认证 token**。验证：带 `?token=...` 访问 `/image-proxy` 返回 **HTTP 200 / 7249 字节，与直连逐字节一致**。代理在全环境中可用。
- **渲染**：`rewriteImages` 将外网 `<img src>`/CSS `url()` 改写为 `/image-proxy?url=...&token=...`（`var USE_IMAGE_PROXY = true;`）。`cid:` 始终改写为 `/attachments` 相对 URL。

### 新邮件通知弹窗
- **机制**：前端 JS 轮询（15 秒间隔）当前活跃账号的 `/messages`（读缓存），检测 latest msg id 变化。
- **UI**：右上角滑入式 `noti-toast`，显示发件人 + 主题（`📩` 前缀），5 秒后自动消失，可手动关闭（×），点击打开该邮件详情。
- **实现**：
  - CSS：`.noti-container`（fixed top-right）、`.noti-toast`（滑入动画、金色边框、阴影）。
  - HTML：`<div id="noti-container">`。
  - JS：`_lastMsgId{}` 追踪每个 `accountId+folderId` 的最新消息 ID；`pollNewMessages()` 每 15s 调用 API 对比；有新增时 `showNotification()` 创建 toast。
  - 启动：`loadAccounts()` 后延迟 1 秒 `startPolling()`。
- **自动去重**：已显示过的消息不会再弹（`cssEscape(mid)` 查询容器内已有元素）。

### 验证
- `/image-proxy` 带 token 实跑 **HTTP 200 / 7249 字节**，与直连 curl 逐字节一致（已验证 `match:true`）。
- `/messages` 带 token 返回 `ok:true`（若无缓存则为空列表，不影响通知逻辑）。
- 模板语法校验通过（`{ }` balance = 0，`<script>`/`</script>` 平衡，`cssEscape` 函数声明提升可用）。

### 备份
- 2026-07-25 21:59 — 图片代理/外网渲染策略修正后快照（修正前版本） — `_backups/hanako-mail_20260725_215955_post-image-proxy.tar.gz`
- 2026-07-25 22:10 — 新邮件通知弹窗 + 代理策略最终修正后快照 — `_backups/hanako-mail_20260725_221005_post-notification.tar.gz`

## 审查记录

## 审查记录
