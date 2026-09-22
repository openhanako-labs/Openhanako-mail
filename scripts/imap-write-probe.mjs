/**
 * scripts/imap-write-probe.mjs — IMAP 写操作回归探针（移动/删除/标垃圾/草稿/附件）
 *
 * 为什么有这个东西：
 *   读路径有 imap-probe.mjs，实时监听有 imap-idle-probe.mjs，而写操作一个都没验过。
 *   而且旧实现里读出一个死锁：deleteMessage 内部又调 listFolders，
 *   而连接池不可重入 → 请求永久挂住、该账号后续所有 IMAP 操作排队等死。
 *   这种事只能真机跑一遍才知道。
 *
 * ★★ 两条安全约束（这是真邮箱，不是测试服务器）：
 *   1. 只对自己发出的、主题带唯一 tag 的测试邮件动手 —— 绝不按“第一封/最后一封”取信。
 *   2. **绝不用从 A 文件夹取到的 UID 去 B 文件夹操作。**
 *      IMAP 的 MOVE 会给邮件在目标文件夹里分配**全新的 UID**（服务器用 COPYUID 告知）。
 *      第一版探针正是拿旧 UID 去 Trash 里删，结果可能删掉了 Trash 里
 *      恰好是同一个 UID 的**另一封邮件**。现在每一步都在目标文件夹里按主题重新定位。
 *
 * 用法：
 *   node scripts/imap-write-probe.mjs --account=env
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireFromBackend = createRequire(pathToFileURL(path.join(process.cwd(), "backend", "package.json")).href);
const nodemailer = requireFromBackend("nodemailer");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function ok(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
}

const imapHost = process.env.IMAP_HOST;
const imapUser = process.env.IMAP_USER;
const imapPass = process.env.IMAP_PASS;
if (!imapHost || !imapUser || !imapPass) {
  console.log("FAIL  缺少凭据（IMAP_HOST / IMAP_USER / IMAP_PASS）");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-write-probe-"));
process.env.HANAKO_PLUGIN_DATA = dir;
const email = imapUser;
const { listMessages, listFolders, moveMessage, deleteMessage, markSpam, saveDraft, downloadAttachment, closeAll } =
  await import(`file://${path.join(process.cwd(), "backend", "imapflow-client.mjs").replace(/\\/g, "/")}`);

const smtp = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.qq.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: process.env.SMTP_SECURE !== "false",
  auth: { user: imapUser, pass: imapPass },
});

const tag = "wprobe" + Math.random().toString(36).slice(2, 6);
console.log(`探针账号: ${email}`);
console.log(`tag: ${tag}`);
console.log("");

/** 在指定文件夹里按主题片段定位（返回整条记录，含该文件夹里的 UID） */
async function findTagged(folder, needle, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const list = await listMessages(email, { folder, limit: 50 });
    const hit = (Array.isArray(list) ? list : []).find((m) => String(m.subject || "").includes(needle));
    if (hit) return hit;
    await sleep(3000);
  }
  return null;
}

const folders = await listFolders(email);
const pick = (t) => (folders.find((f) => f.type === t) || {}).id || null;
const INBOX = "INBOX";
const TRASH = pick("trash");
const JUNK = pick("spam");
const DRAFTS = pick("drafts");
console.log(`文件夹: INBOX / trash=${TRASH} / spam=${JUNK} / drafts=${DRAFTS}`);
ok("能解析出 trash / spam / drafts 三个特殊文件夹", Boolean(TRASH && JUNK && DRAFTS));
console.log("");

/** 定位到就删掉（在**它现在所在的文件夹**里按主题重定位） */
async function cleanupIn(folder, needle) {
  const m = await findTagged(folder, needle, 3);
  if (!m) return false;
  await deleteMessage(email, m.id, { folder }).catch(() => {});
  return true;
}

// ── 1. 附件下载 ─────────────────────────────────────────
const attName = "probe-attachment.txt";
const attBody = "attachment-" + tag + "-content";
await smtp.sendMail({
  from: imapUser, to: imapUser, subject: `${tag}-att`, text: "see attachment",
  attachments: [{ filename: attName, content: attBody }],
});
const mail1 = await findTagged(INBOX, `${tag}-att`);
ok("测试邮件（带附件）已到达", Boolean(mail1), mail1 ? `uid=${mail1.id}` : "60 秒内未出现");

if (mail1) {
  const dl = await downloadAttachment(email, mail1.id, 0, path.join(dir, "att"), INBOX);
  const got = fs.readFileSync(dl.path, "utf-8");
  ok("downloadAttachment 内容与发出的一致", got === attBody, `收到 "${got.slice(0, 22)}"`);
  ok("附件文件名保留", dl.filename === attName, dl.filename);
}

// ── 2. 移动：INBOX → Trash（并按主题在 Trash 里重新定位） ──
let inTrash = null;
if (mail1) {
  const t0 = Date.now();
  await moveMessage(email, mail1.id, TRASH, INBOX);
  const moveMs = Date.now() - t0;
  await sleep(1500);

  const inboxNow = await listMessages(email, { folder: INBOX, limit: 30 });
  ok("moveMessage 后它已离开 INBOX",
    !(inboxNow || []).some((m) => String(m.id) === String(mail1.id)), `${moveMs}ms`);

  inTrash = await findTagged(TRASH, `${tag}-att`, 8);
  ok("moveMessage 后它出现在 Trash（按主题找到）", Boolean(inTrash), inTrash ? `新 uid=${inTrash.id}` : "24 秒内不可见");
  if (inTrash) {
    ok("★ 移动后 UID 被服务器重新分配（所以不能用旧 UID 跨文件夹操作）",
      String(inTrash.id) !== String(mail1.id), `INBOX ${mail1.id} → Trash ${inTrash.id}`);
  }
}

// ── 3. 在 Trash 里永久删除（用 Trash 里的新 UID） ────────
if (inTrash) {
  const r = await deleteMessage(email, inTrash.id, { folder: TRASH });
  ok("在 Trash 里删除 = 永久删（deleted:true）", r && r.deleted === true, JSON.stringify(r));
  await sleep(2500);
  const stillThere = await findTagged(TRASH, `${tag}-att`, 2);
  ok("永久删后按主题也找不到了", !stillThere);
}

// ── 4. 从 INBOX 删除 → 应移进 Trash（旧实现会在这里死锁） ──
await smtp.sendMail({ from: imapUser, to: imapUser, subject: `${tag}-del`, text: "to delete" });
const mail2 = await findTagged(INBOX, `${tag}-del`);
ok("第二封测试邮件已到达", Boolean(mail2), mail2 ? `uid=${mail2.id}` : "");
if (mail2) {
  const t0 = Date.now();
  const r = await deleteMessage(email, mail2.id, { folder: INBOX });
  const ms = Date.now() - t0;
  ok("★ 从 INBOX 删除返回 movedToTrash（且没挂死）", r && r.movedToTrash === true, `${JSON.stringify(r)} ${ms}ms`);
  await sleep(2500);
  const inboxNow = await listMessages(email, { folder: INBOX, limit: 30 });
  ok("它已离开 INBOX", !(inboxNow || []).some((m) => String(m.id) === String(mail2.id)));
  // 清理：在 Trash 里按主题重定位再删
  await cleanupIn(TRASH, `${tag}-del`);
}

// ── 5. 标垃圾 → Junk ────────────────────────────────────
await smtp.sendMail({ from: imapUser, to: imapUser, subject: `${tag}-spam`, text: "spam test" });
const mail3 = await findTagged(INBOX, `${tag}-spam`);
ok("第三封测试邮件已到达", Boolean(mail3), mail3 ? `uid=${mail3.id}` : "");
if (mail3) {
  const r = await markSpam(email, mail3.id, { folder: INBOX });
  ok("markSpam 返回 moved 且指向 Junk", r && r.status === "moved" && r.targetFid === JUNK, JSON.stringify(r));
  const inJunk = await findTagged(JUNK, `${tag}-spam`, 8);
  ok("它出现在 Junk（按主题找到）", Boolean(inJunk), inJunk ? `新 uid=${inJunk.id}` : "24 秒内不可见");
  if (inJunk) await cleanupIn(JUNK, `${tag}-spam`);
}

// ── 6. 存草稿 → Drafts ──────────────────────────────────
const draftSubject = `${tag}-draft`;
const r = await saveDraft(email, { to: imapUser, subject: draftSubject, body: "draft body", html: false });
ok("saveDraft 报告已保存并给出文件夹", r && r.saved === true && Boolean(r.draftFolder), JSON.stringify(r));
ok("草稿落在解析出的 drafts 文件夹", r && r.draftFolder === DRAFTS, `得到 ${r?.draftFolder}`);
const theDraft = await findTagged(DRAFTS, draftSubject, 4);
ok("草稿能在 Drafts 里被列出", Boolean(theDraft), theDraft ? `uid=${theDraft.id}` : "");
if (theDraft) await cleanupIn(DRAFTS, draftSubject);

try { closeAll(); } catch { /* ignore */ }
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nimap-write-probe: ${failures} failure(s)`);
console.log(`（测试邮件已在流程内按主题清理；若仍有残留，主题都含 ${tag}）`);
process.exit(failures === 0 ? 0 : 1);
