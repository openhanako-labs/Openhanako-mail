# Hanako Mail — HanaAgent 邮件插件

![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)

HanaAgent 原生多邮箱聚合插件。支持 ClawEmail、AgentQQ 官方 API，以及个人邮箱 IMAP/SMTP。

## v2 App（当前主线）

本仓库根目录**就是一个 v2 App 包**（`manifestVersion: 2`），安装后落在 `<HANA_HOME>/apps/hanako-mail/`。
v1（`<HANA_HOME>/plugins/`，`manifestVersion` 缺失或为 1）已被官方永久冻结，不再作为发布分支。

### 两个进程，各管一段

```
AppHost（宿主进程，Node 权限模型内）      受管 native 服务（runtime/service.mjs，独立进程）
  · 5 个邮件工具                              · ClawEmail WebSocket + IMAP IDLE 实时监听
  · 卡片后端路由（http/ui.js）                · inbox 命令表（list/read/send/reply/转发/附件…）
  · 转发请求 ────────────────────────▶      · 出站 HTTP（LLM 端点）、图片代理、v1 数据迁移
  · 通知派发（5 秒一轮）  ◀────────────      · 收件监听排队的桌面通知
```

**为什么拆成两个进程**：AppHost 及其**一切子进程**都在 Node 权限模型内 ——
没有出站网络，也读不到安装目录与 app-data 之外的任何文件。而邮件后端离开网络就不存在。
两个实测结论（都反直觉，也都踩过）：

1. **子进程继承权限模型，且传播不走环境变量**。父进程用 argv 传 `--permission` 时，
   `NODE_OPTIONS` 是空的，子进程照样被拒；剥掉环境变量无效。
2. **AppHost 的 env 是宿主白名单**（只有 `PATH` / `HOME` / `TMPDIR` / `LANG`），
   所以 `USERPROFILE` / `HANA_HOME` 在那里不保证存在——路径能靠 `ctx.dataDir` 就别靠环境变量。

平台为此准备了受管运行时，只有 `profile: "native"` 允许“读当前用户可读的文件 + 外网”。
代价是权限放大（Windows 上 enforcement 为 `partial`，不提供完整文件隔离），
安装审批时会单独列出 `app/runtime.native` / `app/runtime.network`。

### 目录名约定

v2 要求 `manifest.id` 与安装目录名一字不差。仓库名是 `Openhanako-mail`，
而 App id 是 `hanako-mail`，所以官方静态校验器直接对本仓库根目录跑会报
`id "hanako-mail" does not match its directory name`。这是命名约定差异，不是包本身的问题：

```bash
node scripts/validate-app.mjs --dir <某个路径>/hanako-mail
```

`validate-app` **只保证 manifest 与静态资源自洽**，下面这些它一条都不查
（两轮 0 error 却两次被真实装载拒收，都出在这里）：路由来源互斥、能力清单、
目录名等于 id、安装位置独占、AppHost 的只读根。能覆盖装载的 `--smoke` 需要 Node 26+。

### 自检

```bash
node scripts/smoke-load.mjs   # 不需要宿主：ctx 投影 / 路由 / 转发层降级 / manifest 一致性
```

**单跑服务**（排查后端问题时最有用 —— 不靠宿主就能验证网络与账号）：

```bash
node runtime/service.mjs <app-data目录> <v1数据目录> 43179
# stdout 出现 HANA_MAIL_SERVICE_READY 即就绪；然后：
#   GET  /health
#   POST /cli     { cmd, args, env }
#   POST /http    { url, method, headers, body }
#   POST /proxy   { url }
#   POST /notify  { subject, sender, messageId, accountId }
#   POST /migrate { from, to }
```

换图时才跑：`node scripts/make-icon.cjs`（无外部依赖，手写 PNG）。

## 架构

| | v1 | v2 |
|---|---|---|
| 安装位置 | `plugins/<id>/`，跑在宿主进程内 | `apps/<id>/`，**独立 AppHost 子进程**（安装目录只读） |
| 入口 | `export default class { onload() }` | `export async function apply(ctx)` |
| 工具 | `contributes.tools[]` 声明 | `ctx.tools.register()` 编程式注册 |
| 路由 | `routes/` 目录（宿主自动发现） | `ctx.routes.register()`；**与 `routes/` 目录互斥** |
| 工具签名 | `execute(input, ctx)` 双参 | `execute({ ...args, context })` **单参** |
| 日志 | `ctx.log` | `ctx.logger` |
| 静态资源 | `assets/` | `ui/`（URL `/api/apps/<id>/ui<route>`） |
| 数据目录 | `plugin-data/<id>/<id>/` | `app-data/<id>/` |
| 权限 | `trust: "full-access"` | 顶层 `capabilities: ["app/..."]` 账本词 |
| 启用方式 | 放进目录即加载 | 必须走安装批准，否则停 `unregistered` |

### 这次迁移里的三处关键处理

1. **数据目录搬迁** — `app-data/hanako-mail` 与 v1 的
   `plugin-data/hanako-mail/hanako-mail` 不是同一个位置。凭据盐 `.cred-salt` 就存在数据目录下，
   目录一换，派生密钥就变，`accounts.json` 里加密的 `apiKey` / `imapPass` 全部解不开；
   而读取失败是 `catch { return [] }`，表现成「账号凭空消失」而不是「解密失败」。
   所以 `apply()` 起来后第一件事就是搬 `accounts.json` + `.cred-salt` + `cache/`。
   **迁移必须由服务做** —— AppHost 读不到 `plugin-data`（不在它的只读白名单里）。
2. **ctx 投影（`lib/legacy-ctx.mjs`）** — `http/ui.js` 与 `tools/*.js` 里只有 5 类 ctx 成员，
   在一个地方做投影比散落改 15 处安全。注意其中 `dataDir` 是**故意报成父目录**的：
   老代码写的是 `path.join(ctx.dataDir, ctx.pluginId)`，这样那条表达式仍解析到真实的 App 数据目录。
3. **请求转发（`lib/runtime-host.mjs`）** — `worker-client.mjs` 的 `runCli` 签名保持原样，
   内部从「spawn 子进程 + stdio」换成「POST 给受管服务」。所以 30 多处调用点一个字未改。

### 路径取自哪里（容易错）

AppHost 的 env 是宿主白名单（`PATH` / `HOME` / `TMPDIR` / `LANG`），
**`USERPROFILE` / `HANA_HOME` 在那不保证存在**。所以：

- `runtimeDataDir()` 优先用 `HANAKO_PLUGIN_DATA`（apply 里从 `ctx.dataDir` 写入）
- `legacyDataDir()` 从数据目录**反推** HANA_HOME（取两层 dirname），而不是读环境变量

## 架构

```
Hanako Mail
├── tools/          Agent 工具（账号管理/文件夹/邮件列表/发送/同步）
├── http/           HTTP 后端（邮件 UI API）。
│                   注意：**不能叫 routes/**——v2 把顶级 routes/ 目录当成另一种路由来源，
│                   与 ctx.routes.register() 互斥，两边同时存在整应用装载即 failed
│                   （app-host-entry.js:3233 / 4201）
├── runtime/
│   └── service.mjs  受管 native 服务：收件监听、inbox 命令表、出站 HTTP、
│                    图片代理、通知入队、数据迁移、AgentQQ 设备码授权
├── backend/        后端引擎（全部跑在服务里）
│   ├── inbox.mjs           命令表（唯一入口，服务直接调用）
│   ├── worker-client.mjs   宿主侧客户端：把命令转发给服务
│   ├── net-child.mjs       宿主侧客户端：把出站 HTTP 转发给服务
│   ├── clawemail-backend   ClawEmail（@claw.163.com，SDK 进程内）
│   ├── agentqq-backend     AgentQQ（@agent.qq.com，REST 直连）
│   ├── agentqq-auth.mjs    AgentQQ OAuth 设备码 / 刷新（纯协议）
│   ├── imap-backend        IMAP/SMTP 个人邮箱后端
│   ├── imap-idle.mjs       IMAP 实时收件监听（IDLE）
│   ├── ws-monitor.mjs      ClawEmail WebSocket 实时收件监听
│   ├── cred-crypto.mjs     凭据 AES-256-GCM 加解密（统一实现）
│   ├── blocklist.mjs       黑/白名单
│   └── common.mjs          公共工具函数
├── ui/             卡片界面与封面（v1 的 assets/plugin-page-template.html 已迁至此）
│                   ├── mail.html   卡片页面
│                   └── face.png    卡片中心 / 黑板上的封面（manifest 的 contributes.cards[].face）
├── lib/            v2 装配层（env / ctx 投影 / 工具与路由注册 / 受管服务句柄 / 通知派发）
├── scripts/        自检（smoke-load / smoke-bridge）与图标生成
├── helper/         桌面通知（mail-toast.cjs，由 AppHost 拉起）
└── manifest.json   应用清单（v2）
```

> **执行模型**：http/tools 的所有后端命令（列表/读信/发送/同步/搜索/附件等）不再自己 spawn 子进程，
> 而是经 `worker-client` 转发给**受管 native 服务**（`runtime/service.mjs`）。
> 服务复用 `inbox.mjs` 的命令表，行为与 CLI 一致；每次请求注入该账号的凭据环境变量并重置账号缓存。
> 服务的启动/重启/回收都由宿主控制，不用 pid 文件。

## 安装

App 装在 `~/.hanako/apps/hanako-mail/`（v2 不再用 `plugins/`）。
在 Market → Installed → App 里批准后启用。

依赖**随包发布**（`backend/node_modules` 已入包，约 14 MB）。
服务跑在受管 native 运行时里、**不能 spawn**，所以无法自己 `npm install` —— 缺依赖时服务会明确报错。

### 更新时先停用（踩过）

**直接更新一个正在运行的应用会失败**，报：

```
安装准备失败：Package file worker stopped before completing
```

原因：应用的后端服务是从 `apps/<id>/runtime/` 跑起来的，那些文件被进程占着，
Windows 下无法替换。正确顺序：

```
停用 → 卸载 → 安装新包
```

另外：**「重新加载」不会改写安装记录** —— registry 里的版本号会停在最后一次
正规安装的版本。想让记录与实际一致，走一次卸载 + 安装。

### 权限说明（manifest）

v2 的能力声明（`manifest.json` 的 `capabilities`），安装审批时会逐项列出：

| 能力 | 用途 |
|---|---|
| `app/tools.expose-to-model` | 五个邮件工具能被模型调用 |
| `app/process.spawn` | AppHost 拉起 `mail-toast.cjs` 弹桌面通知（服务不能 spawn） |
| `app/runtime.execute` + `app/runtime.native` | 跑受管邮件后端（网络 + 本机文件访问） |
| `app/runtime.network` | 后端连 IMAP/SMTP/ClawEmail/LLM 端点 |
| `app/models.read`、`app/provider.credentials.read` | AI 总结/翻译取模型与凭据 |
| `app/ui.open-external`、`app/ui.clipboard-write` | 卡片里开外链、复制文本 |

> `app/runtime.native` 是真实的权限放大：以当前系统用户权限运行、可读该用户可读的文件
> （Windows 上 enforcement 为 `partial`，不提供完整文件隔离），外加外网。

### 桌面通知

通知由 **AppHost 发起**（它有 `--allow-child-process`），脚本是 `helper/mail-toast.cjs`
（Windows SnoreToast，失败降级 node-notifier）：

```
服务（收得到邮件，不能 spawn）→ 写 app-data/hanako-mail/_pending_notify/
AppHost（能 spawn，收不到邮件事件）→ 每 5 秒取队列 + 拉起 mail-toast.cjs
```

依赖 `backend/node_modules` 里的 `node-notifier`（已随包发布），不依赖开发机路径。

## 账号配置

支持四种邮箱类型：

| 类型 | 域名 | 认证方式 |
|------|------|----------|
| ClawEmail | `@claw.163.com` | API Key |
| AgentQQ | `@agent.qq.com` | OAuth 设备码（无需密钥） |
| 个人邮箱 | 其他域名 | IMAP/SMTP 授权码 |

在插件 UI 中添加账号时填写对应信息即可。账号创建后**可随时编辑**（名称/邮箱/凭据），密码字段留空即保留原值；删除账号有二次确认。

### AgentQQ 授权

走 OAuth 设备码，**不需要填任何密钥**，也不需要安装官方 CLI：

1. 邮件卡片 → 添加账号 → 提供商选 `AgentQQ` → 点「开始授权」
2. 卡片会显示一串授权码和一个链接；在浏览器里打开链接确认
3. 授权成功后账号自动出现（邮箱地址由授权结果决定）

令牌以与其他凭据相同的 AES-256-GCM 加密存进 `accounts.json`，
过期时自动刷新并写回；刷新失败会提示重新授权。

## 后端能力矩阵

不同后端支持的 API 能力不同。下表为权威参考，UI 已按此实现；不支持的操作会返回明确错误而非静默失败。

| 能力 | ClawEmail | AgentQQ | 个人邮箱 (IMAP/SMTP) |
|------|:---------:|:-------:|:-------------------:|
| 邮件列表 | ✅ | ✅ | ✅ |
| 搜索 | ✅ (SDK) | ✅ | ✅（IMAP SEARCH：FROM/SUBJECT 服务端检索） |
| 读取正文 | ✅ | ✅ | ✅ |
| 发送 (含 CC/BCC/附件) | ✅ | ✅ | ✅ |
| 回复 (含附件) | ✅ | ✅ | ✅ |
| 转发 (含原文引用/附件) | ✅ | ✅ | ✅ |
| 附件下载 / 预览 | ✅ | ✅ | ✅ |
| 移动邮件 | ✅ | ❌ (CLI 限制) | ✅ (MOVE/COPY+DELETE) |
| 标记已读 | ✅ | ✅ | ✅ |
| 取消已读 (标为未读) | ✅ | ❌ (CLI 限制) | ✅ |
| 批量删除 | ✅ | ❌ (CLI 限制) | ✅（单连接循环） |
| 保存草稿 | ❌ | ❌ | ✅（append 到 DRAFTS） |
| 文件夹列表 | ✅ | ✅ | ✅ |

> 说明：
> - AgentQQ 的"移动"对应官方 REST 的软删除（移入垃圾箱，保留 30 天）；没有独立的"标记已读/取消已读"接口，会返回说明而非静默吞掉。
> - 个人邮箱搜索为服务端检索（v0.1.5 起，IMAP SEARCH：发件人/主题）。
> - 草稿保存仅 IMAP 后端支持（v0.1.5 起），保存后可进入文件夹列表的「Drafts / 草稿」查看；ClawEmail / AgentQQ 会返回明确错误。

## 安全模型

- **凭据静态加密**：`apiKey` / `imapPass` / `smtpPass` 在写入 `accounts.json` 前使用 **AES-256-GCM** 加密。密钥由 `scrypt(用户名 + per-install 随机盐)` 派生（盐存于插件数据目录 `.cred-salt`），仅凭 `accounts.json` 无法离线推导密钥，跨机器无法直接读取；兼容解密旧格式（v0.1.0 的硬编码盐格式）。明文凭据不进前端、不写日志。
- **凭据传递**：后端凭据经进程环境变量（`CLAWEMAIL_API_KEY` / `IMAP_*` / `SMTP_*`）从 `accounts.json` 透传，子进程仅在缺失时回退读 `backend/.env`。
- **正文渲染沙箱**：HTML 正文在 `sandbox` 属性 iframe 中渲染（`srcdoc`），防止邮件内脚本逃逸。
- **外网图片代理**：正文中的外网 `<img>` / CSS `url()` 改写为同源 `/image-proxy?url=...`，由独立子进程拉取。代理仅接受 http/https，初始 URL 与每次重定向均校验 host（屏蔽私网/回环）、DNS 解析后校验解析 IP（防 rebinding）、限制响应 8MB，规避 SSRF。
- **不执行任何外部 CLI**（v0.4.0 起）：三个后端全部改为进程内调用 —— ClawEmail 走 SDK 的 HTTP transport、AgentQQ 走官方 REST、IMAP/SMTP 走 `imap`/`nodemailer` 库。用户可控参数从不进入命令行，命令注入面为零。
- **LLM 凭据不回前端**：总结/翻译/连接测试的 API Key 一律服务端回源（宿主 `provider:credentials` / agent `config.yaml`），浏览器与 localStorage 不接触明文 Key。

> 说明：v0.1.0 曾规划「外部收件人需桌面确认后发送」（`identity.mjs` 访客意识 + `_pending_send` 队列），该机制无消费者、队列空转，已在 v0.1.2 移除。当前 send / reply / forward 直接执行；如后续需要「外部收件人确认」，应实现真正的确认消费者。

## 环境变量配置参考

账号凭据优先通过 UI 填写并加密存储于 `accounts.json`。以下环境变量作为可选兜底（在 `backend/.env` 中配置，仅当未通过账号配置提供时生效）：

| 变量 | 用途 | 适用后端 |
|------|------|----------|
| `CLAWEMAIL_API_KEY` | ClawEmail API Key | ClawEmail |
| `CLAWEMAIL_ADDRESS` | ClawEmail 邮箱地址 | ClawEmail |
| `IMAP_HOST` / `IMAP_PORT` | IMAP 服务器 | 个人邮箱 |
| `IMAP_USER` / `IMAP_PASS` | IMAP 账号 / 授权码 | 个人邮箱 |
| `SMTP_HOST` / `SMTP_PORT` | SMTP 服务器 | 个人邮箱 |
| `SMTP_USER` / `SMTP_PASS` | SMTP 账号 / 授权码 | 个人邮箱 |
| `HANAKO_LLM_BASE_URL` | **AI 总结/翻译端点兜底**（OpenAI 兼容 `/v1/chat/completions`，仅在宿主/agent 配置不可用时生效） | 全部 |
| `HANAKO_LLM_API_KEY` | LLM 鉴权 Token（本地网关可留空） | 全部 |
| `HANAKO_LLM_MODEL` | LLM 模型名（默认 `gpt-4o-mini`） | 全部 |

> 域名自动推断：QQ / Gmail / Outlook / 163 / Sina / Aliyun 等常见邮箱的 IMAP/SMTP 主机端口会在未显式配置时自动补全。

## AI 功能（总结 / 翻译）

详情页提供 **「总结」** 与 **「翻译」** 两个按钮，对邮件正文做 LLM 处理：

- **总结**：将邮件正文提炼为 3-5 条中文要点，保留关键信息与待办。
- **翻译**：将正文翻译为目标语言（当前固定 `中文`，可扩展为选项）。

**配置为自动读取，无需手动填写 URL / API Key**（v0.1.1+）：

1. 插件在「AI 设置」面板打开时（及页面加载时）自动检测本机可用配置；
2. 检测优先级（真实 Key 一律服务端回源，绝不经过浏览器 / localStorage）：
   - **Agent 配置**：`~/.hanako/agents/<agent-id>/config.yaml` 中的 `api.api_key` / `api.base_url` / `models.chat`；
   - **宿主聊天供应商**：经 `ctx.bus` 调用 `provider:models-by-type` + `provider:credentials` 解析 baseUrl + apiKey；
   - **环境变量兜底**：`HANAKO_LLM_BASE_URL` / `HANAKO_LLM_API_KEY` / `HANAKO_LLM_MODEL`（本地自托管网关调试用）。
3. 未检测到任何配置时点击按钮返回明确提示，不会静默失败。

> 说明：
> - 旧版需要用户在 UI 手填 Base URL / API Key 的表单已移除（明文 Key 不再进浏览器）。
> - 当前仅处理**纯文本正文**（`text` / `body` / `snippet`）；纯 HTML 或纯图片邮件暂不支持。

## 故障排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 添加账号后列表为空 | 列表/文件夹读本地缓存，需手动同步 | 进入"同步"页点击"刷新当前文件夹"，或在列表页触发同步 |
| `IMAP_PASS not set` | 个人邮箱未填授权码 | 在账号配置中填写 `IMAP/SMTP` 授权码，或配置 `backend/.env` |
| `CLAWEMAIL_API_KEY not set` | 未填 API Key | 在账号配置填写 apiKey |
| `@clawemail/node-sdk 未安装` | 后端依赖缺失 | 依赖应随包发布；若缺失请重新安装应用 |
| 标记为已读后远端未变 | 令牌过期或网络异常 | 检查账号授权状态；ClawEmail 的标记走 SDK 的 HTTP transport |
| AgentQQ 取消已读无效 | 官方 REST 没有该接口 | 预期行为，后端返回说明，非 bug |
| 附件预览/下载 404 | 附件 partId 不匹配 | 确认后端 `read()` 返回的 `attachments[].id` 与请求一致 |

## 开发

```bash
# 后端依赖安装
cd backend && npm install

# 语法校验（所有 .mjs/.js）
for f in backend/*.mjs http/ui.js tools/*.js helper/*.cjs index.js; do node --check "$f"; done
```

> 图标规范：本插件 UI 不使用 emoji 作为功能图标，统一使用 `assets/plugin-page-template.html` 中的 `svgIcon()` 内联描边 SVG（16/18/20px）。新增图标请沿用该模式。

## 实时收件与系统通知（v0.1.6）

| 邮箱类型 | 实时通道 | 说明 |
|---|---|---|
| ClawEmail | WebSocket（`ws-monitor.mjs`） | 秒级推送 |
| 个人邮箱（IMAP） | IMAP IDLE（`imap-idle.mjs`） | 服务器支持 IDLE 时秒级；否则自动降级为 2 分钟周期检查 |
| 全部账号 | 60 秒轮询兜底（`http/ui.js`） | 对比最近 5 封，新邮件写缓存 + 弹通知 |

新邮件到达后：弹 Windows 原生系统通知（SnoreToast，AppID 自动注册；点击回调尽力而为）+ 写入本地缓存（前端列表检测到新邮件自动刷新，无需手动刷新）。通知依赖 `backend/node_modules` 里的 `node-notifier`（已随包发布），不依赖开发机路径。

## 卸载与清理

后端跑在一个**受管 native 服务**里（`runtime/service.mjs`），它的生命周期由宿主控制：
停用/卸载/重新加载应用时宿主会收回去，不需要 pid 文件，也不用手动关。

只有两种极端情况需要 `cleanup.cjs`：宿主异常退出留下孤儿进程，或者手工删安装目录时
提示“文件被占用”。它只排楂孤儿进程，**不删任何目录**：

```bash
node cleanup.cjs           # 列出并终止残留的服务进程
node cleanup.cjs --list    # 只看，不动手
```

> 如果进程杀了又回来，说明宿主仍在托管它 —— 请到「已安装」页停用或重新加载应用，
> 而不是反复杀进程。

## 许可证

AGPL-3.0
