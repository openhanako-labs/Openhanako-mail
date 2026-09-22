/**
 * scripts/mail-e2e-probe.mjs — 端到端：发信 → 收信 → 读 → 删除
 *
 * 走 backend/imapflow-client.mjs 的公开 API，也就是 inbox.mjs 实际调的那一层。
 * 2026-09-22 迁移完成后，这条链路已全部是 imapflow 实现（含发信与存已发送副本）。
 *
 * ★ 安全约束（真邮箱）：只碰主题带唯一 tag 的邮件；每一步都按主题重新定位，
 *   绝不用从 A 文件夹取到的 UID 去 B 文件夹操作（MOVE 会重新分配 UID）。
 *   跑完把收件箱 / 已发送 / 已删除里的测试邮件都清掉。
 *
 * 用法：
 *   node scripts/mail-e2e-probe.mjs --account=env
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function ok(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
}

const email = process.env.IMAP_USER;
if (!process.env.IMAP_HOST || !email || !process.env.IMAP_PASS) {
  console.log("FAIL  缺少凭据（IMAP_HOST / IMAP_USER / IMAP_PASS）");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-e2e-"));
process.env.HANAKO_PLUGIN_DATA = dir;
const { listMessages, listFolders, readMessage, sendMail, deleteMessage, closeAll } =
  await import(`file://${path.join(process.cwd(), "backend", "imapflow-client.mjs").replace(/\\/g, "/")}`);

const tag = "e2e" + Math.random().toString(36).slice(2, 6);
const subject = `${tag} 端到端测试`;
const bodyText = `这是端到端探针的正文 ${tag}`;
console.log(`账号: ${email}`);
console.log(`tag: ${tag}`);
console.log("");

async function findIn(folder, needle, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const list = await listMessages(email, { folder, limit: 50 });
    const hit = (Array.isArray(list) ? list : []).find((m) => String(m.subject || "").includes(needle));
    if (hit) return hit;
    await sleep(3000);
  }
  return null;
}

// ── 1. 发信 ─────────────────────────────────────────────
let sent = null;
try {
  sent = await sendMail(email, { to: email, subject, body: bodyText });
  ok("sendMail 返回 messageId", Boolean(sent && sent.messageId), String(sent?.messageId || ""));
  ok("sendMail 报告收件人被接受", Array.isArray(sent?.accepted) ? sent.accepted.length > 0 : Boolean(sent?.accepted),
    JSON.stringify(sent?.accepted || ""));
} catch (e) {
  ok("sendMail 不抛异常", false, e.message);
}

// ── 2. 收信 ─────────────────────────────────────────────
const arrived = sent ? await findIn("INBOX", tag) : null;
ok("邮件到达收件箱", Boolean(arrived), arrived ? `uid=${arrived.id}` : "60 秒内未出现");

// ── 3. 读信 ─────────────────────────────────────────────
if (arrived) {
  const detail = await readMessage(email, arrived.id);
  ok("readMessage 主题正确", String(detail?.subject || "").includes(tag), String(detail?.subject || ""));
  const text = String(detail?.text || detail?.textContent || "");
  ok("readMessage 正文包含发出的内容", text.includes(tag), `${text.length} 字符`);
  ok("readMessage 能解析出发件人", Boolean(detail?.from), String(detail?.from || ""));
}

// ── 4. 已发送副本（appendToSent 那一跳） ────────────────
const folders = await listFolders(email);
const sentFolder = (folders.find((f) => f.type === "sent") || {}).id;
if (sentFolder && sent) {
  const copy = await findIn(sentFolder, tag, 8);
  ok("已发送文件夹里有副本（appendToSent 生效）", Boolean(copy), copy ? `${sentFolder} uid=${copy.id}` : `${sentFolder} 里 24 秒内未出现`);
}

// ── 5. 删除 ─────────────────────────────────────────────
if (arrived) {
  const r = await deleteMessage(email, arrived.id, { folder: "INBOX" });
  ok("deleteMessage 返回 movedToTrash（未挂死）", r && r.movedToTrash === true, JSON.stringify(r));
  await sleep(2500);
  const again = await listMessages(email, { folder: "INBOX", limit: 50 });
  ok("它已离开收件箱", !(again || []).some((m) => String(m.id) === String(arrived.id)));
}

// ── 6. 清理（全部按主题重新定位） ───────────────────────
let cleaned = 0;
for (const folder of [sentFolder].filter(Boolean)) {
  const m = await findIn(folder, tag, 3);
  if (m) { await deleteMessage(email, m.id, { folder }).catch(() => {}); cleaned++; }
}
const trash = (folders.find((f) => f.type === "trash") || {}).id;
if (trash) {
  await sleep(2500);
  for (let round = 0; round < 3; round++) {
    const m = await findIn(trash, tag, 2);
    if (!m) break;
    await deleteMessage(email, m.id, { folder: trash }).catch(() => {});
    cleaned++;
    await sleep(2000);
  }
}
console.log(`  （清理：动了 ${cleaned} 处）`);

try { closeAll(); } catch { /* ignore */ }
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nmail-e2e-probe: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
