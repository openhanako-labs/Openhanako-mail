# Hanako Mail — HanaAgent 邮件插件

![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)

HanaAgent 原生多邮箱聚合插件。支持 ClawEmail、AgentQQ 官方 API，以及个人邮箱 IMAP/SMTP。

## 架构

```
Hanako Mail 插件
├── tools/          Agent 工具（账号管理/文件夹/邮件列表/发送/同步）
├── routes/         HTTP 路由（邮件 UI API）
├── backend/        后端引擎
│   ├── inbox.mjs           统一入口（CLI + 模块）
│   ├── clawemail-backend   ClawEmail SDK 后端
│   ├── agentqq-backend     AgentQQ agently-cli 后端
│   ├── imap-backend        IMAP/SMTP 个人邮箱后端
│   ├── identity.mjs        访客意识引擎
│   └── common.mjs          公共工具函数
├── helper/         桌面通知助手
├── assets/         前端资源
└── manifest.json   插件清单
```

## 安装

插件已预装在 `~/.hanako/plugins/hanako-mail/`。在 HanaAgent 设置中启用即可。

### 后端依赖

```bash
cd backend && npm install
```

## 账号配置

支持三种邮箱类型：

| 类型 | 域名 | 认证方式 |
|------|------|----------|
| ClawEmail | `@claw.163.com` | API Key |
| AgentQQ | `@agent.qq.com` | API Key |
| 个人邮箱 | 其他域名 | IMAP/SMTP 密码 |

在插件 UI 中添加账号时填写对应信息即可。

## 后端能力矩阵

不同后端支持的 API 能力不同（截至 v0.1.x）。下表为权威参考，UI 已按此实现；不支持的操作会返回明确错误而非静默失败。

| 能力 | ClawEmail | AgentQQ | 个人邮箱 (IMAP/SMTP) |
|------|:---------:|:-------:|:-------------------:|
| 邮件列表 | ✅ | ✅ | ✅ |
| 搜索 | ✅ (SDK) | ✅ | ⚠️ 客户端过滤（非服务端检索） |
| 读取正文 | ✅ | ✅ | ✅ |
| 发送 (含 CC/BCC/附件) | ✅ | ✅ | ✅ |
| 回复 (含附件) | ✅ | ✅ | ✅ |
| 转发 (含原文引用/附件) | ✅ | ✅ | ✅ |
| 附件下载 / 预览 | ✅ | ✅ | ✅ |
| 移动邮件 | ✅ | ❌ (CLI 限制) | ✅ (MOVE/COPY+DELETE) |
| 标记已读 | ✅ | ✅ | ✅ |
| 取消已读 (标为未读) | ✅ | ❌ (CLI 限制) | ✅ |
| 文件夹列表 | ✅ | ✅ | ✅ |

> 说明：
> - AgentQQ 的"移动 / 取消已读"受底层 `agently-cli` 能力限制，当前会返回清晰错误提示，不会静默吞掉。
> - 个人邮箱搜索为拉取后客户端过滤，大量邮件时性能有限。

## 安全模型

- **凭据静态加密**：`apiKey` / `imapPass` / `smtpPass` 在写入 `accounts.json` 前使用 **AES-256-GCM** 加密。密钥由 `scrypt(用户名 + per-install 随机盐)` 派生（盐存于插件数据目录 `.cred-salt`），仅凭 `accounts.json` 无法离线推导密钥，跨机器无法直接读取；兼容解密旧格式（v0.1.0 的硬编码盐格式）。明文凭据不进前端、不写日志。
- **凭据传递**：后端凭据经进程环境变量（`CLAWEMAIL_API_KEY` / `IMAP_*` / `SMTP_*`）从 `accounts.json` 透传，子进程仅在缺失时回退读 `backend/.env`。
- **访客意识 / 外部邮件隐私**：`identity.mjs` 维护内部联系人白名单。发送给外部收件人时进入待发送队列并需桌面确认；外部来信在 UI 中做隐私脱敏提示。
- **正文渲染沙箱**：HTML 正文在 `sandbox` 属性 iframe 中渲染（`srcdoc`），防止邮件内脚本逃逸。
- **外网图片代理**：正文中的外网 `<img>` / CSS `url()` 改写为同源 `/image-proxy?url=...`，由独立子进程拉取。代理仅接受 http/https，初始 URL 与每次重定向均校验 host（屏蔽私网/回环）、DNS 解析后校验解析 IP（防 rebinding）、限制响应 8MB，规避 SSRF。
- **无 shell 执行**：所有外部 CLI（`agently-cli` / `mail-cli`）均解析出真实 JS 入口后用 `spawn(node, [entry, ...args], { shell: false })` 执行，用户可控参数不经过 cmd.exe 解析，杜绝命令注入。
- **LLM 凭据不回前端**：总结/翻译/连接测试的 API Key 一律服务端回源（宿主 `provider:credentials` / agent `config.yaml`），浏览器与 localStorage 不接触明文 Key。

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
| `@clawemail/node-sdk 未安装` | 后端依赖缺失 | `cd backend && npm install` |
| 标记为已读后远端未变 | 缺少 `mail-cli` | 安装 SDK 的 `mail-cli`；UI 会提示"本地已标记（远端标记失败）" |
| AgentQQ 移动/取消已读报错 | CLI 不支持该操作 | 预期行为，后端返回明确错误，非 bug |
| 附件预览/下载 404 | 附件 partId 不匹配 | 确认后端 `read()` 返回的 `attachments[].id` 与请求一致 |

## 开发

```bash
# 后端依赖安装
cd backend && npm install

# 语法校验（所有 .mjs/.js）
for f in backend/*.mjs routes/ui.js tools/*.js helper/*.cjs index.js; do node --check "$f"; done
```

> 图标规范：本插件 UI 不使用 emoji 作为功能图标，统一使用 `assets/plugin-page-template.html` 中的 `svgIcon()` 内联描边 SVG（16/18/20px）。新增图标请沿用该模式。

## 卸载与清理

插件运行时会启动一个常驻后台进程 `ws-monitor.mjs`（实时收件监听），它会占用 `backend/` 目录内的文件。正常情况下**卸载插件时会自动终止该进程**，无需手动干预。

若遇到「删除失败 / 文件被占用」等异常（如 IDE 异常退出导致进程残留），运行清理脚本即可释放占用：

```bash
node cleanup.cjs            # 终止残留的后台进程，释放文件锁
node cleanup.cjs --delete   # 同上，并额外删除 backend/ 目录残留
```

脚本会优先按 `backend/data/.ws-monitor.pid` 终止进程，并兜底扫描所有 node 进程中命令行含 `ws-monitor.mjs` 的予以终止，之后即可正常删除插件目录。

## 许可证

AGPL-3.0
