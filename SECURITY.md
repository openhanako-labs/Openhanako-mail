# 安全策略（Security Policy）

## 支持的版本

安全修复会合并到 main 分支并随下一个版本发布。建议始终使用最新 release。

## 报告安全漏洞

**请勿在 GitHub Issues 中公开安全漏洞。**

请将漏洞详情私密发送至仓库维护者（GitHub 私信 / 邮件见仓库首页），并在主题中注明 `[SECURITY]`。

报告时请包含：

- 受影响的版本与文件；
- 可复现的最小步骤或 PoC（避免包含真实凭据）；
- 影响的严重程度评估（如可被利用的途径）。

## 处理流程

1. 维护者确认漏洞并评估影响；
2. 在私有分支修复并回归测试；
3. 发布修复版本并同步更新 CHANGELOG；
4. 漏洞公开披露（在确认大部分用户已可升级后）。

## 已知安全设计

- 邮箱凭据以 AES-256-GCM 静态加密存储（`accounts.json`），密钥由用户名 + per-install 随机盐派生；
- 所有外部 CLI（`agently-cli` / `mail-cli`）以 `spawn(..., { shell: false })` 数组参数执行，杜绝命令注入；
- 邮件 HTML 正文在 `sandbox` iframe 中渲染；外网图片经 SSRF 加固的代理拉取；
- LLM API Key 一律服务端回源，不进入浏览器 / localStorage。
