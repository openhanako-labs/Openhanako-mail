/**
 * WebSocket 实时收件监听器
 * 
 * 功能：
 * - 为每个 ClawEmail 账号建立 WebSocket 连接
 * - 收到新邮件后写入 plugin-data 缓存
 * - 收到新邮件后直接调用 helper/mail-toast.cjs 弹系统级桌面通知
 */

import { MailClient } from "@clawemail/node-sdk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
// accounts.json 中的 apiKey 是加密存储的（routes/ui.js 加密落盘），读取后必须解密，
// 否则 MailClient 会拿到 "ENC:..." 密文导致 WebSocket 实时收件失效。
import { setCryptoDataDir, decryptSensitiveFields } from "./cred-crypto.mjs";

// 供 runtime/service.mjs 覆盖数据目录（服务启动时先设好再 import 本模块）
export function setDataDir(dir) { if (dir) process.env.HANAKO_PLUGIN_DATA = dir; }

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
  try {
    setCryptoDataDir(getDataDir());
    const raw = JSON.parse(fs.readFileSync(accountsPath, "utf-8"));
    return (Array.isArray(raw) ? raw : []).map(decryptSensitiveFields);
  } catch { return []; }
}

function loadProcessed(accountId) {
  const f = path.join(getDataDir(), `_processed_${accountId}.json`);
  try { return new Set(JSON.parse(fs.readFileSync(f, "utf-8"))); } catch { return new Set(); }
}

function saveProcessed(accountId, set) {
  const f = path.join(getDataDir(), `_processed_${accountId}.json`);
  fs.writeFileSync(f, JSON.stringify([...set]), "utf-8");
}

// ── 桌面通知：写队列，由 AppHost 取走并派发 ──
//
// 本模块现在跑在受管 native 服务里，**不能 spawn**（Job Object → EPERM），
// 而 Windows 通知必须拉起一个进程。所以写队列，让有 --allow-child-process 的
// AppHost 定时来取（见 http/ui.js 的 drainNotifications）。
function notifyDesktop(subject, sender, messageId, accountId) {
  try {
    const dir = path.join(getDataDir(), "_pending_notify");
    fs.mkdirSync(dir, { recursive: true });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      subject: subject || "(无主题)", sender: sender || "", messageId: messageId || "",
      accountId: accountId || "", queuedAt: new Date().toISOString(),
    }), "utf-8");
  } catch (e) {
    log("WARN", "桌面通知入队失败", { err: e.message });
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

// 直接运行模式（被 spawn 时执行）。
// 被 runtime/service.mjs import 时不自启 —— 那里由服务自己调 startAll() 并拥有生命周期。
// 否则本文件的 SIGTERM 处理器会把整个服务进程一起带走。
const IS_MAIN = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("INFO", "收到退出信号，正在关闭 WebSocket 监听...");
    process.exit(code);
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGBREAK", () => shutdown(0)); // Windows Ctrl+Break

  try {
    log("INFO", "文件已加载");
    await startAll();
  } catch (e) {
    log("ERROR", "启动失败", e);
  }
}
