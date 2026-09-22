/**
 * AgentQQ 后端 —— 直连 REST API（不再依赖 agently-cli 子进程）。
 *
 * 为什么重写：官方 CLI 是 Go 原生二进制、必须 execFileSync。
 * ⚠ 原文写的理由是「本模块跑在受管 native 运行时里、不能再 spawn（Job Object → EPERM）」
 *   —— **那条结论已过期**：现在 native 永远建不起来（HANA_HOME 是符号链接），服务实际跑在
 *   降级后的 local-machine（enforcement: none），实探可以 spawn。
 *   唯一真相来源：runtime/service.mjs 的 probeSpawn。
 * 直连依旧是对的（不用装全局 CLI、不用管子进程），只是理由不再是“不能 spawn”。
 *
 * 接口契约来自官方 CLI 的 `--dry-run`（它会把要发的 HTTP 请求原样打印）+
 * 实测确认，不是猜的：
 *   GET    /v1/me
 *   GET    /v1/aliases/{alias}/messages?limit=N
 *   GET    /v1/aliases/{alias}/messages/{id}
 *   GET    /v1/aliases/{alias}/messages/search?limit=N&q=...
 *   POST   /v1/aliases/{alias}/messages/send      {body, body_format, subject, to:[{email}]}
 *   POST   /v1/aliases/{alias}/messages/{id}/reply   {body, body_format, reply_all}
 *   POST   /v1/aliases/{alias}/messages/{id}/forward {include_attachments, to:[{email}]}
 *   DELETE /v1/aliases/{alias}/messages/{id}            （移入垃圾箱，保留 30 天）
 *   DELETE /v1/aliases/{alias}/messages/{id}/permanent
 *   GET    /v1/aliases/{alias}/messages/{id}/attachments/{att_id}
 *
 * 凭据经环境变量传入（与其它后端一致）：
 *   AGENTQQ_ACCESS_TOKEN / AGENTQQ_REFRESH_TOKEN / AGENTQQ_EXPIRES_AT / AGENTQQ_ALIAS_ID
 * token 过期时自动刷新，并写回 accounts.json（服务有该目录的读写权）。
 */

import fs from "node:fs";
import path from "node:path";
import { apiCall, refreshTokens } from "./agentqq-auth.mjs";
import { setCryptoDataDir, encryptSensitiveFields, decryptSensitiveFields } from "./cred-crypto.mjs";

function dataDir() {
  return process.env.HANAKO_PLUGIN_DATA || path.join(process.env.USERPROFILE || "", ".hanako", "app-data", "hanako-mail");
}

// ── 令牌管理 ────────────────────────────────────────────

let _tokens = null; // { accessToken, refreshToken, expiresAt, aliasId }
let _refreshing = null;

function loadTokens() {
  if (_tokens) return _tokens;
  _tokens = {
    accessToken: process.env.AGENTQQ_ACCESS_TOKEN || "",
    refreshToken: process.env.AGENTQQ_REFRESH_TOKEN || "",
    expiresAt: Number(process.env.AGENTQQ_EXPIRES_AT || 0),
    aliasId: process.env.AGENTQQ_ALIAS_ID || "",
    accountId: process.env.AGENTQQ_ACCOUNT_ID || "",
  };
  return _tokens;
}

/** 刷新出来的新令牌写回 accounts.json，避免每次都要重刷。 */
function persistTokens(accountId, t) {
  if (!accountId) return;
  const file = path.join(dataDir(), "accounts.json");
  try {
    setCryptoDataDir(dataDir());
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const list = (Array.isArray(raw) ? raw : []).map(decryptSensitiveFields);
    const acc = list.find((a) => String(a.id) === String(accountId));
    if (!acc) return;
    acc.config = {
      ...(acc.config || {}),
      agentqqAccessToken: t.accessToken,
      agentqqRefreshToken: t.refreshToken,
      agentqqExpiresAt: String(t.expiresAt),
      ...(t.aliasId ? { agentqqAliasId: t.aliasId } : {}),
    };
    acc.updatedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(list.map(encryptSensitiveFields), null, 2), "utf-8");
  } catch {
    // 写不进去也不致命：内存里的新令牌本次仍有效，下次调用会再刷一次
  }
}

/** 拿一个有效令牌；快过期就先用 refresh_token 换。 */
async function token({ forceRefresh = false } = {}) {
  const t = loadTokens();
  const MARGIN = 60 * 1000;
  if (!forceRefresh && t.accessToken && t.expiresAt - Date.now() > MARGIN) return t.accessToken;

  if (!t.refreshToken) {
    throw new Error("AgentQQ 未授权或授权已失效，请在邮件卡片里重新授权（添加账号 → AgentQQ → 开始授权）");
  }
  if (!_refreshing) {
    _refreshing = refreshTokens(t.refreshToken)
      .then((n) => {
        _tokens = { ...t, ...n };
        persistTokens(t.accountId, _tokens);
        return _tokens.accessToken;
      })
      .catch((e) => {
        // 刷新失败＝授权真的没了；把内存清掉，让上层给出明确的重新授权提示
        _tokens = { ...t, accessToken: "", expiresAt: 0 };
        throw new Error(`AgentQQ 授权已失效，请重新授权：${e.message}`);
      })
      .finally(() => { _refreshing = null; });
  }
  return await _refreshing;
}

/** 解析当前账号的 alias（API 路径里要它）。 */
async function aliasId() {
  const t = loadTokens();
  if (t.aliasId) return t.aliasId;
  const me = await apiCall("/v1/me", { token: await token() });
  const id = pickAlias(me);
  if (!id) throw new Error("该 AgentQQ 账号下没有可用的邮箱别名（alias）");
  t.aliasId = id;
  persistTokens(t.accountId, t);
  return id;
}

/** 从 /v1/me 的响应里挑一个 alias id（结构容错）。 */
export function pickAlias(me) {
  const list = me?.aliases || me?.result?.aliases || me?.data?.aliases || [];
  if (!Array.isArray(list) || !list.length) return "";
  const first = list[0];
  if (typeof first === "string") return first;
  return String(first?.id || first?.alias_id || first?.aliasId || "");
}

/** 取用户身份与别名列表（授权完成后用它填账号）。 */
export async function getIdentity() {
  const me = await apiCall("/v1/me", { token: await token() });
  const list = me?.aliases || me?.result?.aliases || me?.data?.aliases || [];
  const aliases = (Array.isArray(list) ? list : []).map((a) => {
    if (typeof a === "string") return { id: a, email: a };
    return {
      id: String(a?.id || a?.alias_id || a?.aliasId || ""),
      email: String(a?.email || a?.address || a?.name || ""),
    };
  });
  return { aliases, raw: me };
}

// ── 列表 / 搜索 / 读取 ──────────────────────────────────

function normMsg(m) {
  if (!m || typeof m !== "object") return m;
  const from = m.from?.email || m.from?.address || m.from || m.sender?.email || m.sender || "";
  return {
    id: String(m.id || m.message_id || m.messageId || ""),
    from: typeof from === "string" ? from : JSON.stringify(from),
    subject: m.subject || "(无主题)",
    date: m.date || m.created_at || m.received_at || "",
    size: Number(m.size || 0) || undefined,
    read: m.read ?? m.is_read ?? m.seen ?? false,
    snippet: m.snippet || m.excerpt || "",
    hasAttachments: !!(m.has_attachments ?? m.hasAttachments ?? (Array.isArray(m.attachments) && m.attachments.length)),
  };
}

export async function listMessages(options = {}) {
  const { limit = 20, unread } = options;
  const a = await aliasId();
  const qs = new URLSearchParams({ limit: String(limit) });
  if (unread) qs.set("unread", "true");
  const d = await apiCall(`/v1/aliases/${encodeURIComponent(a)}/messages?${qs}`, { token: await token() });
  const list = d?.messages || d?.result?.messages || d?.data?.messages || [];
  return (Array.isArray(list) ? list : []).map(normMsg);
}

export async function searchMessages(keyword, options = {}) {
  const { limit = 20, unread } = options;
  const a = await aliasId();
  const qs = new URLSearchParams({ limit: String(limit), q: String(keyword || "") });
  if (unread) qs.set("unread", "true");
  const d = await apiCall(`/v1/aliases/${encodeURIComponent(a)}/messages/search?${qs}`, { token: await token() });
  const list = d?.messages || d?.result?.messages || d?.data?.messages || [];
  return (Array.isArray(list) ? list : []).map(normMsg);
}

export async function readMessage(messageId) {
  const a = await aliasId();
  const d = await apiCall(`/v1/aliases/${encodeURIComponent(a)}/messages/${encodeURIComponent(messageId)}`, { token: await token() });
  const m = d?.message || d?.result?.message || d?.data || d;
  const out = normMsg(m);
  // 正文兼容多种字段名
  out.body = m?.body || m?.text || m?.content || "";
  out.html = m?.html || (m?.body_format === "HTML" ? m?.body : "");
  out.to = m?.to || m?.recipients || "";
  out.attachments = (m?.attachments || []).map((att) => ({
    id: String(att.id || att.attachment_id || att.attachmentId || ""),
    filename: att.filename || att.name || "",
    contentType: att.content_type || att.contentType || "",
    size: Number(att.size || 0) || undefined,
  }));
  return out;
}

export async function downloadAttachment(messageId, attId, outputDir) {
  const a = await aliasId();
  const url = `/v1/aliases/${encodeURIComponent(a)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attId)}`;
  const tk = await token();
  const res = await fetch(`https://api.agent.qq.com${url}`, {
    headers: { authorization: `Bearer ${tk}`, "user-agent": "agently-cli/1.0.18" },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`下载附件失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const filename = decodeURIComponent((res.headers.get("content-disposition") || "").match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] || attId);
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, filename);
  fs.writeFileSync(outPath, buf);
  return { filename, size: buf.length, contentType: res.headers.get("content-type") || "", outputPath: outPath };
}

export async function uploadAttachment(filePath) {
  // AgentQQ 的附件走发送请求内联（multipart），没有独立的上传端点。
  // 这里只校验文件存在，真正的上传在 sendMail 里完成。
  if (!fs.existsSync(filePath)) throw new Error(`附件不存在：${filePath}`);
  return { path: filePath, filename: path.basename(filePath) };
}

// ── 发送 / 回复 / 转发 ──────────────────────────────────

function recipients(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  return arr.filter(Boolean).map((e) => ({ email: String(e).trim() }));
}

export async function sendMail(options) {
  const { to, cc, bcc, subject, body, html = false, attachments = [] } = options;
  if (!to || (Array.isArray(to) && !to.length)) throw new Error("sendMail: 'to' 必填");
  if (!subject) throw new Error("sendMail: 'subject' 必填");
  if (!body) throw new Error("sendMail: 'body' 必填");

  const a = await aliasId();
  const payload = {
    body,
    body_format: html ? "HTML" : "PLAIN",
    subject,
    to: recipients(to),
  };
  if (cc) payload.cc = recipients(cc);
  if (bcc) payload.bcc = recipients(bcc);
  if (attachments.length) {
    payload.attachments = attachments.map((x) => ({ filename: x.filename || path.basename(x.path || ""), path: x.path }));
  }

  const d = await apiCall(`/v1/aliases/${encodeURIComponent(a)}/messages/send`, {
    token: await token(), method: "POST", body: payload,
  });
  return d?.message || d?.result || d;
}

export async function replyToMail(messageId, options) {
  const { body, html = false, toAll = false, cc, attachments = [] } = options;
  if (!body) throw new Error("replyToMail: 'body' 必填");
  const a = await aliasId();
  const payload = { body, body_format: html ? "HTML" : "PLAIN", reply_all: !!toAll };
  if (cc) payload.cc = recipients(cc);
  if (attachments.length) payload.attachments = attachments.map((x) => ({ filename: x.filename || path.basename(x.path || ""), path: x.path }));
  const d = await apiCall(`/v1/aliases/${encodeURIComponent(a)}/messages/${encodeURIComponent(messageId)}/reply`, {
    token: await token(), method: "POST", body: payload,
  });
  return d?.message || d?.result || d;
}

export async function forwardMail(messageId, options) {
  const { to, body, includeAttachments = false } = options;
  const a = await aliasId();
  const payload = { include_attachments: !!includeAttachments, to: recipients(to) };
  if (body) { payload.body = body; payload.body_format = "PLAIN"; }
  const d = await apiCall(`/v1/aliases/${encodeURIComponent(a)}/messages/${encodeURIComponent(messageId)}/forward`, {
    token: await token(), method: "POST", body: payload,
  });
  return d?.message || d?.result || d;
}

// ── 文件夹 / 标记 / 删除 ────────────────────────────────

/**
 * AgentQQ 没有文件夹概念，只有"收件箱 + 垃圾箱"。
 * 返回固定的两条，前端列表才能正常工作。
 */
export async function listFolders() {
  return [
    { id: "INBOX", name: "收件箱", unread: 0 },
    { id: "TRASH", name: "垃圾箱", unread: 0 },
  ];
}

export async function markRead(messageId, read = true) {
  // AgentQQ 没有单独的标记接口；读取时本来就带 read 状态。
  return { ok: true, id: messageId, read: !!read, note: "AgentQQ 不提供独立标记接口" };
}

/** 移入垃圾箱（保留 30 天）。 */
export async function moveMessage(messageId) {
  const a = await aliasId();
  await apiCall(`/v1/aliases/${encodeURIComponent(a)}/messages/${encodeURIComponent(messageId)}`, {
    token: await token(), method: "DELETE",
  });
  return { ok: true, id: messageId, movedToTrash: true };
}

/** 彻底删除（清空回收站存储，不可逆）。 */
export async function deleteMessage(messageId) {
  const a = await aliasId();
  await apiCall(`/v1/aliases/${encodeURIComponent(a)}/messages/${encodeURIComponent(messageId)}/permanent`, {
    token: await token(), method: "DELETE",
  });
  return { ok: true, id: messageId, permanent: true };
}

export async function markSpam(messageId) {
  // AgentQQ 无独立垃圾标记，退化为移入垃圾箱
  return await moveMessage(messageId);
}

export function shutdown() {
  _tokens = null;
  _refreshing = null;
}
