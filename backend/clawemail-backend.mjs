/**
 * ClawEmail 后端 — 封装 @clawemail/node-sdk + mail-cli
 *
 * SDK 提供：读、写、回复、附件下载、WebSocket 推送、列表/搜索
 * mail-cli 提供：移动、标记（SDK 无对应 API）
 *
 * 列表/搜索已迁移至 SDK transport（mail-cli 的 --fid 参数有 bug）
 */

import { spawn } from "node:child_process";
import path from "node:path";

let MailClient = null;
async function loadMailClient() {
  if (!MailClient) {
    try {
      const mod = await import("@clawemail/node-sdk");
      MailClient = mod.MailClient;
    } catch (e) {
      throw new Error("@clawemail/node-sdk 未安装，请先执行: cd backend && npm install");
    }
  }
  return MailClient;
}

// ── mail-cli 子进程封装（仅用于 move/mark） ────────────

function runMailCli(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const mailCliBin = path.join(__dirname, "node_modules", "@clawemail", "mail-cli", "bin", "mail-cli");
    const proc = spawn(process.execPath, [mailCliBin, "--json", ...args], {
      encoding: "utf-8",
      timeout,
      windowsHide: true,
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`mail-cli exit ${code}: ${stderr.trim()}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`mail-cli JSON parse failed: ${stdout.slice(0, 100)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`spawn mail-cli failed: ${err.message}`));
    });
  });
}

// ── MailClient 工厂（带连接池，避免重复鉴权） ────────────
// 凭据来源：CLAWEMAIL_API_KEY / CLAWEMAIL_ADDRESS 来自 process.env。
// 这两个值由 routes/ui.js 在拉起 inbox.mjs 子进程时从 accounts.json 的 account.apiKey / account.email
// 经环境变量透传；backend/.env 仅作为可选兜底（inbox.mjs 的 loadEnv 仅在缺失时填充）。
const clientPool = new Map();

async function getClient(apiKey, user) {
  apiKey = apiKey || process.env.CLAWEMAIL_API_KEY;
  user = user || process.env.CLAWEMAIL_ADDRESS;
  const key = `${apiKey}:${user}`;
  if (!clientPool.has(key)) {
    clientPool.set(key, new (await loadMailClient())({
      apiKey,
      user,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }));
  }
  return clientPool.get(key);
}

async function createClient(apiKey, user, logger = null) {
  return new (await loadMailClient())({
    apiKey,
    user,
    logger: logger || { info: () => {}, warn: () => {}, error: () => {} },
  });
}

// ── 列表/搜索（用 SDK transport，支持 fid 过滤 + 增量） ──

// 轻量缓存：无过滤条件时 5 秒内命中缓存
const listCache = new Map();
const CACHE_TTL_MS = 5000;

export async function listMessages(fid = "1", options = {}) {
  const { from, subject, keyword, limit = 20, since, before, unread, fts, forceFresh = false } = options;
  const numLimit = Number(limit) || 20;

  // 纯列表（无过滤）走缓存
  const cachedKey = `${fid}:${numLimit}:${unread ? 'U' : ''}`;
  if (!forceFresh && !from && !subject && !keyword && !before && !fts && !since) {
    const cached = listCache.get(cachedKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.messages.slice(0, numLimit);
    }
  }

  const client = await getClient(process.env.CLAWEMAIL_API_KEY, process.env.CLAWEMAIL_ADDRESS);

  const queryParams = { fid, limit: Math.max(numLimit, 50) };
  if (unread) queryParams.unread = true;
  if (since) queryParams.since = since;
  if (before) queryParams.before = before;

  const msgs = await client.transport.listMessages(queryParams);

  // 后过滤
  let filtered = msgs;
  if (from) filtered = filtered.filter(m => (m.from || "").toLowerCase().includes(from.toLowerCase()));
  if (subject) filtered = filtered.filter(m => (m.subject || "").toLowerCase().includes(subject.toLowerCase()));
  if (keyword) filtered = filtered.filter(m => {
    const s = (m.subject || "").toLowerCase();
    const f = (m.from || "").toLowerCase();
    return s.includes(keyword.toLowerCase()) || f.includes(keyword.toLowerCase());
  });

  const slice = filtered.slice(0, numLimit);

  // 缓存纯列表结果
  if (!from && !subject && !keyword && !before && !fts && !since) {
    listCache.set(cachedKey, { timestamp: Date.now(), messages: slice });
  }

  return slice;
}

export async function searchMessages(keyword, options = {}) {
  const { from, subject, since, before, unread, limit = 20, fid = "1" } = options;
  const numLimit = Number(limit) || 20;

  const client = await getClient(process.env.CLAWEMAIL_API_KEY, process.env.CLAWEMAIL_ADDRESS);

  const queryParams = { fid, limit: Math.max(numLimit, 100) };
  if (unread) queryParams.unread = true;
  if (since) queryParams.since = since;

  const msgs = await client.transport.listMessages(queryParams);

  const kw = keyword.toLowerCase();
  return msgs.filter(m => {
    const s = (m.subject || "").toLowerCase();
    const f = (m.from || "").toLowerCase();
    const match = s.includes(kw) || f.includes(kw);
    if (!match && from) return false;
    if (!match && subject) return false;
    return match;
  }).slice(0, numLimit);
}

export async function listFolders() {
  try {
    const result = await runMailCli(["folder", "list"], 10000);
    const data = Array.isArray(result?.data) ? result.data : [];
    return data.map(f => ({
      id: String(f.id || ""),
      name: String(f.name || f.raw || ""),
      unread: Number(f.unreadCount || f.unread || 0),
    }));
  } catch (e) {
    throw new Error(`mail-cli folder list failed: ${e.message}`);
  }
}

// ── 读取邮件（用 SDK） ─────────────────────────────────

export async function readMessage(apiKey, user, messageId, options = {}) {
  const { markRead = false } = options;
  const client = await createClient(apiKey, user);
  return await client.mail.read({ id: messageId, markRead });
}

export async function downloadAttachment(apiKey, user, messageId, partId, outputPath) {
  const client = await createClient(apiKey, user);
  const att = await client.mail.getAttachment({ id: messageId, part: partId });
  await att.writeFile(outputPath);
  return {
    filename: att.filename,
    contentType: att.contentType,
    size: att.size,
    outputPath,
  };
}

// 读取附件内容到内存（Buffer），供插件以 HTTP 方式直接回传给前端预览/下载。
// 与 downloadAttachment 不同，这里不落盘，适合小附件。
export async function readAttachment(apiKey, user, messageId, partId) {
  const client = await createClient(apiKey, user);
  const att = await client.mail.getAttachment({ id: messageId, part: partId });
  const buffer = await att.buffer();
  return {
    filename: att.filename,
    contentType: att.contentType,
    size: att.size,
    buffer,
  };
}

// ── 发送/回复（用 SDK） ───────────────────────────────

export async function sendMail(apiKey, user, options) {
  const { to, cc, bcc, subject, body, html = false, priority = 3, attachments = [] } = options;
  if (!to || to.length === 0) throw new Error("sendMail: 'to' is required");
  if (!subject) throw new Error("sendMail: 'subject' is required");
  if (!body) throw new Error("sendMail: 'body' is required");

  const client = await createClient(apiKey, user);
  return await client.mail.send({
    to: Array.isArray(to) ? to : [to],
    cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
    bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
    subject,
    body,
    html,
    priority,
    attachments: attachments.map(a => ({
      filename: a.filename || path.basename(a.path),
      path: a.path,
      contentType: a.contentType,
    })),
  });
}

export async function replyToMail(apiKey, user, messageId, options) {
  const { body, html = false, toAll = false, cc, attachments = [] } = options;
  if (!body) throw new Error("replyToMail: 'body' is required");

  const client = await createClient(apiKey, user);
  return await client.mail.reply({
    id: messageId,
    body,
    html,
    toAll,
    cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
    attachments: attachments.map(a => ({
      filename: a.filename || path.basename(a.path),
      path: a.path,
      contentType: a.contentType,
    })),
  });
}

// ── 移动/标记（用 mail-cli，SDK 无对应 API） ──────────

export async function moveMessage(messageId, targetFid) {
  return runMailCli(["move", `--ids=${messageId}`, `--fid=${targetFid}`]);
}

export async function markRead(messageId, read = true) {
  return runMailCli(["mark", `--ids=${messageId}`, read ? "--read" : "--unread"]);
}

// ── 实时监听（用 SDK） ─────────────────────────────────

export async function watch(apiKey, user, onMessage) {
  const client = await createClient(apiKey, user);
  client.ws.onMessage(async ({ mailId }) => {
    if (onMessage) await onMessage(mailId);
  });
  client.ws.connect();

  return {
    disconnect: () => client.ws.disconnect(),
    isConnected: () => client.ws.isConnected(),
    client,
  };
}

// ── 清理（进程退出时调用） ──────────────────────────────

export function shutdown() {
  for (const [, client] of clientPool) {
    try { client.ws.disconnect(); } catch {}
  }
  clientPool.clear();
}
