/**
 * inbox.mjs — 助手邮箱统一管理入口
 * 
 * 按目标 account 自动选 backend：
 *   - @claw.163.com → clawemail.js（SDK + mail-cli）
 *   - @agent.qq.com → agentqq.js（agently-cli）
 * 
 * 白名单逻辑（identity.mjs）：
 *   - 内部联系人（EMAIL_INTERNAL_CONTACTS）→ 直接发送
 *   - 外部 → 写入 _pending_send/ 队列，桌面通知确认
 * 
 * 用法（作为模块）：
 *   import { listMessages, readMessage, send, reply, ... } from "./inbox.mjs";
 * 
 * 用法（CLI）：
 *   node inbox.mjs list user@example.com [--limit=20]
 *   node inbox.mjs read user@example.com <messageId>
 *   node inbox.mjs send user@example.com --to=x@y.com --subject="..." --body="..."
 *   node inbox.mjs reply user@example.com <messageId> --body="..."
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFromEnv } from "./identity.mjs";
import * as clawemail from "./clawemail-backend.mjs";
import * as agentqq from "./agentqq-backend.mjs";
import * as imap from "./imap-backend.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const PENDING_SEND_DIR = path.join(DATA_DIR, "_pending_send");
const ENV_PATH = path.join(__dirname, ".env");

// ── 加载 .env（兜底） ──────────────────────────────────
// 仅当变量尚未在 process.env 中时填充，因此优先级为：
//   1) 调用方透传的环境变量（来自 accounts.json 的 apiKey，由 routes/ui.js 经 CLAWEMAIL_API_KEY 传入）
//   2) backend/.env 文件（可选兜底）

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

// ── 后端选择 ────────────────────────────────────────────

function selectBackend(email) {
  if (!email) throw new Error("selectBackend: email is required");
  const lower = email.toLowerCase();
  if (lower.endsWith("@claw.163.com")) return "clawemail";
  if (lower.endsWith("@agent.qq.com")) return "agentqq";
  // 其他域名走 IMAP/SMTP
  return "imap";
}

function resolveAccountConfig(email) {
  const backend = selectBackend(email);
  if (backend === "imap") {
    const imapPass = process.env.IMAP_PASS || process.env.SMTP_PASS;
    if (!imapPass) {
      throw new Error("IMAP_PASS not set — 个人邮箱需要 IMAP/SMTP 授权码。请在账号配置中填写。");
    }
    return { backend, email };
  }
  const apiKey = process.env.CLAWEMAIL_API_KEY;
  if (!apiKey) {
    throw new Error("CLAWEMAIL_API_KEY not set — 请在 account 中填写 apiKey（accounts.json），或在 backend/.env 中配置兜底。");
  }
  return { backend, email, apiKey };
}

const accountCache = new Map();

function getAccount(email) {
  if (accountCache.has(email)) return accountCache.get(email);
  const config = resolveAccountConfig(email);
  accountCache.set(email, config);
  return config;
}

// ── 白名单检查 ──────────────────────────────────────────

const awareness = buildFromEnv();

function needsConfirmation(email) {
  const from = Array.isArray(email.from) ? email.from.join(" ") : (email.from || "");
  const fromStr = from.toLowerCase();
  
  for (const contact of awareness.internalContacts) {
    if (fromStr.includes(contact.toLowerCase())) return false;
  }
  
  const ownEmails = [
    process.env.CLAWEMAIL_ADDRESS,
    ...(process.env.CLAWEMAIL_EXTRA_ADDRESSES || "").split(",").map(s => s.trim()),
    ...(process.env.AGENTQQ_EXTRA_ADDRESSES || "").split(",").map(s => s.trim()),
  ].filter(Boolean).map(e => e.toLowerCase());
  
  for (const own of ownEmails) {
    if (fromStr.includes(own)) return false;
  }
  
  return true;
}

// ── 待发送队列 ──────────────────────────────────────────

function queuePendingSend(account, operation, targetEmail, payload) {
  fs.mkdirSync(PENDING_SEND_DIR, { recursive: true });
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(PENDING_SEND_DIR, `${id}.json`);
  const entry = {
    id,
    account,
    operation,
    targetEmail,
    payload,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  return entry;
}

// ── 统一 API ───────────────────────────────────────────

export async function listMessages(accountEmail, options = {}) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.listMessages(options.fid || "1", options);
  }
  if (config.backend === "imap") {
    return await imap.listMessages(accountEmail, options);
  }
  return await agentqq.listMessages(options);
}

export async function searchMessages(accountEmail, keyword, options = {}) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.searchMessages(keyword, options);
  }
  if (config.backend === "imap") {
    // IMAP 搜索回退到全量列表后过滤
    const all = await imap.listMessages(accountEmail, { limit: 100 });
    const kw = keyword.toLowerCase();
    return all.filter(m => {
      const s = (m.subject || "").toLowerCase();
      const f = (m.from || "").toLowerCase();
      return s.includes(kw) || f.includes(kw);
    });
  }
  return await agentqq.searchMessages(keyword, options);
}

export async function readMessage(accountEmail, messageId, options = {}) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.readMessage(config.apiKey, accountEmail, messageId, options);
  }
  if (config.backend === "imap") {
    return await imap.readMessage(accountEmail, messageId, options);
  }
  return await agentqq.readMessage(messageId);
}

export async function downloadAttachment(accountEmail, messageId, partId, outputDir) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.downloadAttachment(config.apiKey, accountEmail, messageId, partId, outputDir);
  }
  if (config.backend === "imap") {
    throw new Error("downloadAttachment: IMAP backend attachment download not yet implemented");
  }
  return await agentqq.downloadAttachment(messageId, partId, outputDir);
}

export async function getAttachmentData(accountEmail, messageId, partId) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    const r = await clawemail.readAttachment(config.apiKey, accountEmail, messageId, partId);
    return {
      filename: r.filename,
      contentType: r.contentType,
      size: r.size,
      base64: r.buffer.toString("base64"),
    };
  }
  if (config.backend === "imap") {
    throw new Error("getAttachmentData: IMAP backend attachment serving not yet implemented");
  }
  throw new Error("getAttachmentData: AgentQQ backend does not support attachment serving yet");
}

export async function sendMail(accountEmail, options, context = {}) {
  const config = getAccount(accountEmail);
  
  if (context.originalEmail && needsConfirmation(context.originalEmail)) {
    const queueEntry = queuePendingSend(accountEmail, "send", options.to, options);
    return { queued: true, queueId: queueEntry.id, reason: "external_recipient" };
  }
  
  let result;
  if (config.backend === "clawemail") {
    result = await clawemail.sendMail(config.apiKey, accountEmail, options);
  } else if (config.backend === "imap") {
    result = await imap.sendMail(accountEmail, options);
  } else {
    result = await agentqq.sendMail(options);
  }
  return { sent: true, result };
}

export async function reply(accountEmail, messageId, options = {}) {
  const config = getAccount(accountEmail);
  
  let originalEmail;
  try {
    originalEmail = await readMessage(accountEmail, messageId);
  } catch (e) {
    throw new Error(`reply: failed to read original email: ${e.message}`);
  }
  
  if (needsConfirmation(originalEmail)) {
    const queueEntry = queuePendingSend(accountEmail, "reply", messageId, options);
    return { queued: true, queueId: queueEntry.id, reason: "external_sender", originalEmail };
  }
  
  let result;
  if (config.backend === "clawemail") {
    result = await clawemail.replyToMail(config.apiKey, accountEmail, messageId, options);
  } else if (config.backend === "imap") {
    result = await imap.replyToMail(accountEmail, messageId, options);
  } else {
    result = await agentqq.replyToMail(messageId, options);
  }
  return { sent: true, result };
}

export async function forward(accountEmail, messageId, options = {}) {
  const config = getAccount(accountEmail);
  
  let originalEmail;
  try {
    originalEmail = await readMessage(accountEmail, messageId);
  } catch (e) {
    throw new Error(`forward: failed to read original email: ${e.message}`);
  }
  
  if (needsConfirmation(originalEmail)) {
    const queueEntry = queuePendingSend(accountEmail, "forward", options.to, { messageId, ...options });
    return { queued: true, queueId: queueEntry.id, reason: "external_sender", originalEmail };
  }
  
  let result;
  if (config.backend === "clawemail") {
    throw new Error("forward: ClawEmail backend does not support forward. Use reply or send instead.");
  } else if (config.backend === "imap") {
    throw new Error("forward: IMAP backend does not support forward yet");
  } else {
    result = await agentqq.forwardMail(messageId, options);
  }
  return { sent: true, result };
}

export async function moveMessage(accountEmail, messageId, targetFid) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.moveMessage(messageId, targetFid);
  }
  if (config.backend === "imap") {
    throw new Error("moveMessage: IMAP backend move not implemented");
  }
  throw new Error("moveMessage: AgentQQ backend move not implemented (CLI limitation)");
}

export async function markRead(accountEmail, messageId, read = true) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.markRead(messageId, read);
  }
  if (config.backend === "imap") {
    return await imap.markRead(accountEmail, messageId, read);
  }
  return await agentqq.markRead(messageId, read);
}

export async function listFolders(accountEmail) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.listFolders();
  }
  if (config.backend === "imap") {
    return await imap.listFolders(accountEmail);
  }
  return await agentqq.listFolders();
}

// ── CLI 入口 ────────────────────────────────────────────

const COMMANDS = {
  list: async ([email, ...rest]) => {
    const opts = parseOptions(rest);
    return await listMessages(email, opts);
  },
  search: async ([email, keyword, ...rest]) => {
    const opts = parseOptions(rest);
    return await searchMessages(email, keyword, opts);
  },
  read: async ([email, messageId, ...rest]) => {
    const opts = parseOptions(rest);
    return await readMessage(email, messageId, opts);
  },
  send: async ([email, ...rest]) => {
    const opts = parseOptions(rest);
    return await sendMail(email, opts);
  },
  reply: async ([email, messageId, ...rest]) => {
    const opts = parseOptions(rest);
    return await reply(email, messageId, opts);
  },
  forward: async ([email, messageId, ...rest]) => {
    const opts = parseOptions(rest);
    return await forward(email, messageId, opts);
  },
  move: async ([email, messageId, targetFid]) => {
    return await moveMessage(email, messageId, targetFid);
  },
  "mark-read": async ([email, messageId]) => {
    return await markRead(email, messageId, true);
  },
  folders: async ([email]) => {
    return await listFolders(email);
  },
  attachment: async ([email, messageId, partId]) => {
    return await getAttachmentData(email, messageId, partId);
  },
};

function parseOptions(args) {
  const opts = {};
  for (const arg of args) {
    // Strip leading dashes (--key=value → key=value)
    const clean = arg.replace(/^-+/, '');
    const eqIdx = clean.indexOf('=');
    if (eqIdx > 0) {
      const key = clean.slice(0, eqIdx);
      const val = clean.slice(eqIdx + 1);
      opts[key] = val;
    }
  }
  return opts;
}

// Detect CLI mode
const isCliMode = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCliMode) {
  const [cmd, ...args] = process.argv.slice(2);
  if (COMMANDS[cmd]) {
    try {
      const result = await COMMANDS[cmd](args);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Available: ${Object.keys(COMMANDS).join(", ")}`);
    process.exit(1);
  }
}
