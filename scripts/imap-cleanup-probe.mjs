/**
 * scripts/imap-cleanup-probe.mjs — 清掉回归探针在真实邮箱里留下的测试邮件
 *
 * 判据故意收得很紧（**两条同时满足**才算）：
 *   1. 发件人包含账号自己的地址 —— 所有测试邮件都是自己发给自己的
 *   2. 主题命中测试标记：`probe-` / `watcher-test` / `wprobe` / `idleprobe`
 * 只在“自己发给自己 + 主题带标记”时命中，正常邮件不可能同时满足。
 *
 * 默认只列出（dry-run）；加 `--apply` 才真的删。
 *
 * 顺序有讲究：INBOX / Junk / Drafts 里的删除是“移进垃圾箱”，
 * 所以先把它们删成 Trash，最后统一在 Trash 里永久删 —— 否则会留在 Trash 里。
 *
 * 用法：
 *   node scripts/imap-cleanup-probe.mjs --account=env
 *   node scripts/imap-cleanup-probe.mjs --account=env --apply
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPLY = process.argv.includes("--apply");

const imapHost = process.env.IMAP_HOST;
const imapUser = process.env.IMAP_USER;
const imapPass = process.env.IMAP_PASS;
if (!imapHost || !imapUser || !imapPass) {
  console.log("FAIL  缺少凭据（IMAP_HOST / IMAP_USER / IMAP_PASS）");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-cleanup-"));
process.env.HANAKO_PLUGIN_DATA = dir;
const email = imapUser;
const { listMessages, listFolders, deleteMessage, closeAll } =
  await import(`file://${path.join(process.cwd(), "backend", "imapflow-client.mjs").replace(/\\/g, "/")}`);

const MARKERS = ["probe-", "watcher-test", "wprobe", "idleprobe"];
const isTestMail = (m) => {
  const subj = String(m.subject || "");
  const from = String(m.from || "");
  return MARKERS.some((k) => subj.includes(k)) && from.includes(email);
};

const folders = await listFolders(email);
const byType = (t) => (folders.find((f) => f.type === t) || {}).id || null;
// 先处理“非垃圾箱”，最后处理垃圾箱（因为在非垃圾箱里删除只是移进垃圾箱）
const workFolders = [
  "INBOX",
  byType("sent"),
  byType("drafts"),
  byType("spam"),
].filter(Boolean);
const trash = byType("trash");

console.log(`账号: ${email}`);
console.log(`模式: ${APPLY ? "★ 实际删除" : "仅列出（dry-run）"}`);
console.log(`将扫描: ${workFolders.join(" / ")}${trash ? " → 最后 " + trash : ""}`);
console.log("");

let total = 0;
const targets = [];

for (const folder of workFolders) {
  let list = [];
  try {
    list = await listMessages(email, { folder, limit: 100 });
  } catch (e) {
    console.log(`  [${folder}] 读取失败: ${e.message}`);
    continue;
  }
  const hits = (Array.isArray(list) ? list : []).filter(isTestMail);
  console.log(`  [${folder}] 共 ${(list || []).length} 封，命中 ${hits.length} 封`);
  for (const m of hits) {
    console.log(`      ${m.id.padStart(6)}  ${String(m.subject).slice(0, 60)}`);
    targets.push({ folder, uid: m.id, subject: String(m.subject).slice(0, 60) });
    total++;
  }
}

// 垃圾箱最后扫
if (trash) {
  try {
    const list = await listMessages(email, { folder: trash, limit: 200 });
    const hits = (Array.isArray(list) ? list : []).filter(isTestMail);
    console.log(`  [${trash}] 共 ${(list || []).length} 封，命中 ${hits.length} 封`);
    for (const m of hits) {
      console.log(`      ${m.id.padStart(6)}  ${String(m.subject).slice(0, 60)}`);
      targets.push({ folder: trash, uid: m.id, subject: String(m.subject).slice(0, 60), permanent: true });
      total++;
    }
  } catch (e) {
    console.log(`  [${trash}] 读取失败: ${e.message}`);
  }
}

console.log("");
console.log(`合计命中 ${total} 封。`);

if (!APPLY) {
  console.log("（dry-run：没有删除任何东西。加 --apply 才真删。）");
} else if (total === 0) {
  console.log("没有需要删的。");
} else {
  // 第一遍：非垃圾箱里的删掉（= 移进垃圾箱）
  for (const t of targets.filter((x) => !x.permanent)) {
    try { await deleteMessage(email, t.uid, { folder: t.folder }); } catch (e) { console.log(`  删除失败 ${t.folder}/${t.uid}: ${e.message}`); }
  }
  await sleep(3000);
  // 第二遍：垃圾箱里按主题重新定位（UID 会因移动而变），永久删
  if (trash) {
    const after = await listMessages(email, { folder: trash, limit: 200 });
    const still = (Array.isArray(after) ? after : []).filter(isTestMail);
    console.log(`垃圾箱里待永久删: ${still.length} 封`);
    for (const m of still) {
      try { await deleteMessage(email, m.id, { folder: trash }); } catch (e) { console.log(`  永久删失败 ${m.id}: ${e.message}`); }
    }
    await sleep(2500);
    const final = await listMessages(email, { folder: trash, limit: 200 });
    const left = (Array.isArray(final) ? final : []).filter(isTestMail);
    console.log(`垃圾箱残留: ${left.length} 封`);
  }
}

try { closeAll(); } catch { /* ignore */ }
fs.rmSync(dir, { recursive: true, force: true });
