/**
 * scripts/smoke-notify.mjs — 通知队列语义的回归测试。
 *
 * 为什么单独有它：`smoke-load.mjs` 那两条「通知检查」只验**文件存在**与
 * 「源码里出现过某个字符串」，不验行为；`smoke-bridge.mjs` 验到队列为止。
 * 于是「队列 → 弹窗」这一段长期无人验证，两个真 bug 就这么躺了两天：
 *
 *   1) 「取走即删」—— 读取一次就把队列删掉，而删除发生在 toast 被拉起之前，
 *      只要发送失败通知就永久消失（实测 09-20 / 09-21 两次）。
 *   2) 靠 SnoreToast 退出码判断送达 —— 实测它通知已弹出仍返回 -1。
 *
 * 本文件只管服务侧的队列语义（读不删 / 确认才删 / 去重 / 上限 / TTL），
 * 不弹窗、不需要 AppHost、不需要网络。
 *
 * 跑法：node scripts/smoke-notify.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mail-notify-"));
const dataDir = path.join(home, "app-data", "hanako-mail");
fs.mkdirSync(dataDir, { recursive: true });
const notifyDir = path.join(dataDir, "_pending_notify");

// 自己的端口，避开真实运行中的服务（默认 43179），否则 EADDRINUSE。
const PORT = Number(process.env.HANA_MAIL_NOTIFY_PORT) || 43185;
const MARKER = "HANA_MAIL_SERVICE_READY";

const proc = spawn(process.execPath, [path.join(ROOT, "runtime", "service.mjs"), dataDir, "", String(PORT)], {
  cwd: dataDir,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let probe = "";
proc.stdout.on("data", (d) => { probe += d.toString(); });
proc.stderr.on("data", (d) => { if (process.env.MAIL_DEBUG) process.stderr.write("[svc] " + d); });

const base = `http://127.0.0.1:${PORT}`;
async function call(route, body) {
  const res = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return await res.json();
}

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe.includes(MARKER)) return true;
    if (proc.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function countFiles() {
  try { return fs.readdirSync(notifyDir).filter((f) => f.endsWith(".json")).length; } catch { return 0; }
}

function cleanup() {
  try { proc.kill(); } catch { /* ignore */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 服务可能仍握着句柄 */ }
}

if (!(await waitReady())) {
  console.log("SKIP  服务未就绪（确认 runtime/service.mjs 能被单跑）");
  cleanup();
  process.exit(0);
}

// ── 1. 入队 → 可读 ──────────────────────────────────────────────
await call("/notify", { subject: "t1", sender: "s", messageId: "m1", accountId: "a" });
let r = await call("/pending-notify", { limit: 10 });
check("入队后能读到", r.ok && r.items?.length === 1 && r.items[0].subject === "t1", JSON.stringify(r).slice(0, 160));
check("返回项带 id（确认删除需要它）", typeof r.items?.[0]?.id === "string" && r.items[0].id.length > 0);

// ── 2. ★ 只读不删（最关键的回归点） ──────────────────────────────
r = await call("/pending-notify", { limit: 10 });
check("★ 只读不删：第二次读仍然在", r.ok && r.items?.length === 1, `items=${r.items?.length}`);
check("★ 磁盘上的文件也还在", countFiles() === 1, `files=${countFiles()}`);

// ── 3. 同一封邮件去重 ───────────────────────────────────────────
await call("/notify", { subject: "t1-dup", sender: "s", messageId: "m1", accountId: "a" });
r = await call("/pending-notify", { limit: 10 });
check("同 messageId 去重（IDLE 重连会重扫 UNSEEN）", r.items?.length === 1, `items=${r.items?.length}`);

// ── 4. ★ 确认之后才真删 ────────────────────────────────────────
await call("/notify-ack", { ids: [r.items[0].id] });
r = await call("/pending-notify", { limit: 10 });
check("★ /notify-ack 之后才消失", r.items?.length === 0 && countFiles() === 0, `items=${r.items?.length} files=${countFiles()}`);

// ── 5. ack 的路径穿越防护 ──────────────────────────────────────
await call("/notify", { subject: "t2", messageId: "m2" });
await call("/notify-ack", { ids: ["../../accounts", "..", "a/b", "notify-last-result"] });
r = await call("/pending-notify", { limit: 10 });
check("非法 id 被拒（不误删别的文件）", r.items?.length === 1, `items=${r.items?.length}`);

// ── 6. 上限：超出丢最旧，而不是拒新的 ────────────────────────────
for (let i = 0; i < 200; i++) {
  fs.writeFileSync(
    path.join(notifyDir, `seed${String(i).padStart(4, "0")}.json`),
    JSON.stringify({ subject: `seed${i}`, messageId: `seed${i}`, queuedAt: new Date().toISOString() }),
    "utf-8",
  );
}
const before = countFiles();
await call("/notify", { subject: "overflow", messageId: "overflow-1" });
const after = countFiles();
check("上限 200：超出丢最旧", before > 200 && after <= 200, `before=${before} after=${after}`);
r = await call("/pending-notify", { limit: 500 });
check("新入队那条仍在（丢的是最旧）", !!r.items?.some((i) => i.subject === "overflow"), `items=${r.items?.length}`);

// ── 7. TTL：超过 24h 的条目应被清掉 ─────────────────────────────
const staleId = "stale0001";
const stalePath = path.join(notifyDir, `${staleId}.json`);
fs.writeFileSync(stalePath, JSON.stringify({
  subject: "stale", messageId: "stale",
  queuedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
}), "utf-8");
r = await call("/pending-notify", { limit: 500 });
check("TTL 24h：过期条目不出现在队列里", !r.items?.some((i) => i.id === staleId));
check("TTL 24h：过期条目已从磁盘清掉", !fs.existsSync(stalePath));

cleanup();
console.log(`\nsmoke-notify: ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
