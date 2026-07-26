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

## 开发

```bash
# 后端依赖安装
cd backend && npm install
```

## 许可证

AGPL-3.0