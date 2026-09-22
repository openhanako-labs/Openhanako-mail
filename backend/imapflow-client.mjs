/**
 * imapflow-client.mjs — IMAP 后端的 imapflow 实现
 *
 * 为什么单独一个文件：迁移期要让新旧两套实现并存，以便随时回退 ——
 * 这台机器上**没有任何 IMAP 账号**（账号是 ClawEmail），所以这条路径无法手工验证，
 * 只能靠 scripts/imap-probe.mjs 用 Ethereal 开一个真实 IMAP 收件箱做回归。
 * 对照基准：`node scripts/imap-probe.mjs --mode=baseline` / `--mode=imapflow`。
 *
 * 迁移状态：**已完成**（2026-09-22）。原 `imap`（node-imap）实现已全部替换。
 * 覆盖：连接/连接池、openBox、listFolders、listMessages、readMessage、searchMessages、
 *       markRead、moveMessage、deleteMessage、markSpam、saveDraft、downloadAttachment、
 *       sendMail、replyToMail、forwardMail、appendToSent（SMTP + 已发送副本）。
 *
 * 不再依赖 imap-backend.mjs，也不再依赖 `imap` 包。
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { htmlToText } from "./common.mjs";
import nodemailer from "nodemailer";
import { getImapConfig, getSmtpConfig } from "./imap-config.mjs";

export { getImapConfig };

// CLI 传的是 `--fid=<路径>`（ui.js 一律这么发），而 IMAP 后端历史上只读 `options.folder`
// → 在 IMAP 账号上**选任何非 INBOX 的文件夹都会静默显示 INBOX 的内容**。
// 两个键都认（ClawEmail 那边 fid 是数字 id，IMAP 这边 fid 就是文件夹路径，语义都成立）。
const boxOf = (options = {}, fallback = "INBOX") => options.folder || options.fid || fallback;

// ── 连接 ────────────────────────────────────────────────

export async function connectImap(config) {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls !== false,
    auth: { user: config.user, pass: config.password },
    // 与旧实现一致：不关证书校验
    logger: false,
  });

  // ★ 必须挂 error 监听。imapflow 是 EventEmitter，未处理的 'error' 会按 Node 语义
  //   直接打崩服务进程。旧的 node-imap 路径正是这样崩过一次 ——
  //   一次「读单封邮件」的协议错误把整个服务带走了（2026-09-22 探针发现）。
  client.on("error", () => {});

  await client.connect();
  return client;
}

export async function openBox(client, boxName = "INBOX", readOnly = true) {
  return await client.mailboxOpen(boxName, { readOnly });
}

// ── 连接池 ──────────────────────────────────────────────
// 与旧实现同样的语义：每账号一条连接、同账号请求排队（避免命令交错）、
// 凭据变更重建、出错销毁、空闲回收。
// 注意：这是**命令连接**。实时监听会另开一条（见设计文档第六节：
// getMailboxLock 的独占语义与长期占用的监听会互相饿死）。

const CONN_POOL = new Map();
const IDLE_MS = 60000;

function poolEntry(email) {
  let e = CONN_POOL.get(email);
  if (!e) {
    e = { client: null, ok: false, busy: false, lastUsed: 0, password: "", queue: [] };
    CONN_POOL.set(email, e);
  }
  return e;
}

function destroyConn(entry) {
  if (entry && entry.client) {
    try {
      entry.client.close();
    } catch {
      /* 已经断了 */
    }
    entry.client = null;
    entry.ok = false;
  }
}

function release(entry) {
  entry.busy = false;
  const next = entry.queue.shift();
  if (next) next(); // 唤醒一个排队者重新走完整状态检查
}

function idleReap() {
  const now = Date.now();
  for (const [email, entry] of CONN_POOL) {
    if (!entry.busy && entry.client && now - entry.lastUsed > IDLE_MS) {
      destroyConn(entry);
      CONN_POOL.delete(email);
    }
  }
}

function withClient(email, fn) {
  return new Promise((resolve, reject) => {
    const entry = poolEntry(email);
    const config = getImapConfig(email);

    // 凭据变更 → 重建（账号编辑后自动生效）
    if (entry.client && entry.password && config.password !== entry.password) {
      destroyConn(entry);
    }

    if (entry.busy) {
      entry.queue.push(() => withClient(email, fn).then(resolve, reject));
      return;
    }
    entry.busy = true;
    idleReap();

    const run = (client) => {
      entry.client = client;
      entry.ok = true;
      entry.lastUsed = Date.now();
      entry.password = config.password;
      fn(client).then(
        (v) => {
          entry.lastUsed = Date.now();
          release(entry);
          resolve(v);
        },
        (err) => {
          // 出错即销毁（复用可能已损坏的会话），与旧实现一致
          destroyConn(entry);
          entry.lastUsed = Date.now();
          release(entry);
          reject(err);
        }
      );
    };

    if (entry.ok && entry.client) {
      run(entry.client);
      return;
    }

    if (!config.host) {
      release(entry);
      reject(new Error(`无法确定 IMAP 主机（${email}）：请在账号配置里填写 imapHost`));
      return;
    }

    connectImap(config).then(
      (client) => {
        client.on("close", () => {
          // 连接被服务器或网络掐断 → 标记失效，下次重建
          if (entry.client === client) {
            entry.client = null;
            entry.ok = false;
          }
        });
        run(client);
      },
      (err) => {
        release(entry);
        reject(err);
      }
    );
  });
}

export function closeAllImap() {
  for (const [, entry] of CONN_POOL) destroyConn(entry);
  CONN_POOL.clear();
}

export function closeAll() {
  closeAllImap();
  closeAllSmtp();
}

// ── 文件夹 ──────────────────────────────────────────────

// 词汇表必须与旧实现一致（markSpam 依赖 f.type === "spam"）：
// inbox | sent | drafts | trash | spam | custom
const SPECIAL_USE_TYPE = {
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "spam",
  "\\spam": "spam",
};

function nameType(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("inbox") || n === "收件箱") return "inbox";
  if (n.includes("sent") || n.includes("已发送")) return "sent";
  if (n.includes("draft") || n.includes("草稿")) return "drafts";
  if (n.includes("trash") || n.includes("已删除")) return "trash";
  if (n.includes("spam") || n.includes("垃圾")) return "spam";
  return "custom";
}

/**
 * imapflow 的 list() 直接给 specialUse（来源标在 specialUseSource）：
 * 服务器广告的 SPECIAL-USE/XLIST 最可信，其次是它自带的本地化文件夹名表，
 * 最后才是我们自己的名字启发式。旧实现只有最后这一层。
 */
function folderType(specialUse, name) {
  if (specialUse) {
    const t = SPECIAL_USE_TYPE[String(specialUse).toLowerCase()];
    if (t) return t;
  }
  return nameType(name);
}

// 纯函数：把 imapflow 的 list() 结果映射成插件的文件夹形状。
// 供 listFolders 与内部操作共用 —— 内部操作**不能**回头调 listFolders，
// 那会再取一次连接（连接池不可重入，见 findFolderPath 的注释）。
function mapBoxes(boxes) {
  return (Array.isArray(boxes) ? boxes : []).map((r) => ({
    id: r.path,
    name: r.path,
    path: r.path,
    type: folderType(r.specialUse, r.name || r.path),
    // 与旧实现一致：不额外发 STATUS 请求，计数留 0
    unreadCount: 0,
    totalCount: 0,
  }));
}

export async function listFolders(email) {
  return await withClient(email, async (client) => mapBoxes(await client.list()));
}

/**
 * 在**已持有的 client** 上找一个特殊用途文件夹。
 *
 * ⚠ 刻意接 client 而不是 email：连接池不可重入 —— 在 withClient 的回调里
 *   再调任何会 withClient 的公开函数（listFolders / moveMessage…），
 *   内层会排在外层持有的 busy 后面，而 busy 只在外层返回后才释放 →
 *   **永久挂住**。旧实现的 deleteMessage 正是这个形状
 *  （内部调 isTrashFolder → listFolders），后果不只是删不掉：
 *   那条连接永远卡在 busy，该账号后续**所有** IMAP 操作会排眍等死。
 */
async function findFolderPath(client, type, nameRe) {
  const boxes = mapBoxes(await client.list());
  const byType = boxes.find((f) => f.type === type);
  if (byType) return byType.id;
  const byName = boxes.find((f) => nameRe.test(String(f.name).toLowerCase()));
  return byName ? byName.id : null;
}

// 移动：imapflow 的 messageMove **只发 MOVE（RFC 6851），不做回退**，
// 所以不支持 MOVE 的服务器要自己补 COPY + \Deleted + EXPUNGE。
async function moveUid(client, uid, targetPath) {
  try {
    await client.messageMove(String(uid), targetPath, { uid: true });
  } catch {
    await client.messageCopy(String(uid), targetPath, { uid: true });
    await client.messageDelete(String(uid), { uid: true });
  }
}

// 把邮件选项编译成原始 RFC822（nodemailer 的 MailComposer）。
// 动态导入：nodemailer v9 起 mail-composer 变成 ESM 目录导入，
// 静态 import 失败会把整个后端带崩（旧实现里已注明）。
function buildRawMessage(mailOptions) {
  return new Promise((resolve, reject) => {
    import("nodemailer/lib/mail-composer/index.js")
      .then((mod) => {
        const MailComposer = mod.MailComposer || mod.default;
        if (typeof MailComposer !== "function") return reject(new Error("MailComposer export not found"));
        new MailComposer(mailOptions).compile().build((err, message) => (err ? reject(err) : resolve(message)));
      })
      .catch(reject);
  });
}

// ── 解析 ────────────────────────────────────────────────

async function parseOne(m) {
  try {
    const parsed = await simpleParser(m.source);
    const htmlStr = parsed.html ? (typeof parsed.html === "string" ? parsed.html : parsed.html.content || "") : "";
    const text = parsed.text && parsed.text.trim() ? parsed.text : htmlToText(htmlStr);
    return {
      id: String(m.uid),
      uid: m.uid,
      flags: m.flags ? [...m.flags] : [],
      date: parsed.date || null,
      from: parsed.from ? parsed.from.text : "",
      to: parsed.to ? parsed.to.text : "",
      cc: parsed.cc ? parsed.cc.text : "",
      subject: parsed.subject || "",
      text,
      html: parsed.html ? { content: htmlStr } : null,
      attachments: (parsed.attachments || []).map((att, i) => ({
        id: String(i),
        filename: att.filename || `attachment_${i}`,
        contentType: att.contentType || "application/octet-stream",
        size: att.size || 0,
        partId: String(i),
      })),
      // ⚠ 旧实现这里写的是 `!flags.includes("\\Seen")` —— 反了，
      // 已读邮件会报 read:false。这里按字段名的语义取正确值。
      // 需要在有 IMAP 账号时核对卡片上的已读/未读显示。
      read: m.flags ? m.flags.has("\\Seen") : false,
    };
  } catch {
    return null;
  }
}

const byDateDesc = (a, b) => new Date(b.date || 0) - new Date(a.date || 0);

// ── 公开 API（读取路径） ────────────────────────────────

export async function listMessages(email, options = {}) {
  const { limit = 20, unread } = options;
  const box = boxOf(options);
  return await withClient(email, async (client) => {
    await openBox(client, box, true);
    // ★ 必须显式要 UID：imapflow 的 search **默认返回的是序号**，不是 UID
    //   （SearchOptions.uid 的注释："If true then returns UID numbers instead of
    //    sequence numbers"）。之前没加这个选项，在 Ethereal 上“碰巧对”是因为
    //   那个收件箱新建、无删除，序号恰好等于 UID；一上 QQ（49 封而 UID 已到 1112）
    //   就暴露了：拿序号当 UID 去取，一封都取不到。
    const uids = await client.search(unread ? { seen: false } : { all: true }, { uid: true });
    if (!Array.isArray(uids) || !uids.length) return [];

    // 与旧实现一致：取最大的 max(limit,50) 个 UID。
    // （这里和 ClawEmail 那边同一个形状的浪费 —— limit=5 也会拉 50 封全文，
    //   迁移不夹带行为变更，留作后续单独优化。）
    const recent = uids.slice(Math.max(0, uids.length - Math.max(limit, 50)));
    const out = [];
    for await (const m of client.fetch(recent, { source: true, uid: true, flags: true }, { uid: true })) {
      const parsed = await parseOne(m);
      if (parsed) out.push(parsed);
    }
    out.sort(byDateDesc);
    return out.slice(0, limit);
  });
}

export async function readMessage(email, messageId, options = {}) {
  const box = boxOf(options);
  return await withClient(email, async (client) => {
    await openBox(client, box, true);
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);
    // { source: true } 就是整封 RFC822 原文（旧实现靠 `bodies: ""` → `BODY[]`）
    const m = await client.fetchOne(String(uid), { source: true, uid: true, flags: true }, { uid: true });
    if (!m) throw new Error("message not found");
    const parsed = await parseOne(m);
    if (!parsed) throw new Error("parse failed");
    return parsed;
  });
}

export async function searchMessages(email, keyword, options = {}) {
  const { limit = 20 } = options;
  const box = boxOf(options);
  const kw = String(keyword || "").trim();
  if (!kw) return [];
  return await withClient(email, async (client) => {
    await openBox(client, box, true);
    // 旧实现：OR(FROM kw, SUBJECT kw) —— 发件人/主题命中即返回
    // ★ { uid: true }：search 默认返回序号，不是 UID（同 listMessages 的注释）
    const uids = await client.search({ or: [{ from: kw }, { subject: kw }] }, { uid: true });
    if (!Array.isArray(uids) || !uids.length) return [];
    const recent = uids.slice(Math.max(0, uids.length - Math.max(limit, 50)));
    const out = [];
    for await (const m of client.fetch(recent, { source: true, uid: true, flags: true }, { uid: true })) {
      const parsed = await parseOne(m);
      if (parsed) out.push(parsed);
    }
    out.sort(byDateDesc);
    return out.slice(0, limit);
  });
}

export async function markRead(email, messageId, read = true, folder) {
  return await withClient(email, async (client) => {
    // 改 flag 需要可写打开（旧实现同样是 readOnly=false）
    await openBox(client, folder || "INBOX", false);
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);
    if (read) {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    } else {
      await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
    }
    return { status: read ? "read" : "unread" };
  });
}

// ── 发信三件套（已迁入本文件底部） ──────────────────
// 发信三件套已迁入本文件底部（SMTP 池 + appendToSent + send/reply/forward）。
// ── 写操作（已迁移） ──────────────────────────────────
// 这些没在 withClient 回调里再调任何会 withClient 的公开函数 ——
// 文件夹解析一律用接 client 的 findFolderPath（旧实现的 deleteMessage 就死在这里）。

export async function moveMessage(email, messageId, targetFid, sourceFolder) {
  return await withClient(email, async (client) => {
    // 打开「源文件夹」（消息当前所在位置），而非固定 INBOX
    await openBox(client, sourceFolder || "INBOX", false);
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);
    await moveUid(client, uid, targetFid);
    return { status: "moved", targetFid };
  });
}

export async function deleteMessage(email, messageId, options = {}) {
  const folder = boxOf(options);
  return await withClient(email, async (client) => {
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);

    // 两步删除：在垃圾箱内删 = 永久删；其它文件夹删 = 先移进垃圾箱
    const boxes = mapBoxes(await client.list());
    const cur = boxes.find((f) => f.id === folder);
    const trashByType = boxes.find((f) => f.type === "trash");
    const trashByName = boxes.find((f) => /trash|deleted|垃圾箱|废纸|已删除/.test(String(f.name).toLowerCase()));
    const trashPath = (trashByType || trashByName || {}).id || null;
    const inTrash = (cur && cur.type === "trash") || (!!trashPath && trashPath === folder);

    if (!inTrash && trashPath) {
      await openBox(client, folder, false);
      await moveUid(client, uid, trashPath);
      return { deleted: false, movedToTrash: true, targetFid: trashPath };
    }

    // 永久删除（已在垃圾箱，或账号没有垃圾箱文件夹）。
    // messageDelete 就是 \Deleted + EXPUNGE 两步。
    await openBox(client, folder, false);
    await client.messageDelete(String(uid), { uid: true });
    return { deleted: true, uid };
  });
}

export async function markSpam(email, messageId, options = {}) {
  return await withClient(email, async (client) => {
    const spamPath = await findFolderPath(client, "spam", /spam|junk|垃圾/);
    if (!spamPath) throw new Error("未找到垃圾邮件文件夹");
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);
    await openBox(client, boxOf(options), false);
    await moveUid(client, uid, spamPath);
    return { status: "moved", targetFid: spamPath };
  });
}

/**
 * 把当前写信内容作为草稿 append 到 DRAFTS 文件夹（\Draft 标记）。
 * 仅 IMAP 后端支持；ClawEmail / AgentQQ 由 inbox.mjs 统一拦截报错。
 */
export async function saveDraft(email, options = {}) {
  const { to, cc, bcc, subject, body, html = false, attachments = [] } = options;
  const mailOptions = {
    from: email,
    to: Array.isArray(to) ? to.join(", ") : to,
    subject: subject || "(无主题)",
    [html ? "html" : "text"]: body || "",
  };
  if (cc) mailOptions.cc = Array.isArray(cc) ? cc.join(", ") : cc;
  if (bcc) mailOptions.bcc = Array.isArray(bcc) ? bcc.join(", ") : bcc;
  if (attachments && attachments.length) {
    mailOptions.attachments = attachments.map((a) => ({
      filename: a.filename || path.basename(a.path || "attachment"),
      path: a.path,
      contentType: a.contentType,
    }));
  }
  const raw = await buildRawMessage(mailOptions);
  const draftFolder = await withClient(email, async (client) => {
    // 旧实现靠 5 项候选名递归猜；这里先用服务器标的 \Drafts，再退回名字匹配
    const name = (await findFolderPath(client, "drafts", /draft|草稿/)) || "Drafts";
    await client.append(name, raw, ["\\Draft"]);
    return name;
  });
  return { saved: true, draftFolder };
}

export async function downloadAttachment(email, messageId, partId, outputDir, folder) {
  if (!outputDir) throw new Error("downloadAttachment: 'outputDir' is required");
  return await withClient(email, async (client) => {
    await openBox(client, boxOf({ folder }), true);
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);

    const m = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
    if (!m) throw new Error("message not found");
    const full = await simpleParser(m.source);

    const idx = parseInt(partId, 10);
    if (isNaN(idx) || idx < 0 || idx >= (full.attachments || []).length) {
      throw new Error(`attachment not found: ${partId}`);
    }
    const att = full.attachments[idx];

    await fsp.mkdir(outputDir, { recursive: true });
    const safeName = path.basename(att.filename || `attachment_${idx}`);
    const outPath = path.join(outputDir, safeName);
    await fsp.writeFile(outPath, att.content);

    return {
      filename: safeName,
      contentType: att.contentType || "application/octet-stream",
      size: att.size || att.content.length,
      path: outPath,
    };
  });
}

// ── SMTP（发信） ──────────────────────────────────────
// 连接池与旧实现同语义：同账号复用连接，配置/凭据变更则重建。
const SMTP_POOL = new Map();

function getSmtpTransporter(email) {
  const cfg = getSmtpConfig(email);
  const existing = SMTP_POOL.get(email);
  if (existing) {
    const meta = existing._mailPool;
    if (meta && meta.host === cfg.host && meta.port === cfg.port && meta.secure === !!cfg.secure && meta.pass === cfg.auth.pass) {
      return existing.t;
    }
    try { existing.t.close(); } catch { /* 已关 */ }
    SMTP_POOL.delete(email);
  }
  const t = nodemailer.createTransport({ ...cfg, pool: true, maxConnections: 2, maxMessages: 200 });
  SMTP_POOL.set(email, { t, _mailPool: { host: cfg.host, port: cfg.port, secure: !!cfg.secure, pass: cfg.auth.pass } });
  return t;
}

export function closeAllSmtp() {
  for (const [, v] of SMTP_POOL) { try { v.t.close(); } catch { /* ignore */ } }
  SMTP_POOL.clear();
}

// 保存已发送副本。失败不能影响“已经发出去了”这件事，所以整体吞掉只记警告。
async function appendToSent(email, mailOptions) {
  try {
    const raw = await buildRawMessage(mailOptions);
    await withClient(email, async (client) => {
      // 旧实现靠 7 项候选名递归猜；这里先用服务器标的 \Sent，再退回名字匹配
      const name = (await findFolderPath(client, "sent", /sent|已发送/)) || "Sent";
      await client.append(name, raw, ["\\Seen"]);
    });
  } catch (e) {
    console.warn("[imapflow-client] appendToSent failed:", e && e.message);
  }
}

function toMailOptions(email, opts) {
  const { to, cc, bcc, subject, body, html = false, attachments = [] } = opts;
  const mailOptions = {
    from: email,
    to: Array.isArray(to) ? to.join(", ") : to,
    subject,
    [html ? "html" : "text"]: body,
  };
  if (cc) mailOptions.cc = Array.isArray(cc) ? cc.join(", ") : cc;
  if (bcc) mailOptions.bcc = Array.isArray(bcc) ? bcc.join(", ") : bcc;
  if (attachments && attachments.length) {
    mailOptions.attachments = attachments.map((a) => ({
      filename: a.filename || path.basename(a.path || "attachment"),
      path: a.path,
      contentType: a.contentType,
    }));
  }
  return mailOptions;
}

export async function sendMail(email, options = {}) {
  const { to, subject, body } = options;
  if (!to) throw new Error("sendMail: 'to' is required");
  if (!subject) throw new Error("sendMail: 'subject' is required");
  if (!body) throw new Error("sendMail: 'body' is required");

  const mailOptions = toMailOptions(email, { ...options, subject, body });
  const info = await getSmtpTransporter(email).sendMail(mailOptions);
  await appendToSent(email, mailOptions);
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

export async function replyToMail(email, messageId, options = {}) {
  const original = await readMessage(email, messageId);
  if (!original || original.error) throw new Error(`reply: original message not found (${messageId})`);

  const { body, html = false, cc, attachments = [] } = options;
  if (!body) throw new Error("replyToMail: 'body' is required");

  const mailOptions = toMailOptions(email, {
    ...options,
    to: original.from,
    subject: original.subject ? `Re: ${original.subject}` : "Re:",
    body,
    html,
    cc,
    attachments,
  });
  mailOptions.inReplyTo = messageId;
  mailOptions.references = messageId;

  const info = await getSmtpTransporter(email).sendMail(mailOptions);
  await appendToSent(email, mailOptions);
  return { messageId: info.messageId };
}

export async function forwardMail(email, messageId, options = {}) {
  const { to, subject, body, html = false, includeOriginal = true, cc, bcc, attachments = [] } = options;
  if (!to) throw new Error("forwardMail: 'to' is required");

  const original = await readMessage(email, messageId);
  if (!original || original.error) throw new Error(`forward: original message not found (${messageId})`);

  let forwardBody = body || "";
  if (includeOriginal) {
    const quoted = [
      "",
      "---------- 转发的邮件 ----------",
      `发件人: ${original.from || ""}`,
      `收件人: ${original.to || ""}`,
      `主题: ${original.subject || ""}`,
      "",
      original.text || "",
    ].join("\n");
    forwardBody = body ? `${body}\n${quoted}` : quoted;
  }

  const mailOptions = toMailOptions(email, {
    ...options,
    to,
    subject: subject || (original.subject ? `Fwd: ${original.subject}` : "Fwd:"),
    body: forwardBody,
    html,
    cc,
    bcc,
    attachments,
  });

  const info = await getSmtpTransporter(email).sendMail(mailOptions);
  await appendToSent(email, mailOptions);
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}
