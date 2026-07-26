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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDataDir() {
  // plugin-data 目录在 Hana 的数据根下，不在插件目录内
  const dataRoot = process.env.HANAKO_PLUGIN_DATA || path.join(process.env.USERPROFILE || "", ".hanako", "plugin-data", "hanako-mail", "hanako-mail");
  return dataRoot;
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
  const file = path.join(cacheDir, `ws-${accountId}-${mail.id}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(mail, null, 2), "utf-8");
  } catch (e) {
    console.warn("[ws-monitor] save mail failed", { mailId: mail.id, err: e.message });
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
    console.warn("[ws-monitor] notify failed", { err: e.message });
  }
}

// 简易身份路由（从 email-monitor/identity.mjs 简化）
function simpleIdentityRoute(fromStr, accountEmail) {
  const lower = fromStr.toLowerCase();
  const own = accountEmail.toLowerCase();
  if (lower.includes(own)) return { identity: "self", isExternal: false, shouldAutoReply: false, requireReply: false };

  // 内部联系人（可从环境变量扩展）
  const internal = (process.env.EMAIL_INTERNAL_CONTACTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const c of internal) { if (lower.includes(c)) return { identity: "internal", isExternal: false, shouldAutoReply: false, requireReply: false }; }

  // 身份映射
  const map = (process.env.EMAIL_IDENTITY_MAP || "").split(",").map(s => s.trim()).filter(Boolean);
  for (const entry of map) {
    const [addr, identity] = entry.split("=");
    if (addr && identity && lower.includes(addr.toLowerCase())) {
      return { identity, isExternal: false, shouldAutoReply: true, requireReply: false };
    }
  }

  return { identity: "unknown", isExternal: true, shouldAutoReply: false, requireReply: false };
}

async function autoReply(client, accountEmail, mailId, email) {
  try {
    const fromArr = Array.isArray(email.from) ? email.from : [email.from || ""];
    const fromStr = fromArr.join(" ");
    const { identity, shouldAutoReply } = simpleIdentityRoute(fromStr, accountEmail);
    if (!shouldAutoReply) return;

    const subject = email.subject || "(无主题)";
    const replyBody = `[自动回复] 收到你的邮件：${subject}\n\n（${identity}）`;

    await client.mail.reply({
      id: mailId,
      body: replyBody,
      html: false,
      toAll: false,
    });
    console.log(`[ws-monitor] 自动回复已发送`, { mailId, to: fromStr });
  } catch (e) {
    console.error("[ws-monitor] 自动回复失败", { mailId, err: e.message });
  }
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
      info: (msg, data) => console.log(`[ws-monitor][${accountId}] ${msg}`, data || ""),
      warn: (msg, data) => console.warn(`[ws-monitor][${accountId}] ${msg}`, data || ""),
      error: (msg, data) => console.error(`[ws-monitor][${accountId}] ${msg}`, data || ""),
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

      // 自动回复
      await autoReply(client, account.email, mailId, email);

      console.log(`[ws-monitor][${accountId}] 新邮件已缓存`, { mailId, subject, from: fromStr });
    } catch (e) {
      console.error(`[ws-monitor][${accountId}] 处理邮件失败`, { mailId, err: e.message });
    }
  });

  client.ws.onDisconnect(async (reason) => {
    console.warn(`[ws-monitor][${accountId}] WebSocket 断开: ${reason}，5秒后重连...`);
    setTimeout(() => startAccount(account), 5000);
  });

  try {
    await client.ws.connect();
    console.log(`[ws-monitor][${accountId}] ✅ WebSocket 已连接: ${account.email}`);
  } catch (e) {
    console.error(`[ws-monitor][${accountId}] 连接失败: ${e.message}`);
    setTimeout(() => startAccount(account), 10000);
  }
}

// 启动所有账号
export async function startAll() {
  ensureDir(getDataDir());
  const accounts = loadAccounts();
  for (const account of accounts) {
    try { await startAccount(account); } catch (e) {
      console.error("[ws-monitor] 启动账号失败", { email: account.email, err: e.message });
    }
  }
}
