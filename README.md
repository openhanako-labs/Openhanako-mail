# Hanako Mail

Hana 原生多邮箱聚合插件：IMAP/SMTP + 官方 API，支持多账号、文件夹、已读未读、回复。

## 功能

- **多邮箱后端**：ClawEmail（163）和 AgentQQ（QQ）自动选路
- **身份感知**：按收件人地址映射到不同助手身份，差异化处理规则
- **隐私脱敏**：外部邮件自动过滤敏感信息（API Key、路径、手机号等）
- **待发送队列**：回复外部联系人需手动确认，写入 `_pending_send/` 队列
- **桌面弹窗通知**：暗色纸质档案室风格，支持点击跳转邮件详情
- **附件预览**：Base64 编码附件在 UI 内直接查看

## 安装

```bash
git clone https://github.com/openhanako-labs/Openhanako-mail.git
cd Openhanako-mail
```

在 Hana 中 dev 加载即可。

**注意：**
- 插件本体可直接加载，无需 `npm install`
- ClawEmail（163）后端需要 `cd backend && npm install` 安装 `@clawemail/node-sdk`
- AgentQQ（QQ）后端依赖本地 `agently-cli`，需单独安装

## 配置

在 `backend/.env` 中配置环境变量：

```env
CLAWEMAIL_API_KEY=your-api-key
CLAWEMAIL_ADDRESS=your-email@claw.163.com
CLAWEMAIL_EXTRA_ADDRESSES=extra1@claw.163.com,extra2@claw.163.com
AGENTQQ_EXTRA_ADDRESSES=your-agent@agent.qq.com
EMAIL_IDENTITY_MAP=email1@claw.163.com=ophelia,email2@claw.163.com=luoqixi
EMAIL_INTERNAL_CONTACTS=internal@example.com
```

## 结构

```
hanako-mail/
├── backend/           # 后端逻辑
│   ├── common.mjs     # 公共工具函数
│   ├── identity.mjs   # 身份识别与隐私脱敏
│   ├── inbox.mjs      # 统一邮箱管理入口
│   ├── clawemail-backend.mjs  # ClawEmail 后端
│   └── agentqq-backend.mjs    # AgentQQ 后端
├── routes/            # HTTP 路由
│   └── ui.js          # 前端页面 + API
├── tools/             # Agent 工具
│   ├── accounts.js
│   ├── folders.js
│   ├── messages.js
│   ├── send.js
│   └── sync.js
├── helper/            # 桌面通知辅助程序
│   ├── mail-toast.cjs       # node-notifier / SnoreToast
│   ├── click.vbs            # 无窗口 VBS 回调脚本
│   ├── MailToastHelper/     # C# WinForms 弹窗（备用）
│   └── bin/                 # 编译产物
└── assets/            # 前端资源
    └── plugin-page-template.html
```

## License

AGPL-3.0
