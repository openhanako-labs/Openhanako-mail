/**
 * imap-idle.mjs — IMAP 实时收件监听器（RFC 2177 IDLE）
 *
 * 功能：为每个个人邮箱（IMAP 后端）账号建立 IDLE 长连接，服务器有新邮件时
 * 主动推送（node-imap 触发 'mail' 事件），插件立即：
 *   1) 拉取最新未读邮件（解析 subject/from）
 *   2) 写入 plugin-data 缓存（cache/ws-<accountId>-<mailId>.json，与 ws-monitor 同格式，
 *      前端 / 工具列表自动合并）
 *   3) 弹系统级桌面通知（helper/mail-toast.cjs，与 ws-monitor 同链路）
 *
 * 断线自动重连（指数退避）；服务器不支持 IDLE 时自动降级为周期性检查。
 * 由 index.js 启动/关停；cleanup.cjs 兜底清理。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { simpleParser } from "mailparser";
import { getImapConfig, connectImap, openBox } from "./imap-backend.mjs";
import { setCryptoDataDir, decryptSensitiveFields } from "./cred-crypto.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDataDir() {
  return process.env.HANAKO_PLUGIN_DATA || path.join(os.homedir(), ".hanako", "plugin-data", "hanako-mail");
}

const DATA_DIR = getDataDir();
const LOG_PATH = path.join(DATA_DIR, "imap-idle.log");
const POLL_FALLBACK_MS = 2 * 60 * 1000; // 不支持 IDLE 时降级轮询间隔
const MAX_FETCH_PER_EVENT = 5;          // 单次事件最多拉取/通知的邮件数

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = data ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data)}` : `[${ts}] [${level}] ${msg}`;
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch {}
  process.stderr.write(line + "\n");
}

function loadAccounts() {
  const accountsPath = path.join(DATA_DIR, "accounts.json");
  try {
    setCryptoDataDir(DATA_DIR);
    const raw = JSON.parse(fs.readFileSync(accountsPath, "utf-8"));
    return (Array.isArray(raw) ? raw : []).map(decryptSensitiveFields);
  } catch { return []; }
}

// ── 已处理集合（防重复通知/缓存） ──
function loadProcessed(accountId) {
  const f = path.join(DATA_DIR, `_processed_imap_${accountId}.json`);
  try { return new Set(JSON.parse(fs.readFileSync(f, "utf-8"))); } catch { return new Set(); }
}
function saveProcessed(accountId, set) {
  const f = path.join(DATA_DIR, `_processed_imap_${accountId}.json`);
  try { fs.writeFileSync(f, JSON.stringify([...set]), "utf-8"); } catch {}
}

// ── 写缓存（与 ws-monitor 同格式，前端自动合并） ──
function saveMail(accountId, mail) {
  const cacheDir = path.join(DATA_DIR, "cache");
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
  const safeMailId = String(mail.id).replace(/:/g, "_");
  const file = path.join(cacheDir, `ws-${accountId}-${safeMailId}.json`);
  try { fs.writeFileSync(file, JSON.stringify(mail, null, 2), "utf-8"); } catch (e) {
    log("WARN", "save mail failed", { mailId: mail.id, err: e.message });
  }
}

// ── 系统桌面通知（与 ws-monitor 同链路） ──
function notifyDesktop(subject, sender, messageId, accountId) {
  try {
    const toastScript = path.join(__dirname, "..", "helper", "mail-toast.cjs");
    if (!fs.existsSync(toastScript)) { log("WARN", "mail-toast.cjs 不存在"); return; }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const argsFile = path.join(DATA_DIR, `notify-args-${id}.json`);
    fs.writeFileSync(argsFile, JSON.stringify({ subject, sender, messageId, accountId }), "utf-8");
    execFile(process.execPath, [toastScript, "--args-file", argsFile], {
      cwd: path.join(__dirname, ".."),
      windowsHide: true,
      env: { ...process.env, NODE_PATH: path.join(__dirname, "node_modules") },
    }, (err) => {
      try { fs.unlinkSync(argsFile); } catch {}
      if (err) log("WARN", "桌面通知失败", { err: err.message });
    });
  } catch (e) {
    log("WARN", "桌面通知失败", { err: e.message });
  }
}

// ── 从 IDLE 连接拉取并解析最新未读邮件 ──
async function fetchNewMails(imap, limit = MAX_FETCH_PER_EVENT) {
  const uids = await new Promise((resolve, reject) => {
    imap.search(["UNSEEN"], (err, results) => (err ? reject(err) : resolve(results || [])));
  });
  const recent = uids.slice(Math.max(0, uids.length - limit));
  if (!recent.length) return [];
  const rawMessages = await new Promise((resolve, reject) => {
    const f = imap.fetch(recent, { bodies: "" });
    const messages = [];
    f.on("message", (msg) => {
      const buffers = [];
      msg.on("body", (stream) => {
        stream.on("data", (chunk) => buffers.push(chunk));
        stream.on("end", () => messages.push({ uid: msg.uid, raw: Buffer.concat(buffers) }));
      });
    });
    f.once("error", reject);
    f.once("end", () => resolve(messages));
  });
  const parsed = [];
  for (const m of rawMessages) {
    try {
      const p = await simpleParser(m.raw);
      parsed.push({
        id: String(m.uid),
        uid: m.uid,
        from: p.from ? p.from.text : "",
        subject: p.subject || "(无主题)",
        date: p.date || new Date(),
        textContent: p.text || "",
        read: false,
        platform: "imap-idle",
      });
    } catch (e) {
      log("WARN", "parse failed", { uid: m.uid, err: e.message });
    }
  }
  return parsed;
}

// ── 单个账号的 IDLE 监听 ──
async function watchAccount(account) {
  const email = account.email;
  const accountId = account.id;
  if (!email || accountId == null) return;
  const lower = String(email).toLowerCase();
  if (lower.endsWith("@claw.163.com") || lower.endsWith("@agent.qq.com")) return; // 非 IMAP 后端

  const cfg = account.config || {};
  const processed = loadProcessed(accountId);

  // 凭据注入 process.env 后复用 imap-backend 的配置解析（含域名推断）
  const prevEnv = {};
  const setEnv = (k, v) => { prevEnv[k] = process.env[k]; if (v !== undefined && v !== null) process.env[k] = String(v); };
  setEnv("IMAP_HOST", cfg.imapHost); setEnv("IMAP_PORT", cfg.imapPort);
  setEnv("IMAP_USER", cfg.imapUser); setEnv("IMAP_PASS", cfg.imapPass);

  let imap = null;
  let closed = false;
  let reconnectTimer = null;
  let fallbackTimer = null;
  const cleanup = () => { for (const k of Object.keys(prevEnv)) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; } };

  const onNewMail = async () => {
    if (closed) return;
    try {
      const mails = await fetchNewMails(imap);
      for (const mail of mails) {
        if (processed.has(mail.id)) continue;
        // 跳过自己发出的邮件
        const fromStr = mail.from || "";
        if (fromStr.includes(email)) continue;
        mail.accountId = accountId;
        mail.receivedAt = new Date().toISOString();
        saveMail(accountId, mail);
        processed.add(mail.id);
        notifyDesktop(mail.subject, fromStr, mail.id, accountId);
        log("INFO", "新邮件已缓存并通知", { accountId, mailId: mail.id, subject: mail.subject, from: fromStr });
      }
      saveProcessed(accountId, processed);
      if (processed.size > 2000) { // 防无限增长
        for (const k of [...processed].slice(0, 500)) processed.delete(k);
      }
    } catch (e) {
      log("WARN", "新邮件处理失败", { err: e.message });
    }
  };

  const connect = async () => {
    if (closed) return;
    try {
      const config = getImapConfig(email);
      if (!config.host) { log("WARN", "缺少 IMAP 主机配置，跳过", { email }); return; }
      imap = await connectImap(config);
      await openBox(imap, "INBOX", true);
      log("INFO", "已连接并进入监听", { email });

      imap.on("mail", () => onNewMail());
      imap.on("update", () => { /* flags 变化，忽略 */ });
      imap.on("error", (err) => {
        log("WARN", "连接错误，准备重连", { email, err: err.message });
        imapEnd();
      });
      imap.on("close", () => {
        log("WARN", "连接关闭，准备重连", { email });
        imapEnd();
      });

      // 兜底：周期检查（服务器不支持 IDLE 或事件偶发丢失时，仍能收到新邮件）
      if (fallbackTimer) clearInterval(fallbackTimer);
      fallbackTimer = setInterval(() => {
        if (closed || !imap || imap.state === "disconnected") return;
        onNewMail();
      }, POLL_FALLBACK_MS);
    } catch (e) {
      log("WARN", "连接失败", { email, err: e.message });
      imapEnd();
    }
  };

  const imapEnd = () => {
    if (closed) return;
    try { if (imap) imap.end(); } catch {}
    imap = null;
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    cleanup();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (!closed) connect(); }, 30000);
  };

  connect();

  // 返回停止函数（进程退出时由 shutdown 统一处理，这里仅做标记）
  return () => { closed = true; if (reconnectTimer) clearTimeout(reconnectTimer); if (fallbackTimer) clearInterval(fallbackTimer); try { if (imap) imap.end(); } catch {} cleanup(); };
}

// ── 启动全部 IMAP 账号 ──
const stopFns = [];
export async function startAll() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  const accounts = loadAccounts();
  log("INFO", "数据目录", DATA_DIR);
  log("INFO", "账号数量", accounts.length);
  for (const account of accounts) {
    try {
      const stop = await watchAccount(account);
      stopFns.push(stop);
    } catch (e) {
      log("ERROR", "启动账号失败", { email: account.email, err: e.message });
    }
  }
}

function shutdown(code = 0) {
  log("INFO", "收到退出信号，关闭 IMAP 监听...");
  for (const fn of stopFns) { try { fn(); } catch {} }
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGBREAK", () => shutdown(0));

log("INFO", "文件已加载");
startAll();
