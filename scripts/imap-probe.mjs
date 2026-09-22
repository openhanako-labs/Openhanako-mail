/**
 * scripts/imap-probe.mjs — IMAP 后端回归探针
 *
 * 为什么有这个东西：
 *   这台机器上**一个 IMAP 账号都没有**（账号是 ClawEmail），所以 imap-backend.mjs
 *   这条路径长期以来既没被改过、也没被验过。要把它从 `imap` 迁到 `imapflow`，
 *   先得有「改之前是好的」这个基准，否则无从判断迁移有没有弄坏什么。
 *
 * 做法：
 *   用 Ethereal（nodemailer 自带的测试邮箱服务）开一个**真实的** IMAP 收件箱，
 *   给自己发一封，然后把整套 IMAP 操作跑一遍。
 *   账号缓存在临时目录，baseline 与 imapflow 两侧共用同一个收件箱，可逐项对照。
 *
 * 用法：
 *   node scripts/imap-probe.mjs --mode=baseline    # 现有 imap 库（迁移前基准）
 *   node scripts/imap-probe.mjs --mode=imapflow    # 新实现（迁移后对照）
 *   node scripts/imap-probe.mjs --mode=baseline --fresh   # 丢弃缓存账号，重新开一个
 *
 * 退出码 0 = 全过。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// 依赖装在 backend/node_modules（而不是仓根），脚本却在 scripts/ ——
// 普通 import 从 scripts/ 往上一层层找找不到。锚定到 backend/package.json 解析。
const requireFromBackend = createRequire(pathToFileURL(path.join(process.cwd(), "backend", "package.json")).href);
const nodemailer = requireFromBackend("nodemailer");

const CACHE_DIR = path.join(os.tmpdir(), "hana-mail-imap-probe");
const ACCOUNT_FILE = path.join(CACHE_DIR, "account.json");
const argMode = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=baseline").split("=")[1];
const FRESH = process.argv.includes("--fresh");

let failures = 0;
let skips = 0;
function ok(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
}
function skip(name, detail = "") {
  console.log(`SKIP  ${name}${detail ? `  ${detail}` : ""}`);
  skips++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getAccount() {
  // --account=env：用调用方传入的真实邮箱（不碰 Ethereal，不发测试账号申请）
  if (process.argv.includes("--account=env")) {
    const host = process.env.IMAP_HOST;
    const user = process.env.IMAP_USER;
    const pass = process.env.IMAP_PASS;
    if (!host || !user || !pass) {
      console.log("FAIL  --account=env 需要环境变量 IMAP_HOST / IMAP_USER / IMAP_PASS");
      process.exit(1);
    }
    return {
      user,
      pass,
      imap: { host, port: Number(process.env.IMAP_PORT || 993), secure: true },
      smtp: {
        host: process.env.SMTP_HOST || host.replace(/^imap\./, "smtp."),
        port: Number(process.env.SMTP_PORT || 465),
        secure: process.env.SMTP_SECURE !== "false",
      },
      web: "(外部账号，无 Ethereal 网页)",
    };
  }
  if (!FRESH) {
    try {
      return JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8"));
    } catch {
      /* 没缓存就新建 */
    }
  }
  const acc = await nodemailer.createTestAccount();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2), "utf-8");
  return acc;
}

const acc = await getAccount();
const EXTERNAL = process.argv.includes("--account=env");
console.log(`探针账号: ${acc.user}`);
console.log(`IMAP: ${acc.imap.host}:${acc.imap.port}   SMTP: ${acc.smtp.host}:${acc.smtp.port}`);
console.log(`模式: ${mode_is()}  (账号: ${EXTERNAL ? "外部（环境变量传入）" : FRESH ? "Ethereal 已重建" : "Ethereal 复用"})`);
console.log("");

function mode_is() {
  return argMode;
}

// ── 1. 先发一封真实邮件进去 ──────────────────────────────
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
// 关键词必须是**以字母开头的词**：QQ 的 IMAP SEARCH 对 SUBJECT 是词前缀匹配，
// 纯数字串（如 20260922）在 QQ 上实测 0 命中（`{subject:'probe'}` 则能命中 1 条）。
// 之前用日期前 8 位当关键词，于是探针在 QQ 上假报失败——测试自己的错，不是产品的。
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const tag = "hp" + Array.from({ length: 5 }, () => LETTERS[Math.floor(Math.random() * 26)]).join("");
const subject = `${tag} probe-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
const bodyText = `这是 IMAP 探针在 ${new Date().toISOString()} 发出的正文。`;

const smtp = nodemailer.createTransport({
  host: acc.smtp.host,
  port: acc.smtp.port,
  secure: acc.smtp.secure,
  auth: { user: acc.user, pass: acc.pass },
});
const sent = await smtp.sendMail({ from: acc.user, to: acc.user, subject, text: bodyText, html: `<p>${bodyText}</p>` });
ok("SMTP 发送成功（拿到 messageId）", Boolean(sent?.messageId), String(sent?.messageId || ""));

// 把后端要用的凭据放进环境变量（imap-backend 的 getImapConfig 从这里读）
process.env.IMAP_HOST = acc.imap.host;
process.env.IMAP_PORT = String(acc.imap.port);
process.env.IMAP_USER = acc.user;
process.env.IMAP_PASS = acc.pass;
process.env.SMTP_HOST = acc.smtp.host;
process.env.SMTP_PORT = String(acc.smtp.port);
process.env.SMTP_USER = acc.user;
process.env.SMTP_PASS = acc.pass;
process.env.HANAKO_PLUGIN_DATA = path.join(CACHE_DIR, "data");
fs.mkdirSync(process.env.HANAKO_PLUGIN_DATA, { recursive: true });

const email = acc.user;

// ── 2. 装载被测后端 ──────────────────────────────────────
// 三种模式：
//   baseline — 旧的 imap 实现，直接调后端模块
//   imapflow — 新的 imapflow 实现，直接调后端模块
//   inbox    — 走**真正的分发入口**（backend/inbox.mjs 的 COMMANDS）
//              这一跳是探针之前绕过的：「inbox.mjs 会不会正确地把 IMAP 账号
//              交给新实现」只有这个模式能验。
const loadBackend = async (rel) => {
  const p = path.join(process.cwd(), "backend", rel);
  if (!fs.existsSync(p)) {
    console.log(`FAIL  未找到 backend/${rel}`);
    process.exit(1);
  }
  return await import(`file://${p.replace(/\\/g, "/")}`);
};

let backend;
if (mode_is() === "inbox") {
  const inboxMod = await loadBackend("inbox.mjs");
  const C = inboxMod.COMMANDS;
  const boxArg = (o = {}) => `--fid=${o.folder || "INBOX"}`;
  backend = {
    listMessages: (_e, o = {}) => C.list([email, `--limit=${o.limit ?? 20}`, boxArg(o)]),
    readMessage: (_e, id, o = {}) => C.read([email, String(id), boxArg(o)]),
    searchMessages: (_e, kw, o = {}) => C.search([email, kw, `--limit=${o.limit ?? 20}`, boxArg(o)]),
    listFolders: () => C.folders([email]),
    markRead: (_e, id, read = true, folder = "INBOX") => C["mark-read"]([email, String(id), `--fid=${folder}`]),
    closeAll: async () => {},
  };
} else if (mode_is() === "imapflow") {
  backend = await loadBackend("imapflow-client.mjs");
} else {
  // 迁移已完成（2026-09-22），旧的 imap-backend.mjs 已随此删除。
  // baseline 保留为一条明确的提示，而不是一个会让人猜的 ENOENT。
  console.log("baseline 模式已不可用：旧的 imap-backend.mjs 已随迁移完成而删除。");
  console.log("  · 对照基准在 git 历史里（迁移前那个提交）");
  console.log("  · 现在的等价物：--mode=imapflow（新实现）/ --mode=inbox（真实分发入口）");
  process.exit(2);
}

// ── 3. 等邮件到达（Ethereal 通常几秒） ────────────────────
let found = null;
for (let i = 0; i < 15; i++) {
  try {
    const list = await backend.listMessages(email, { limit: 10, folder: "INBOX" });
    found = (Array.isArray(list) ? list : []).find((m) => String(m.subject || "").includes(subject));
    if (found) break;
  } catch (e) {
    if (i === 0) console.log(`      首次 list 失败（继续重试）: ${e.message}`);
  }
  await sleep(2000);
}
ok("listMessages 能拉到刚发出的邮件", Boolean(found), found ? `id=${found.id}` : "30 秒内未出现");
if (!found) {
  console.log("\n探针中止：收件箱里读不到测试邮件。");
  process.exit(1);
}

// ── 4. 列表字段形状 ──────────────────────────────────────
ok("列表项有 id/from/subject/date", Boolean(found.id && found.from && found.subject && found.date),
  `id=${found.id} from=${found.from} date=${found.date}`);
ok("列表项 id 是 UID 形态（数字串）", /^\d+$/.test(String(found.id)), String(found.id));

// ── 5. 读单封（正文必须非空 —— 曾经 bodies:"" 导致正文永远为空） ──
const detail = await backend.readMessage(email, found.id, { folder: "INBOX" });
ok("readMessage 返回主题", String(detail?.subject || "").includes(subject), String(detail?.subject || ""));
const textLen = String(detail?.text || detail?.textContent || "").length;
const htmlLen = String(typeof detail?.html === "string" ? detail.html : detail?.html?.content || "").length;
ok("readMessage 正文非空（text 或 html）", textLen > 0 || htmlLen > 0, `text=${textLen} html=${htmlLen}`);

// ── 6. 文件夹列表 ────────────────────────────────────────
const folders = await backend.listFolders(email);
const folderList = Array.isArray(folders) ? folders : [];
ok("listFolders 返回数组且含 INBOX", folderList.length > 0 && folderList.some((f) => /inbox/i.test(String(f.name || f.path || ""))),
  folderList.map((f) => f.name || f.path).join(","));

// ── 7. 搜索（数组形式的 SearchObject 要能正确转换） ──────
// QQ 的 IMAP SEARCH **有索引延迟**：刚到的邮件搜不到（实测：已发 5 封，
// `{subject:'probe'}` 只命中 1 条）。这是服务器特性，不是实现的错，
// 所以这里重试等候；对真实外部账号允许降级为 SKIP，对 Ethereal 仍算失败
//（那边索引是实时的，若搜不到就是真问题）。
let searchOk = false;
let searchLen = 0;
for (let i = 0; i < 12; i++) {
  const r = await backend.searchMessages(email, tag, { folder: "INBOX", limit: 10 });
  searchLen = Array.isArray(r) ? r.length : 0;
  if (Array.isArray(r) && r.some((m) => String(m.subject || "").includes(tag))) {
    searchOk = true;
    break;
  }
  await sleep(5000);
}
if (searchOk) {
  ok("searchMessages 能按关键词命中", true, `关键词=${tag} 命中 ${searchLen} 条`);
} else if (EXTERNAL) {
  skip("searchMessages 能按关键词命中", `等了 60 秒仍 0 命中 —— 服务器搜索索引延迟，非实现问题`);
} else {
  ok("searchMessages 能按关键词命中", false, `关键词=${tag} 命中 ${searchLen} 条`);
}

// ── 8. 标记已读 ──────────────────────────────────────────
await backend.markRead(email, found.id, true, "INBOX");
const afterRead = await backend.listMessages(email, { limit: 10, folder: "INBOX" });
const same = (Array.isArray(afterRead) ? afterRead : []).find((m) => String(m.id) === String(found.id));
ok("markRead 之后该封仍在列表里", Boolean(same), same ? "" : "标记已读后邮件消失了");

// ── 9. 收尾 ─────────────────────────────────────────────
try { await backend.closeAll?.(); } catch { /* 关闭失败不影响判定 */ }

console.log(`\nimap-probe[${mode_is()}]: ${failures} failure(s)${skips ? `, ${skips} skip(s)` : ""}`);
console.log(`收件箱网页（可肉眼核对）: ${acc.web}`);
process.exit(failures === 0 ? 0 : 1);
