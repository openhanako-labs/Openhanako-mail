/**
 * IMAP 后端 — 个人邮箱（QQ/Gmail/Outlook/自定义域名）
 *
 * 使用 imap 库读取邮件，nodemailer 发送邮件。
 * 支持 IMAP + SMTP 协议。
 *
 * 凭证来源：
 *   环境变量 IMAP_HOST / IMAP_PORT / IMAP_USER / IMAP_PASS / SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 *   由 routes/ui.js 从 accounts.json 的 account.config 透传。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Imap from "imap";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(__dirname, "data", "_imap_tmp");

// ── 解析 IMAP 配置 ────────────────────────────────────

function getImapConfig(email) {
  const config = {
    user: process.env.IMAP_USER || email,
    password: process.env.IMAP_PASS || "",
    host: process.env.IMAP_HOST || "",
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    tls: true,
    // 校验证书（原 rejectUnauthorized:false 会允许中间人截获邮箱凭据与全文，已移除）
  };

  // 域名自动推断
  if (!config.host) {
    const lower = email.toLowerCase();
    if (lower.endsWith("@qq.com") || lower.endsWith("@foxmail.com")) {
      config.host = "imap.qq.com";
      config.port = 993;
    } else if (lower.endsWith("@gmail.com")) {
      config.host = "imap.gmail.com";
      config.port = 993;
    } else if (lower.endsWith("@outlook.com") || lower.endsWith("@hotmail.com") || lower.endsWith("@live.com")) {
      config.host = "outlook.office365.com";
      config.port = 993;
    } else if (lower.endsWith("@163.com") || lower.endsWith("@126.com") || lower.endsWith("@yeah.net")) {
      config.host = "imap.163.com";
      config.port = 993;
    } else if (lower.endsWith("@sina.com")) {
      config.host = "imap.sina.com";
      config.port = 993;
    } else if (lower.endsWith("@sohu.com")) {
      config.host = "imap.sohu.com";
      config.port = 993;
    } else if (lower.endsWith("@aliyun.com")) {
      config.host = "imap.aliyun.com";
      config.port = 993;
    }
  }

  return config;
}

function getSmtpConfig(email) {
  const config = {
    host: process.env.SMTP_HOST || "",
    port: parseInt(process.env.SMTP_PORT || "465", 10),
    secure: true,
    auth: {
      user: process.env.SMTP_USER || email,
      pass: process.env.SMTP_PASS || process.env.IMAP_PASS || "",
    },
  };

  // 域名自动推断
  if (!config.host) {
    const lower = email.toLowerCase();
    if (lower.endsWith("@qq.com") || lower.endsWith("@foxmail.com")) {
      config.host = "smtp.qq.com";
      config.port = 465;
    } else if (lower.endsWith("@gmail.com")) {
      config.host = "smtp.gmail.com";
      config.port = 587;
      config.secure = false;
    } else if (lower.endsWith("@outlook.com") || lower.endsWith("@hotmail.com") || lower.endsWith("@live.com")) {
      config.host = "smtp.office365.com";
      config.port = 587;
      config.secure = false;
    } else if (lower.endsWith("@163.com") || lower.endsWith("@126.com") || lower.endsWith("@yeah.net")) {
      config.host = "smtp.163.com";
      config.port = 465;
    } else if (lower.endsWith("@sina.com")) {
      config.host = "smtp.sina.com";
      config.port = 465;
    } else if (lower.endsWith("@aliyun.com")) {
      config.host = "smtp.aliyun.com";
      config.port = 465;
    }
  }

  return config;
}

// ── IMAP 连接辅助 ─────────────────────────────────────

function connectImap(config) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(config);
    imap.once("ready", () => resolve(imap));
    imap.once("error", (err) => reject(err));
    imap.connect();
  });
}

function openBox(imap, boxName = "INBOX", readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox(boxName, readOnly, (err, box) => {
      if (err) return reject(err);
      resolve(box);
    });
  });
}

function searchMessages(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

function fetchMessages(imap, uids, options = { bodies: "" }) {
  return new Promise((resolve, reject) => {
    const f = imap.fetch(uids, options);
    const messages = [];
    f.on("message", (msg, seqno) => {
      let buffers = [];
      msg.on("body", (stream, info) => {
        stream.on("data", (chunk) => buffers.push(chunk));
        stream.on("end", () => {
          const raw = Buffer.concat(buffers);
          buffers = [];
          messages.push({ seqno, raw, uid: msg.uid });
        });
      });
      msg.on("attributes", (attrs) => {
        if (messages.length > 0) {
          messages[messages.length - 1].uid = attrs.uid;
          messages[messages.length - 1].flags = attrs.flags;
          messages[messages.length - 1].date = attrs.date;
        }
      });
    });
    f.once("error", (err) => reject(err));
    f.once("end", () => resolve(messages));
  });
}

async function parseMessages(rawMessages) {
  const results = [];
  for (const msg of rawMessages) {
    try {
      const parsed = await simpleParser(msg.raw);
      results.push({
        id: String(msg.uid || msg.seqno),
        uid: msg.uid,
        flags: msg.flags || [],
        date: parsed.date || msg.date,
        from: parsed.from ? parsed.from.text : "",
        to: parsed.to ? parsed.to.text : "",
        cc: parsed.cc ? parsed.cc.text : "",
        subject: parsed.subject || "",
        text: parsed.text || "",
        html: parsed.html ? { content: parsed.html } : null,
        attachments: (parsed.attachments || []).map((att, i) => ({
          id: String(i),
          filename: att.filename || `attachment_${i}`,
          contentType: att.contentType || "application/octet-stream",
          size: att.size || 0,
          partId: String(i),
        })),
        read: msg.flags ? !msg.flags.includes("\\Seen") : false,
      });
    } catch (e) {
      results.push({
        id: String(msg.uid || msg.seqno),
        error: `parse failed: ${e.message}`,
      });
    }
  }
  return results;
}

function closeImap(imap) {
  try { imap.end(); } catch {}
}

// ── 已发送副本保存 ─────────────────────────────────────

function findSentFolderName(boxes, delimiter) {
  if (!boxes || typeof boxes !== "object") return null;
  const delim = delimiter || "/";
  const candidates = ["sent", "已发送", "gesendet", "sent items", "envoyés", "enviados", "보낸메일"];
  function walk(obj, prefix) {
    for (const [name, box] of Object.entries(obj)) {
      const fullName = prefix ? `${prefix}${delim}${name}` : name;
      const lower = name.toLowerCase();
      if (candidates.includes(lower) || lower.includes("sent")) return fullName;
      if (box && box.children) {
        const found = walk(box.children, fullName);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(boxes, "");
}

function buildRawMessage(mailOptions) {
  return new Promise((resolve, reject) => {
    // nodemailer v9 起 mail-composer 改为 ESM 目录导入（lib/mail-composer/index.js），
    // 且为 default 导出。旧路径 lib/mail-composer 在 v9 不存在，故用动态导入规避
    // 「模块加载期静态 import 失败导致整个 IMAP 后端崩溃」的风险。
    import("nodemailer/lib/mail-composer/index.js")
      .then((mod) => {
        const MailComposer = mod.MailComposer || mod.default;
        if (typeof MailComposer !== "function") {
          return reject(new Error("MailComposer export not found"));
        }
        const mail = new MailComposer(mailOptions);
        mail.compile().build((err, message) => {
          if (err) return reject(err);
          resolve(message);
        });
      })
      .catch(reject);
  });
}

async function appendToSent(email, mailOptions) {
  let imap;
  try {
    const raw = await buildRawMessage(mailOptions);
    const config = getImapConfig(email);
    imap = await connectImap(config);
    const boxes = await new Promise((resolve, reject) => {
      imap.getBoxes((err, b) => (err ? reject(err) : resolve(b)));
    });
    const delim = imap.delimiter || config.delimiter || "/";
    const sentName = findSentFolderName(boxes, delim) || "Sent";
    await new Promise((resolve, reject) => {
      imap.append(raw, { mailbox: sentName, flags: ["\\Seen"] }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  } catch (e) {
    // 保存到「已发送」失败不应影响已发出的邮件，仅记录告警
    console.warn("[imap-backend] appendToSent failed:", e && e.message);
  } finally {
    if (imap) closeImap(imap);
  }
}

// ── 公开 API ──────────────────────────────────────────

export async function listMessages(email, options = {}) {
  const { limit = 20, folder = "INBOX" } = options;
  const config = getImapConfig(email);

  const imap = await connectImap(config);
  try {
    await openBox(imap, folder);
    const uids = await searchMessages(imap, ["ALL"]);
    const recent = uids.slice(Math.max(0, uids.length - Math.max(limit, 50)));
    const rawMessages = await fetchMessages(imap, recent);
    const parsed = await parseMessages(rawMessages);
    parsed.sort((a, b) => (b.date || 0) - (a.date || 0));
    return parsed.slice(0, limit);
  } finally {
    closeImap(imap);
  }
}

export async function readMessage(email, messageId, options = {}) {
  const config = getImapConfig(email);
  const imap = await connectImap(config);
  try {
    await openBox(imap, options.folder || "INBOX");
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);
    const rawMessages = await fetchMessages(imap, [uid], { bodies: "" });
    if (rawMessages.length === 0) throw new Error("message not found");
    const parsed = await parseMessages(rawMessages);
    return parsed[0] || { error: "message not found" };
  } finally {
    closeImap(imap);
  }
}

export async function deleteMessage(email, messageId, options = {}) {
  const config = getImapConfig(email);
  const folder = options.folder || "INBOX";
  const imap = await connectImap(config);
  try {
    // 两步删除：在垃圾箱内删除 = 永久删；其它文件夹删除 = 移到垃圾箱
    const isTrash = await isTrashFolder(email, folder);
    if (!isTrash) {
      const trash = await findTrashFolder(email);
      if (trash) {
        await moveMessage(email, messageId, trash.id, folder);
        return { deleted: false, movedToTrash: true, targetFid: trash.id };
      }
    }
    // 永久删除（已在垃圾箱，或账号无垃圾箱文件夹时）
    // 必须可写打开 box，否则 addFlags \Deleted 会被 IMAP 服务器拒绝
    await openBox(imap, folder, false);
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);
    await new Promise((resolve, reject) => {
      imap.addFlags(uid, "\\Deleted", (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve, reject) => {
      imap.expunge((err) => (err ? reject(err) : resolve()));
    });
    return { deleted: true, uid };
  } finally {
    closeImap(imap);
  }
}

async function isTrashFolder(email, folderName) {
  const folders = await listFolders(email);
  const f = folders.find((x) => x.id === folderName || x.name === folderName);
  return !!(f && (f.type === "trash" || /trash|deleted|垃圾箱|废纸|已删除/.test(String(f.name || "").toLowerCase())));
}

async function findTrashFolder(email) {
  const folders = await listFolders(email);
  return folders.find((f) => f.type === "trash")
    || folders.find((f) => /trash|deleted|垃圾箱|废纸|已删除/.test(String(f.name || f.id || "").toLowerCase()));
}

export async function sendMail(email, options) {
  const { to, cc, bcc, subject, body, html = false, attachments = [] } = options;
  if (!to) throw new Error("sendMail: 'to' is required");
  if (!subject) throw new Error("sendMail: 'subject' is required");
  if (!body) throw new Error("sendMail: 'body' is required");

  const smtpConfig = getSmtpConfig(email);
  const transporter = nodemailer.createTransport(smtpConfig);

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

  const info = await transporter.sendMail(mailOptions);
  transporter.close();

  // 保存副本到「已发送」文件夹（失败不影响已发送动作）
  await appendToSent(email, mailOptions);

  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

export async function replyToMail(email, messageId, options = {}) {
  const original = await readMessage(email, messageId);
  if (!original || original.error) throw new Error(`reply: original message not found (${messageId})`);

  const { body, html = false, cc, attachments = [] } = options;
  if (!body) throw new Error("replyToMail: 'body' is required");

  const smtpConfig = getSmtpConfig(email);
  const transporter = nodemailer.createTransport(smtpConfig);

  const mailOptions = {
    from: email,
    to: original.from,
    subject: original.subject ? `Re: ${original.subject}` : "Re:",
    [html ? "html" : "text"]: body,
    inReplyTo: messageId,
    references: messageId,
  };
  if (cc) mailOptions.cc = Array.isArray(cc) ? cc.join(", ") : cc;
  if (attachments && attachments.length) {
    mailOptions.attachments = attachments.map((a) => ({
      filename: a.filename || path.basename(a.path || "attachment"),
      path: a.path,
      contentType: a.contentType,
    }));
  }

  const info = await transporter.sendMail(mailOptions);
  transporter.close();

  // 保存副本到「已发送」文件夹（失败不影响已发送动作）
  await appendToSent(email, mailOptions);

  return { messageId: info.messageId };
}

export async function downloadAttachment(email, messageId, partId, outputDir, folder) {
  if (!outputDir) throw new Error("downloadAttachment: 'outputDir' is required");
  const config = getImapConfig(email);
  const imap = await connectImap(config);
  try {
    await openBox(imap, folder || "INBOX");
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);

    const rawMessages = await fetchMessages(imap, [uid], { bodies: "" });
    if (rawMessages.length === 0) throw new Error("message not found");

    const parsed = await parseMessages(rawMessages);
    const message = parsed[0];
    if (!message || message.error) throw new Error(`parse failed: ${message?.error || "unknown"}`);

    const idx = parseInt(partId, 10);
    if (isNaN(idx) || idx < 0 || idx >= message.attachments.length) {
      throw new Error(`attachment not found: ${partId}`);
    }

    const full = await simpleParser(rawMessages[0].raw);
    const att = full.attachments[idx];
    if (!att) throw new Error(`attachment not found: ${partId}`);

    await fs.mkdir(outputDir, { recursive: true });
    const safeName = path.basename(att.filename || `attachment_${idx}`);
    const outPath = path.join(outputDir, safeName);
    await fs.writeFile(outPath, att.content);

    return {
      filename: safeName,
      contentType: att.contentType || "application/octet-stream",
      size: att.size || att.content.length,
      path: outPath,
    };
  } finally {
    closeImap(imap);
  }
}

export async function forwardMail(email, messageId, options = {}) {
  const { to, subject, body, html = false, includeOriginal = true, cc, bcc, attachments = [] } = options;
  if (!to) throw new Error("forwardMail: 'to' is required");

  const original = await readMessage(email, messageId);
  if (!original || original.error) throw new Error(`forward: original message not found (${messageId})`);

  const smtpConfig = getSmtpConfig(email);
  const transporter = nodemailer.createTransport(smtpConfig);

  const finalSubject = subject || (original.subject ? `Fwd: ${original.subject}` : "Fwd:");

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

  const mailOptions = {
    from: email,
    to: Array.isArray(to) ? to.join(", ") : to,
    subject: finalSubject,
    [html ? "html" : "text"]: forwardBody,
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

  const info = await transporter.sendMail(mailOptions);
  transporter.close();

  // 保存副本到「已发送」文件夹（失败不影响已发送动作）
  await appendToSent(email, mailOptions);

  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

export async function listFolders(email) {
  const config = getImapConfig(email);
  const imap = await connectImap(config);
  try {
    const boxList = await new Promise((resolve, reject) => {
      imap.getBoxes((err, boxes) => {
        if (err) return reject(err);
        const result = [];
        function walk(obj, prefix) {
          for (const [name, box] of Object.entries(obj)) {
            const fullName = prefix ? `${prefix}${imap.delimiter}${name}` : name;
            result.push({
              id: fullName,
              name: fullName,
              path: fullName,
              type: mapType(name),
              unreadCount: 0,
              totalCount: 0,
            });
            if (box.children) walk(box.children, fullName);
          }
        }
        walk(boxes, "");
        resolve(result);
      });
    });
    return boxList;
  } finally {
    closeImap(imap);
  }
}

function mapType(name) {
  const n = name.toLowerCase();
  if (n.includes("inbox") || n === "收件箱") return "inbox";
  if (n.includes("sent") || n.includes("已发送")) return "sent";
  if (n.includes("draft") || n.includes("草稿")) return "drafts";
  if (n.includes("trash") || n.includes("已删除")) return "trash";
  if (n.includes("spam") || n.includes("垃圾")) return "spam";
  return "custom";
}

export async function markRead(email, messageId, read = true, folder) {
  const config = getImapConfig(email);
  const imap = await connectImap(config);
  try {
    // 修改 flags 需要可写打开
    await openBox(imap, folder || "INBOX", false);
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);
    await new Promise((resolve, reject) => {
      if (read) {
        imap.addFlags(uid, "\\Seen", (err) => err ? reject(err) : resolve());
      } else {
        imap.delFlags(uid, "\\Seen", (err) => err ? reject(err) : resolve());
      }
    });
    return { status: read ? "read" : "unread" };
  } finally {
    closeImap(imap);
  }
}

export async function markSpam(email, messageId, options = {}) {
  const folders = await listFolders(email);
  const spam = folders.find(f => f.type === "spam")
    || folders.find(f => /spam|junk|垃圾/.test(String(f.name || f.id || "").toLowerCase()));
  if (!spam) throw new Error("未找到垃圾邮件文件夹");
  return await moveMessage(email, messageId, spam.id, options.folder);
}

export async function moveMessage(email, messageId, targetFid, sourceFolder) {
  const config = getImapConfig(email);
  const imap = await connectImap(config);
  try {
    // 打开"源文件夹"（消息当前所在位置），而非固定 INBOX —— 否则非 INBOX 邮件无法定位 UID，两步删除/标记垃圾会失败
    const srcFolder = sourceFolder || "INBOX";
    // 可写打开：MOVE 不可用时的 COPY+DELETE 回退需要修改源邮件 flags
    await openBox(imap, srcFolder, false);
    const uid = parseInt(messageId, 10);
    if (isNaN(uid)) throw new Error(`invalid messageId: ${messageId}`);

    // 尝试使用 IMAP MOVE 命令（RFC 6851）
    await new Promise((resolve, reject) => {
      imap.move(uid, targetFid, (err) => {
        if (err) {
          // MOVE 不支持时 fallback 到 COPY + DELETE（修复：此前误用 delFlags \Seen
          // 导致原件未被删除、邮件在两端各留一份；正确做法是 \Deleted + expunge）
          imap.copy(uid, targetFid, (copyErr) => {
            if (copyErr) return reject(copyErr);
            imap.addFlags(uid, "\\Deleted", (delErr) => {
              if (delErr) return reject(delErr);
              imap.expunge((expErr) => (expErr ? reject(expErr) : resolve()));
            });
          });
        } else {
          resolve();
        }
      });
    });

    return { status: "moved", targetFid };
  } finally {
    closeImap(imap);
  }
}