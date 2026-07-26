/**
 * 公共工具函数 — 避免 routes/ 和 tools/ 之间的重复代码。
 */

/**
 * 根据文件夹名称映射类型。
 * @param {string} name - 文件夹名（中英文均可）
 * @returns {"inbox"|"sent"|"drafts"|"trash"|"spam"|"custom"}
 */
export function mapType(name) {
  const n = name.toLowerCase();
  if (n.includes("inbox") || n === "收件箱") return "inbox";
  if (n.includes("sent") || n.includes("已发送")) return "sent";
  if (n.includes("draft") || n.includes("草稿")) return "drafts";
  if (n.includes("trash") || n.includes("已删除")) return "trash";
  if (n.includes("spam") || n.includes("垃圾")) return "spam";
  return "custom";
}

/**
 * 将 raw folder 对象转换为标准格式。
 * @param {object} f - 原始文件夹对象，可能包含 id/name/unread 等字段
 * @param {string} accountId - 账号 ID
 * @returns {{id:string, accountId:string, name:string, path:string, type:string, unreadCount:number, totalCount:number}}
 */
export function normalizeFolder(f, accountId) {
  const name = f.name ?? f.id ?? "";
  return {
    id: String(f.id ?? name),
    accountId,
    name,
    path: String(f.id ?? name),
    type: mapType(name),
    unreadCount: Number(f.unread ?? 0),
    totalCount: Number(f.unread ?? 0),
  };
}

/**
 * fallback 默认文件夹列表。
 * @param {string} accountId
 * @returns Array<{id, accountId, name, path, type, unreadCount, totalCount}>
 */
export function defaultFolders(accountId) {
  return [
    { id: "INBOX", accountId, name: "收件箱", path: "INBOX", type: "inbox", unreadCount: 0, totalCount: 0 },
    { id: "Sent", accountId, name: "已发送", path: "Sent", type: "sent", unreadCount: 0, totalCount: 0 },
    { id: "Drafts", accountId, name: "草稿", path: "Drafts", type: "drafts", unreadCount: 0, totalCount: 0 },
    { id: "Trash", accountId, name: "已删除", path: "Trash", type: "trash", unreadCount: 0, totalCount: 0 },
    { id: "Spam", accountId, name: "垃圾邮件", path: "Spam", type: "spam", unreadCount: 0, totalCount: 0 },
  ];
}

/**
 * 构建 inbox.mjs 子进程所需的环境变量。
 * 将 account 中的 apiKey/email/IMAP 配置透传给后端。
 * @param {{apiKey?:string,email?:string,config?:object}} account
 * @returns {object}
 */
export function inboxEnvFor(account) {
  const env = {};
  if (account && account.apiKey) env.CLAWEMAIL_API_KEY = account.apiKey;
  if (account && account.email) env.CLAWEMAIL_ADDRESS = account.email;
  if (account && account.config) {
    const c = account.config;
    if (c.imapHost) env.IMAP_HOST = c.imapHost;
    if (c.imapPort) env.IMAP_PORT = String(c.imapPort);
    if (c.imapUser) env.IMAP_USER = c.imapUser;
    if (c.imapPass) env.IMAP_PASS = c.imapPass;
    if (c.smtpHost) env.SMTP_HOST = c.smtpHost;
    if (c.smtpPort) env.SMTP_PORT = String(c.smtpPort);
    if (c.smtpUser) env.SMTP_USER = c.smtpUser;
    if (c.smtpPass) env.SMTP_PASS = c.smtpPass;
  }
  return env;
}
