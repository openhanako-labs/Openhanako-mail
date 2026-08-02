/**
 * inbox.mjs — 助手邮箱统一管理入口
 * 
 * 按目标 account 自动选 backend：
 *   - @claw.163.com → clawemail.js（SDK + mail-cli）
 *   - @agent.qq.com → agentqq.js（agently-cli）
 *   - 其他域名 → imap.js（IMAP/SMTP）
 * 
 * 发送策略：所有 send/reply/forward 直接执行。
 * 说明：v0.1.0 曾设计「外部收件人写入 _pending_send 队列待桌面确认」，
 * 该队列无消费者、needsConfirmation 恒为 false，属于死代码，已在 v0.1.2 移除。
 * 如后续需要「外部收件人确认」，应实现真正的确认消费者而非队列空转。
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
import * as clawemail from "./clawemail-backend.mjs";
import * as agentqq from "./agentqq-backend.mjs";
import * as imap from "./imap-backend.mjs";
import * as blocklist from "./blocklist.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const TEMP_DIR = path.join(DATA_DIR, "_imap_tmp");
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

/**
 * 清空账号配置缓存。
 * 常驻 worker 场景：每次请求的凭据经 process.env 注入，账号配置可能变化
 * （编辑凭据/切换账号），处理每个请求前应调用一次，避免拿到旧配置。
 */
export function resetAccountCache() {
  accountCache.clear();
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
    // IMAP 服务端检索（IMAP SEARCH：FROM/SUBJECT），大邮箱不再拉全量客户端过滤
    return await imap.searchMessages(accountEmail, keyword, options);
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

export async function downloadAttachment(accountEmail, messageId, partId, outputDir, folder) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.downloadAttachment(config.apiKey, accountEmail, messageId, partId, outputDir);
  }
  if (config.backend === "imap") {
    return await imap.downloadAttachment(accountEmail, messageId, partId, outputDir, folder);
  }
  return await agentqq.downloadAttachment(messageId, partId, outputDir);
}

export async function getAttachmentData(accountEmail, messageId, partId, folder) {
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
    // 对于 IMAP 后端，下载到临时目录后返回 base64
    const tmpDir = path.join(TEMP_DIR, String(Date.now()));
    const result = await imap.downloadAttachment(accountEmail, messageId, partId, tmpDir, folder);
    const buf = await fs.promises.readFile(result.path);
    // 清理临时文件
    fs.promises.rm(tmpDir, { recursive: true }).catch(() => {});
    return {
      filename: result.filename,
      contentType: result.contentType,
      size: result.size,
      base64: buf.toString("base64"),
    };
  }
  // AgentQQ 后端：下载到临时目录后读取文件返回 base64
  const tmpDir = path.join(TEMP_DIR, String(Date.now()));
  fs.mkdirSync(tmpDir, { recursive: true });
  const dl = await agentqq.downloadAttachment(messageId, partId, tmpDir);
  const filePath = dl.savedTo ? path.join(tmpDir, dl.filename) : null;
  if (!filePath) {
    throw new Error("getAttachmentData: AgentQQ 附件下载未返回文件");
  }
  const buf = await fs.promises.readFile(filePath);
  fs.promises.rm(tmpDir, { recursive: true }).catch(() => {});
  return {
    filename: dl.filename,
    contentType: dl.contentType || "application/octet-stream",
    size: buf.length,
    base64: buf.toString("base64"),
  };
}

export async function sendMail(accountEmail, options, context = {}) {
  const config = getAccount(accountEmail);
  
  options = await normalizeAttachments(config, options);
  
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
  
  options = await normalizeAttachments(config, options);
  
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
  
  options = await normalizeAttachments(config, options);
  
  let result;
  if (config.backend === "clawemail") {
    // ClawEmail SDK 无 forwardMail，改为读取原文后用 sendMail 转发（带原文引用与附件）
    const fwdSubject = `Fwd: ${originalEmail.subject || ""}`;
    const fromStr = Array.isArray(originalEmail.from) ? originalEmail.from.join(", ") : (originalEmail.from || "");
    const toStr = Array.isArray(originalEmail.to) ? originalEmail.to.join(", ") : (originalEmail.to || "");
    const fwdBody = (options.body ? options.body + "\n" : "") +
      "---------- 转发的邮件 ----------\n" +
      `发件人: ${fromStr}\n` +
      `收件人: ${toStr}\n` +
      `主题: ${originalEmail.subject || ""}\n\n` +
      (originalEmail.text || "");
    result = await clawemail.sendMail(config.apiKey, accountEmail, {
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: fwdSubject,
      body: fwdBody,
      html: false,
      attachments: options.attachments || [],
    });
  } else if (config.backend === "imap") {
    result = await imap.forwardMail(accountEmail, messageId, options);
  } else {
    result = await agentqq.forwardMail(messageId, options);
  }
  return { sent: true, result };
}

export async function moveMessage(accountEmail, messageId, targetFid, sourceFolder) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.moveMessage(messageId, targetFid);
  }
  if (config.backend === "imap") {
    return await imap.moveMessage(accountEmail, messageId, targetFid, sourceFolder);
  }
  throw new Error("moveMessage: AgentQQ backend move not implemented (CLI limitation)");
}

export async function deleteMessage(accountEmail, messageId, options = {}) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    // 传入 options（含 folder），否则两步删除逻辑收不到来源文件夹，永远走 INBOX 分支
    return await clawemail.deleteMessage(messageId, options);
  }
  if (config.backend === "imap") {
    return await imap.deleteMessage(accountEmail, messageId, options);
  }
  throw new Error("deleteMessage: AgentQQ backend delete not implemented (CLI limitation)");
}

/**
 * 批量删除（v0.1.5）：循环单封删除，单封失败不中断整体。
 * 常驻 worker 下 IMAP 连接池复用，无需逐封重建连接。
 * @returns {{ deleted: string[], failed: {id:string,error:string}[] }}
 */
export async function bulkDelete(accountEmail, ids, options = {}) {
  const list = Array.isArray(ids) ? ids.map((x) => String(x)) : [];
  const deleted = [];
  const failed = [];
  for (const id of list) {
    try {
      await deleteMessage(accountEmail, id, options);
      deleted.push(id);
    } catch (e) {
      failed.push({ id, error: String(e?.message || e) });
    }
  }
  return { deleted, failed };
}

/** 保存草稿（v0.1.5）：仅 IMAP 后端支持（append 到 DRAFTS 文件夹）。 */
export async function saveDraft(accountEmail, options = {}) {
  const config = getAccount(accountEmail);
  if (config.backend !== "imap") {
    throw new Error("saveDraft: 仅 IMAP 后端支持草稿保存（ClawEmail / AgentQQ 暂不支持）");
  }
  return await imap.saveDraft(accountEmail, options);
}

export async function markSpam(accountEmail, messageId, options = {}) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.markSpam(messageId);
  }
  if (config.backend === "imap") {
    return await imap.markSpam(accountEmail, messageId, options);
  }
  throw new Error("markSpam: AgentQQ backend not implemented (CLI limitation)");
}

// ── 垃圾邮件自动过滤（6.3） ────────────────────────────
// 规则来源 = blocklist.mjs（黑名单 / 白名单）。
//   - 黑名单发件人的邮件 → 移到垃圾箱
//   - 白名单发件人 → 永不自动过滤
// 预留 LLM 打分钩子（scoreSpamWithLlm）：当前默认关闭，避免在无明确模型配置时产生
// 额外开销或误判；未来可作为第二道规则叠加在黑名单之上。

// 预留：LLM 垃圾打分（未来增强）。当前未启用。
const LLM_SPAM_SCORING_ENABLED = false;
async function scoreSpamWithLlm(msg) {
  // TODO(6.3+): 调用 llm.mjs 对邮件正文打分，返回 0~1 的垃圾概率。
  // 启用方式：将 LLM_SPAM_SCORING_ENABLED 置 true，并在 filterSpamMessages 内
  // if (LLM_SPAM_SCORING_ENABLED) { const s = await scoreSpamWithLlm(m); if (s > 0.9) move... }
  return null;
}

// 从邮件对象抽取发件人邮箱（兼容 from 为字符串 / 数组 / {address} 对象 三种形态）
function senderEmailOf(msg) {
  const f = msg && msg.from;
  if (!f) return "";
  if (typeof f === "string") {
    const m = f.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    return m ? m[0].toLowerCase() : f.toLowerCase();
  }
  if (Array.isArray(f)) {
    const first = f[0];
    if (typeof first === "string") return senderEmailOf({ from: first });
    if (first && typeof first === "object" && first.address) return String(first.address).toLowerCase();
  }
  if (typeof f === "object" && f.address) return String(f.address).toLowerCase();
  return "";
}

/**
 * 对指定文件夹的邮件执行黑名单自动过滤：把黑名单发件人的邮件移到垃圾箱。
 * @returns {{ ok: boolean, movedIds: string[], scanned: number, error?: string }}
 */
export async function filterSpamMessages(accountEmail, options = {}) {
  const folder = options.folder || options.fid || "INBOX";
  try {
    const messages = await listMessages(accountEmail, { folder, fid: folder, limit: 100 });
    const list = Array.isArray(messages) ? messages : [];
    const movedIds = [];

    for (const m of list) {
      const sender = senderEmailOf(m);
      if (!sender) continue;
      // 白名单优先：永不自动过滤
      if (blocklist.isWhitelisted(sender)) continue;
      // 黑名单：直接移入垃圾箱
      if (blocklist.isBlacklisted(sender)) {
        try {
          await markSpam(accountEmail, m.id, { folder });
          movedIds.push(String(m.id));
        } catch (e) {
          // 单封移动失败不影响其余邮件
          console.warn(`[spam-filter] move failed for ${m.id}: ${e.message}`);
        }
      } else if (LLM_SPAM_SCORING_ENABLED) {
        // 预留：LLM 打分触发过滤（当前关闭，不会进入此分支）
        const score = await scoreSpamWithLlm(m);
        if (score != null && score > 0.9) {
          try {
            await markSpam(accountEmail, m.id, { folder });
            movedIds.push(String(m.id));
          } catch (e) { /* ignore */ }
        }
      }
    }

    return { ok: true, movedIds, scanned: list.length };
  } catch (e) {
    return { ok: false, movedIds: [], scanned: 0, error: e.message };
  }
}

export async function markRead(accountEmail, messageId, read = true, folder) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.markRead(messageId, read);
  }
  if (config.backend === "imap") {
    return await imap.markRead(accountEmail, messageId, read, folder);
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
// COMMANDS / parseOptions 同时供常驻 worker（worker.mjs）复用：
// 宿主侧不再每次冷启 node 子进程，而是经 stdin/stdout JSON-RPC 把
// CLI 风格参数发给常驻 worker，worker 用同一张命令表执行。

export const COMMANDS = {
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
  move: async ([email, messageId, targetFid, ...rest]) => {
    const opts = parseOptions(rest);
    return await moveMessage(email, messageId, targetFid, opts.folder);
  },
  delete: async ([email, messageId, ...rest]) => {
    const opts = parseOptions(rest);
    return await deleteMessage(email, messageId, opts);
  },
  "bulk-delete": async ([email, ...rest]) => {
    const opts = parseOptions(rest);
    const ids = Array.isArray(opts.ids) ? opts.ids : (opts.ids ? String(opts.ids).split(",").map(s => s.trim()).filter(Boolean) : []);
    return await bulkDelete(email, ids, opts);
  },
  "save-draft": async ([email, ...rest]) => {
    const opts = parseOptions(rest);
    return await saveDraft(email, opts);
  },
  spam: async ([email, messageId]) => {
    return await markSpam(email, messageId);
  },
  "filter-spam": async ([email, ...rest]) => {
    const opts = parseOptions(rest);
    return await filterSpamMessages(email, opts);
  },
  "mark-read": async ([email, messageId, ...rest]) => {
    const opts = parseOptions(rest);
    return await markRead(email, messageId, true, opts.folder);
  },
  folders: async ([email]) => {
    return await listFolders(email);
  },
  attachment: async ([email, messageId, partId, ...rest]) => {
    const opts = parseOptions(rest);
    return await getAttachmentData(email, messageId, partId, opts.folder);
  },
};

export function parseOptions(args) {
  const opts = {};
  let jsonFile = null;
  for (const arg of args) {
    // Strip leading dashes (--key=value → key=value)
    const clean = arg.replace(/^-+/, '');
    // --json=<file> 透传结构化参数（cc/bcc/attachments 等），覆盖普通 key=value
    if (clean.startsWith("json=")) {
      jsonFile = clean.slice("json=".length);
      continue;
    }
    const eqIdx = clean.indexOf('=');
    if (eqIdx > 0) {
      const key = clean.slice(0, eqIdx);
      const val = clean.slice(eqIdx + 1);
      opts[key] = val;
    }
  }
  if (jsonFile) {
    try {
      const extra = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
      Object.assign(opts, extra);
    } catch (e) {
      // 忽略无法解析的 json 文件，退回 CLI 参数
    }
  }
  return opts;
}

// ── 附件归一化 ─────────────────────────────────────────
// 前端以 base64 上传附件（{filename, contentType, base64}）。
// 不同后端对附件的接受方式不同：
//   - clawemail / imap：需要可访问的文件路径（imap 也可用 Buffer content）
//   - agentqq：需要先 uploadAttachment 拿到 fileId
// 这里统一把 base64 转成后端所需形态。

const UPLOAD_DIR = path.join(DATA_DIR, "_uploads");

function writeTempFile(att) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const safeName = path.basename(att.filename || `attachment_${Date.now()}`);
  const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`);
  const buf = Buffer.from(att.base64 || "", "base64");
  fs.writeFileSync(filePath, buf);
  return filePath;
}

async function normalizeAttachments(config, options) {
  const atts = options.attachments;
  if (!Array.isArray(atts) || atts.length === 0) return options;

  if (config.backend === "agentqq") {
    const fileIds = [];
    for (const a of atts) {
      const p = writeTempFile(a);
      const fid = await agentqq.uploadAttachment(p);
      fileIds.push(fid);
    }
    const next = { ...options };
    delete next.attachments;
    next.fileIds = fileIds;
    return next;
  }

  // clawemail / imap：转成带 path 的附件描述
  const withPaths = atts.map((a) => ({
    filename: a.filename || path.basename(a.path || "attachment"),
    path: a.path || writeTempFile(a),
    contentType: a.contentType,
  }));
  return { ...options, attachments: withPaths };
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
