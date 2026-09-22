/**
 * imap-config.mjs — IMAP / SMTP 配置解析（唯一来源）
 *
 * 从 imap-backend.mjs 抽出来，原因是迁移期会同时存在两份 IMAP 实现
 * （旧的 `imap` 库与新的 `imapflow`）。如果各自留一份域名推断表，
 * 两边迟早会在某次修改后对不上，而且症状是「换个实现 QQ 邮箱就连不上了」这种很难查的东西。
 *
 * 凭证来源：环境变量 IMAP_HOST / IMAP_PORT / IMAP_USER / IMAP_PASS /
 *           SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 * 由 routes/ui.js 从 accounts.json 的 account.config 透传。
 */

export function getImapConfig(email) {
  const config = {
    user: process.env.IMAP_USER || email,
    password: process.env.IMAP_PASS || "",
    host: process.env.IMAP_HOST || "",
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    tls: true,
    // 校验证书（原 rejectUnauthorized:false 会允许中间人截获邮箱凭据与全文，已移除）
  };

  // 域名自动推断
  if (!config.host) {
    const lower = email.toLowerCase();
    if (lower.endsWith("@qq.com") || lower.endsWith("@foxmail.com")) {
      config.host = "imap.qq.com";
      config.port = 993;
    } else if (lower.endsWith("@gmail.com")) {
      config.host = "imap.gmail.com";
      config.port = 993;
    } else if (lower.endsWith("@outlook.com") || lower.endsWith("@hotmail.com") || lower.endsWith("@live.com")) {
      config.host = "outlook.office365.com";
      config.port = 993;
    } else if (lower.endsWith("@163.com") || lower.endsWith("@126.com") || lower.endsWith("@yeah.net")) {
      config.host = "imap.163.com";
      config.port = 993;
    } else if (lower.endsWith("@sina.com")) {
      config.host = "imap.sina.com";
      config.port = 993;
    } else if (lower.endsWith("@sohu.com")) {
      config.host = "imap.sohu.com";
      config.port = 993;
    } else if (lower.endsWith("@aliyun.com")) {
      config.host = "imap.aliyun.com";
      config.port = 993;
    }
  }

  return config;
}

export function getSmtpConfig(email) {
  const config = {
    host: process.env.SMTP_HOST || "",
    port: parseInt(process.env.SMTP_PORT || "465", 10),
    secure: true,
    auth: {
      user: process.env.SMTP_USER || email,
      pass: process.env.SMTP_PASS || process.env.IMAP_PASS || "",
    },
  };

  // 域名自动推断
  if (!config.host) {
    const lower = email.toLowerCase();
    if (lower.endsWith("@qq.com") || lower.endsWith("@foxmail.com")) {
      config.host = "smtp.qq.com";
      config.port = 465;
    } else if (lower.endsWith("@gmail.com")) {
      config.host = "smtp.gmail.com";
      config.port = 587;
      config.secure = false;
    } else if (lower.endsWith("@outlook.com") || lower.endsWith("@hotmail.com") || lower.endsWith("@live.com")) {
      config.host = "smtp.office365.com";
      config.port = 587;
      config.secure = false;
    } else if (lower.endsWith("@163.com") || lower.endsWith("@126.com") || lower.endsWith("@yeah.net")) {
      config.host = "smtp.163.com";
      config.port = 465;
    } else if (lower.endsWith("@sina.com")) {
      config.host = "smtp.sina.com";
      config.port = 465;
    } else if (lower.endsWith("@aliyun.com")) {
      config.host = "smtp.aliyun.com";
      config.port = 465;
    }
  }

  return config;
}
