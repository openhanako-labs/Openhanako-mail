/**
 * WebSocket 实时收件监听器
 * 
 * 功能：
 * - 为每个 ClawEmail 账号建立 WebSocket 连接
 * - 收到新邮件后写入 plugin-data 缓存
 * - 可选：根据 identity 规则自动回复
 * - 通过 /api/plugins/hanako-mail/notify 触发桌面通知
 */

import { MailClient } from "@clawemail/node-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFromEnv } from "./identity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDataDir() {
  // plugin-data 目录在 Hana 的数据根下，不在插件目录内
  const dataRoot = process.env.HANAKO_PLUGIN_DATA || path.join(process.env.USERPROFILE || "", ".hanako", "plugin-data", "hanako-mail", "hanako-mail");
  return dataRoot;
}

const LOG_PATH = path.join(getDataDir(), "ws-monitor.log");
function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = data ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data)}` : `[${ts}] [${level}] ${msg}`;
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch {}
  console.log(line);
}

function getCacheDir() {
  return path.join(getDataDir(), "cache");
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function saveMail(accountId, mail) {
  const cacheDir = getCacheDir();
  ensureDir(cacheDir);
  const safeMailId = mail.id.replace(/:/g, "_");
  const file = path.join(cacheDir, `ws-${accountId}-${safeMailId}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(mail, null, 2), "utf-8");
  } catch (e) {
    log("WARN", "save mail failed", { mailId: mail.id, err: e.message });
  }
}

function loadAccounts() {
  const accountsPath = path.join(getDataDir(), "accounts.json");
  try { return JSON.parse(fs.readFileSync(accountsPath, "utf-8")); } catch { return []; }
}

function loadProcessed(accountId) {
  const f = path.join(getDataDir(), `_processed_${accountId}.json`);
  try { return new Set(JSON.parse(fs.readFileSync(f, "utf-8"))); } catch { return new Set(); }
}

function saveProcessed(accountId, set) {
  const f = path.join(getDataDir(), `_processed_${accountId}.json`);
  fs.writeFileSync(f, JSON.stringify([...set]), "utf-8");
}

function notifyDesktop(subject, sender, messageId, accountId) {
  try {
    const notifyDir = path.join(getDataDir(), "_pending_notify");
    ensureDir(notifyDir);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const file = path.join(notifyDir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ subject, sender, messageId, accountId, createdAt: new Date().toISOString() }), "utf-8");
  } catch (e) {
    log("WARN", "notify failed", { err: e.message });
  }
}

let identityCache = null;
function getAwareness() {
  if (!identityCache) {
    try { identityCache = buildFromEnv(); } catch (e) {
      log("WARN", "identity 加载失败", { err: e.message });
      identityCache = { route: () => ({ identity: "unknown", isExternal: true, shouldAutoReply: false, requireReply: false, autoTag: [] }), scrub: (t) => t, map: new Map() };
    }
  }
  return identityCache;
}

async function startAccount(account) {
  if (!account.apiKey || !account.email) return;
  if (!account.email.endsWith("@claw.163.com")) return; // 只处理 ClawEmail

  const accountId = account.id;
  const processed = loadProcessed(accountId);

  const client = new MailClient({
    apiKey: account.apiKey,
    user: account.email,
    logger: {
      info: (msg, data) => log("INFO", msg, data),
      warn: (msg, data) => log("WARN", msg, data),
      error: (msg, data) => log("ERROR", msg, data),
    },
  });

  client.accountId = accountId;

  client.ws.onMessage(async (notification) => {
    const mailId = notification?.mailId;
    if (!mailId) return;
    if (processed.has(mailId)) return;

    try {
      const email = await client.mail.read({ id: mailId, markRead: true });
      const fromArr = Array.isArray(email.from) ? email.from : [email.from || ""];
      const fromStr = fromArr.join(" ");
      const subject = email.subject || "(无主题)";
      const textContent = email.text?.content || email.html?.content || "";

      // 跳过自己发出的邮件
      if (fromArr.some(f => f.includes(account.email))) {
        processed.add(mailId);
        saveProcessed(accountId, processed);
        return;
      }

      const mail = {
        id: mailId,
        from: email.from,
        to: email.to,
        subject,
        date: email.date,
        textContent,
        hasHtml: !!email.html?.content,
        attachments: email.attachments?.map(a => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size })),
        platform: "clawemail",
        accountId,
        identity: "unknown",
        isExternal: true,
        replyDecision: "none",
        receivedAt: new Date().toISOString(),
      };

      saveMail(accountId, mail);
      processed.add(mailId);
      saveProcessed(accountId, processed);

      // 桌面通知
      notifyDesktop(subject, fromStr, mailId, accountId);

      log("INFO", "新邮件已缓存", { accountId, mailId, subject, from: fromStr });
    } catch (e) {
      log("ERROR", "处理邮件失败", { accountId, mailId, err: e.message });
    }
  });

  client.ws.onDisconnect(async (reason) => {
    log("WARN", `WebSocket 断开: ${reason}，5秒后重连...`);
    setTimeout(() => startAccount(account), 5000);
  });

  try {
    await client.ws.connect();
    log("INFO", `WebSocket 已连接: ${account.email}`);
  } catch (e) {
    log("ERROR", `连接失败: ${e.message}`);
    setTimeout(() => startAccount(account), 10000);
  }
}

// 启动所有账号
export async function startAll() {
  ensureDir(getDataDir());
  const accounts = loadAccounts();
  log("INFO", "数据目录", getDataDir());
  log("INFO", "账号数量", accounts.length);
  for (const account of accounts) {
    log("INFO", "启动账号", account.email);
    try { await startAccount(account); } catch (e) {
      log("ERROR", "启动账号失败", { email: account.email, err: e.message });
    }
  }
}

// 直接运行模式（被 index.js spawn 时执行）
try {
  log("INFO", "文件已加载");
  await startAll();
} catch (e) {
  log("ERROR", "启动失败", e);
}
