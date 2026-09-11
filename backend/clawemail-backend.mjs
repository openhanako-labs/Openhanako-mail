/**
 * ClawEmail 后端 —— 全部走 @clawemail/node-sdk（进程内 HTTP）。
 *
 * 历史：文件夹列表 / 移动 / 标记 / 删除 曾用 `mail-cli` 子进程（SDK 当時没暴露这些）。
 * v0.3.2 起**全部改为进程内**，因为本模块跑在受管 native 服务里，
 * 而那个进程被 Job Object 管着、**不能再 spawn**（实测报 spawn EPERM）。
 * 好在 AjaxTransport 已经有这些方法，不必再绕路：
 *   listFolders / listMessages / moveMessages / markMessages / getMessage / searchMessages
 * 顺带的好处：不再依赖邮件夹路径、不再有 cmd.exe 解析面。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToText } from "./common.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── transport 取用（进程内 HTTP）───────────────────
// transport 在类型上是 private，但 listMessages 一直在用它；这里统一走同一个取口。
async function getTransport(apiKey, user) {
  const client = await getClient(apiKey, user);
  if (!client.transport) throw new Error("ClawEmail transport 不可用（SDK 版本不符）");
  return client.transport;
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
    const transport = await getTransport(process.env.CLAWEMAIL_API_KEY, process.env.CLAWEMAIL_ADDRESS);
    const data = await transport.listFolders();
    return (Array.isArray(data) ? data : []).map(f => ({
      id: String(f.id || ""),
      name: String(f.name || ""),
      unread: Number(f.unreadCount || 0),
    }));
  } catch (e) {
    throw new Error(`ClawEmail 文件夹列表获取失败: ${e.message}`);
  }
}

// ── 读取邮件（用 SDK） ─────────────────────────────────

export async function readMessage(apiKey, user, messageId, options = {}) {
  const { markRead = false } = options;
  const client = await createClient(apiKey, user);
  const mail = await client.mail.read({ id: messageId, markRead });
  // ClawEmail SDK 返回的 HTML 邮件通常 text 为空、html 是 {content:string} 对象；
  // 这里从 html/textContent 兜底提取纯文本，保证总结/翻译等下游能拿到正文。
  const htmlSrc =
    (mail.html && (typeof mail.html === "string" ? mail.html : mail.html.content || "")) ||
    mail.textContent ||
    "";
  if (!mail.text && htmlSrc) {
    mail.text = htmlToText(htmlSrc);
  }
  return mail;
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

// ── 移动/标记（用 transport，进程内 HTTP） ──────────

export async function moveMessage(messageId, targetFid) {
  const transport = await getTransport(process.env.CLAWEMAIL_API_KEY, process.env.CLAWEMAIL_ADDRESS);
  await transport.moveMessages([String(messageId)], String(targetFid));
  return { ok: true, moved: messageId, targetFid: String(targetFid) };
}

export async function markRead(messageId, read = true) {
  const transport = await getTransport(process.env.CLAWEMAIL_API_KEY, process.env.CLAWEMAIL_ADDRESS);
  await transport.markMessages([String(messageId)], { read: !!read });
  return { ok: true, id: messageId, read: !!read };
}

export async function deleteMessage(messageId, options = {}) {
  const folder = options.folder || "INBOX";
  const folders = await listFolders();
  const all = Array.isArray(folders) ? folders : [];
  const cur = all.find((f) => f.id === folder || f.name === folder);
  const isTrash = !!(cur && (cur.type === "trash" || /trash|deleted|垃圾箱|废纸|已删除/.test(String(cur.name || "").toLowerCase())));
  if (!isTrash) {
    const trash = all.find((f) => f.type === "trash")
      || all.find((f) => /trash|deleted|垃圾箱|废纸|已删除/.test(String(f.name || f.id || "").toLowerCase()));
    if (trash) {
      const r = await moveMessage(messageId, trash.id);
      return { movedToTrash: true, targetFid: trash.id, ...r };
    }
  }
  // 没有可定位的垃圾箱：标记已读作为降级（比默默不删好），并如实告知调用方。
  await markRead(messageId, true);
  return { ok: true, deleted: false, markedRead: true, reason: "未找到垃圾箱文件夹，已标记为已读" };
}

export async function markSpam(messageId) {
  const folders = await listFolders();
  const all = Array.isArray(folders) ? folders : [];
  const spam = all.find(f => f.type === "spam")
    || all.find(f => /spam|junk|垃圾/.test(String(f.name || f.id || "").toLowerCase()));
  if (!spam) throw new Error("未找到垃圾邮件文件夹");
  return moveMessage(messageId, spam.id);
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
