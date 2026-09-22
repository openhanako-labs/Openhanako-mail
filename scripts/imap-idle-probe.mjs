/**
 * scripts/imap-idle-probe.mjs — IMAP 实时监听器（IDLE）回归探针
 *
 * 为什么有这个东西：
 *   imap-idle.mjs 是「新邮件到达 → 写缓存 → 弹桌面通知」的源头。
 *   它本来用 node-imap 的 'mail' 事件，2026-09-22 换成了 imapflow 的 idle()/『exists』。
 *   这条链路在本机从来没被跑过（没有 IMAP 账号），而它一旦断了，
 *   表现是「邮件能手动同步到，但通知永远不来」—— 静默、难查。
 *
 * 做法：
 *   造一个临时数据目录 + accounts.json（账号指向真实 IMAP 服务器），
 *   装载 imap-idle.mjs 并 startAll()，然后**真发一封邮件进去**，
 *   看它有没有落下缓存文件和通知队列条目。
 *
 * 用法：
 *   node scripts/imap-idle-probe.mjs --account=env      # 用 IMAP_* 环境变量
 *   node scripts/imap-idle-probe.mjs                    # 用 Ethereal（收不到外部投递，仅验连接）
 *
 * ── 一个刻意的绕行 ──
 * 监听器会跳过「发件人里含自己地址」的邮件（避免为自己的发信弹通知）。
 * 而探针只能用自己的账号给自己发信，所以这里把 accounts.json 里的 `email`
 * 写成一个中性地址、真正的登录凭据放在 `config.imapUser`（getImapConfig 认这个）。
 * 于是自跳过判断不成立、链路能被验到。这一项绕行已在下方输出里标明。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireFromBackend = createRequire(pathToFileURL(path.join(process.cwd(), "backend", "package.json")).href);
const nodemailer = requireFromBackend("nodemailer");

const EXTERNAL = process.argv.includes("--account=env");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function ok(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
}

// ── 1. 凭据与收件人 ─────────────────────────────────────
let imapHost, imapPort, imapUser, imapPass, smtpHost, smtpPort, smtpSecure, toAddress;

if (EXTERNAL) {
  imapHost = process.env.IMAP_HOST;
  imapPort = process.env.IMAP_PORT || "993";
  imapUser = process.env.IMAP_USER;
  imapPass = process.env.IMAP_PASS;
  smtpHost = process.env.SMTP_HOST || "smtp.qq.com";
  smtpPort = process.env.SMTP_PORT || "465";
  smtpSecure = process.env.SMTP_SECURE !== "false";
  toAddress = imapUser;
} else {
  const acc = await nodemailer.createTestAccount();
  imapHost = acc.imap.host;
  imapPort = String(acc.imap.port);
  imapUser = acc.user;
  imapPass = acc.pass;
  smtpHost = acc.smtp.host;
  smtpPort = String(acc.smtp.port);
  smtpSecure = acc.smtp.secure;
  toAddress = acc.user;
}

if (!imapHost || !imapUser || !imapPass) {
  console.log("FAIL  缺少凭据（IMAP_HOST / IMAP_USER / IMAP_PASS）");
  process.exit(1);
}

// ── 2. 造临时数据目录 + accounts.json ───────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-idle-probe-"));
const NEUTRAL_EMAIL = "probe-local@invalid.test"; // 见文件头「一个刻意的绕行」
fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify([{
  id: "probe1",
  email: NEUTRAL_EMAIL,
  config: { imapHost, imapPort, imapUser, imapPass },
}], null, 2), "utf-8");

process.env.HANAKO_PLUGIN_DATA = dir;
console.log(`数据目录: ${dir}`);
console.log(`账号: email=${NEUTRAL_EMAIL}  imapUser=${imapUser}`);
console.log(`登录: ${imapHost}:${imapPort}   收件人: ${toAddress}`);
console.log("");

// ── 3. 装载监听器并启动 ─────────────────────────────────
const idle = await import(`file://${path.join(process.cwd(), "backend", "imap-idle.mjs").replace(/\\/g, "/")}`);
await idle.startAll();
const logFile = path.join(dir, "imap-idle.log");
await sleep(6000); // 等它连上并进入 IDLE

const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";
ok("监听器已连接并进入监听", logText.includes("已连接并进入监听"), logText.split("\n").filter(Boolean).slice(-1)[0] || "(无日志)");

// ── 4. 真发一封进去 ─────────────────────────────────────
const tag = "idleprobe" + Math.random().toString(36).slice(2, 6);
const subject = `${tag} watcher-test`;
const smtp = nodemailer.createTransport({
  host: smtpHost, port: Number(smtpPort), secure: smtpSecure,
  auth: { user: imapUser, pass: imapPass },
});
await smtp.sendMail({ from: imapUser, to: toAddress, subject, text: "hello from idle probe" });
console.log(`已发出测试邮件: ${subject}`);

// ── 5. 等它被监听到 ─────────────────────────────────────
const cacheDir = path.join(dir, "cache");
const notifyDir = path.join(dir, "_pending_notify");
let hit = null;
for (let i = 0; i < 30; i++) {
  await sleep(3000);
  if (!fs.existsSync(cacheDir)) continue;
  for (const f of fs.readdirSync(cacheDir)) {
    if (!f.startsWith("ws-")) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf-8"));
      if (String(j.subject || "").includes(tag)) { hit = { file: f, j }; break; }
    } catch { /* 半写状态，下一轮再看 */ }
  }
  if (hit) break;
}

ok("IDLE 事件触发了缓存写入", Boolean(hit), hit ? hit.file : "90 秒内没等到");
if (hit) {
  ok("缓存内容带正确主题/发件人/账号", hit.j.subject.includes(tag) && Boolean(hit.j.from) && hit.j.accountId === "probe1",
    `from=${hit.j.from} accountId=${hit.j.accountId}`);
  ok("缓存带 platform=imap-idle", hit.j.platform === "imap-idle", String(hit.j.platform));
}

const queued = fs.existsSync(notifyDir) ? fs.readdirSync(notifyDir).filter((f) => f.endsWith(".json")) : [];
ok("桌面通知已入队", queued.length > 0, `${queued.length} 条`);

idle.stopAll();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nimap-idle-probe: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
