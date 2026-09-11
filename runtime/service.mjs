/**
 * runtime/service.mjs — 邮件后端的受管运行时（managed runtime）。
 *
 * 为什么必须有这个进程：
 * v2 的 AppHost 被宿主以 `hana-server.exe --permission --allow-fs-read=<安装目录>
 * --allow-fs-read=<app-data> --allow-fs-write=<app-data> [--allow-child-process]` 启动，
 * Node 的权限模型**在进程内部**传给子进程，于是 AppHost 及其一切子进程：
 *   · 读不到安装目录 / app-data 之外的任何文件（v1 的 plugin-data、npm 自己的代码都不行）
 *   · **没有出站网络**（Node 26 的权限模型管网络，报 ERR_ACCESS_DENIED）
 * 而邮件后端要连 IMAP/SMTP、要连 ClawEmail 的 WebSocket、要调用户自配的 LLM 端点 ——
 * 全都过不去。实测过：`childEnv()` 剥环境变量无效，因为 AppHost 的 env 是白名单，
 * 里面根本没有 NODE_OPTIONS。
 *
 * 平台为此准备了受管运行时；native profile 才允许「读当前用户可读的文件 + 外网」。
 * 所以这里把「一切需要网络/外部文件/子进程的活」收进一个进程：
 *   · inbox 命令（list/read/send/reply/…）
 *   · ClawEmail WebSocket 监听 + IMAP IDLE 监听
 *   · 出站 HTTP（LLM）
 *   · 图片代理、桌面通知
 *   · 依赖安装、v1 数据迁移
 * AppHost 那边只留工具注册、路由和转发（见 lib/runtime-host.mjs）。
 *
 * 启动参数（由 ctx.runtime.start 的 args 传入，不能用 env —— 那边的 env 也是白名单）：
 *   argv[2] = 本 App 的数据目录（app-data/hanako-mail）
 *   argv[3] = v1 数据目录（plugin-data/hanako-mail/hanako-mail），可选
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(INSTALL_DIR, "backend");

const DATA_DIR = process.argv[2] || path.join(process.env.USERPROFILE || "", ".hanako", "app-data", "hanako-mail");
const LEGACY_DIR = process.argv[3] || "";

// 必须在 import 任何 backend 模块之前设好：它们在模块作用域就算数据目录。
process.env.HANAKO_PLUGIN_DATA = DATA_DIR;

const PORT = Number(process.argv[4]) || 43179;
const READY_MARKER = "HANA_MAIL_SERVICE_READY";
const MAX_HTTP_BYTES = 4 * 1024 * 1024;

// 日志一律走 stderr：stdout 只用来打就绪标记（宿主要精确匹配）。
// 同时镜像到 <DATA_DIR>/service.log —— 受管运行时的输出由宿主捕获，拿不到时
// 这个文件是唯一能读到的现场（启动期崩溃、沙箱拒绝、缺少文件都看得到）。
const SERVICE_LOG = path.join(DATA_DIR, "service.log");
function log(level, msg, data) {
  const ts = new Date().toISOString();
  const tail = data !== undefined ? ` ${JSON.stringify(data)}` : "";
  const line = `[${ts}] [${level}] ${msg}${tail}`;
  try { process.stderr.write(line + "\n"); } catch { /* ignore */ }
  try {
    let existing = "";
    try { existing = fs.readFileSync(SERVICE_LOG, "utf-8"); } catch { /* 首次 */ }
    // 简单的滚动：保留最后 64 KB，防止长期运行后无限增长。
    const next = (existing.length > 64 * 1024 ? existing.slice(-48 * 1024) : existing) + line + "\n";
    fs.writeFileSync(SERVICE_LOG, next, "utf-8");
  } catch { /* 日志失败不影响服务 */ }
}

// ── 依赖：服务不能 spawn，所以依赖必须随包发布 ──
//
// 原来这里跑 `npm install`（spawn）。但受管 native 运行时被 Job Object 管着，
// **服务不能再 spawn 任何进程**（实测报 spawn EPERM），npm 永远跑不起来。
// 因此改为：依赖随包发布（backend/node_modules 入包），这里只做检查与明确报错。
function checkDeps() {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, "package.json"), "utf-8")); }
  catch { return []; }
  const missing = [];
  for (const dep of Object.keys(manifest.dependencies || {})) {
    const rel = dep.startsWith("@") ? path.join("node_modules", dep.split("/")[0], dep.split("/")[1]) : path.join("node_modules", dep);
    if (!fs.existsSync(path.join(BACKEND_DIR, rel, "package.json"))) missing.push(dep);
  }
  return missing;
}

function reportDeps() {
  const missing = checkDeps();
  if (missing.length === 0) { log("INFO", "后端依赖就绪"); return true; }
  log("ERROR", "后端依赖缺失，邮件功能不可用", {
    missing,
    hint: "这些依赖应随安装包一并发布（backend/node_modules）。服务跑在受管 native "
      + "运行时里，不能 spawn，所以无法自己 npm install。",
  });
  return false;
}

// ── v1 数据迁移（服务能读 plugin-data，AppHost 不能） ──
const MIGRATE_ENTRIES = ["accounts.json", ".cred-salt", "cache"];

function copyEntry(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyEntry(path.join(from, name), path.join(to, name));
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function migrate(from, to) {
  const result = { ok: true, copied: [], skipped: [], errors: [], from, to };
  try {
    if (!from || !fs.existsSync(from)) { result.errors.push({ rel: "", error: "source-missing" }); return result; }
    fs.mkdirSync(to, { recursive: true });
    for (const rel of MIGRATE_ENTRIES) {
      const src = path.join(from, rel);
      const dst = path.join(to, rel);
      if (!fs.existsSync(src)) { result.skipped.push(`${rel}:absent`); continue; }
      if (fs.existsSync(dst)) { result.skipped.push(`${rel}:exists`); continue; } // 绝不覆盖现有数据
      try { copyEntry(src, dst); result.copied.push(rel); }
      catch (e) { result.ok = false; result.errors.push({ rel, error: e.message }); }
    }
  } catch (e) {
    result.ok = false;
    result.errors.push({ rel: "", error: e.message });
  }
  return result;
}

// ── 出站 HTTP（LLM 端点等）。AppHost 没有网，只有这里能发。 ──
function rawRequest({ url, method = "POST", headers = {}, body = "", timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve({ ok: false, error: "invalid url" }); return; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { resolve({ ok: false, error: "only http/https allowed" }); return; }

    const payload = typeof body === "string" ? body : (body ? JSON.stringify(body) : "");
    const hdrs = { ...headers };
    if (payload) hdrs["content-length"] = Buffer.byteLength(payload);

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(parsed, { method: String(method).toUpperCase(), headers: hdrs, timeout: timeoutMs }, (resp) => {
      const chunks = [];
      let total = 0;
      resp.on("data", (c) => {
        total += c.length;
        if (total > MAX_HTTP_BYTES) { resp.destroy(); resolve({ ok: false, error: "response too large", status: resp.statusCode }); return; }
        chunks.push(c);
      });
      resp.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let json;
        try { json = JSON.parse(text); } catch { /* 非 JSON 就回原文 */ }
        resolve({ ok: true, status: resp.statusCode, json, text: json === undefined ? text : undefined });
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: "request error: " + e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "request timeout" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 图片代理。
 *
 * 以前这里是 execFile(_proxy-fetch.cjs) —— 在 AppHost 里没网、只能靠子进程。
 * 但现在服务跑在受管 native profile 里，**不能再 spawn**（Job Object 管住，
 * 实测报 spawn EPERM），而且也没必要：服务自己就有原生出站网络。
 * 于是改为进程内直连，保留原来那套 SSRF 加固：
 *   · 仅 http/https
 *   · 屏蔽私网 / 回环（host 字符串 + DNS 解析后校验 IP，防 rebinding）
 *   · 限大小、限跳转、校验 content-type
 */
const MAX_PROXY_BYTES = 2.5 * 1024 * 1024; // base64 后约 3.3MB，卡在 AppHost 4MB 响应上限内
const PROXY_MAX_REDIRECTS = 4;
const BLOCKED_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1|fc[0-9a-f]{2}:|fe80:)/i;

function isBlockedHost(host) {
  const h = String(host || "").toLowerCase();
  if (BLOCKED_HOST.test(h)) return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return !!(mapped && BLOCKED_HOST.test(mapped[1]));
}

async function verifyResolved(host) {
  const dns = await import("node:dns");
  const addrs = await dns.promises.lookup(host, { all: true });
  for (const a of addrs || []) {
    if (isBlockedHost(a.address)) throw new Error("blocked resolved ip: " + a.address);
  }
}

async function proxyFetch(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop <= PROXY_MAX_REDIRECTS; hop++) {
    let parsed;
    try { parsed = new URL(current); } catch { return { ok: false, error: "invalid url" }; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "only http/https allowed" };
    if (isBlockedHost(parsed.hostname)) return { ok: false, error: "blocked host (private/loopback)" };
    try { await verifyResolved(parsed.hostname); } catch (e) { return { ok: false, error: e.message }; }

    let resp;
    try {
      resp = await fetch(parsed, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "user-agent": "Hanako-Mail/1.0", accept: "image/*" },
      });
    } catch (e) {
      return { ok: false, error: "fetch failed: " + e.message };
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return { ok: false, error: "redirect without location" };
      current = new URL(loc, parsed).href; // 下一轮会重新做完整校验
      continue;
    }
    if (resp.status !== 200) return { ok: false, error: "upstream " + resp.status };

    const ct = String(resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) return { ok: false, error: "not an image (content-type " + ct + ")" };

    const len = Number(resp.headers.get("content-length") || 0);
    if (len > MAX_PROXY_BYTES) return { ok: false, error: "image too large for proxy" };

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_PROXY_BYTES) return { ok: false, error: "image too large for proxy" };
    return { ok: true, ct, base64: buf.toString("base64") };
  }
  return { ok: false, error: "too many redirects" };
}

// ── 桌面通知：写队列，由 AppHost 取走并派发 ──
//
// 服务不能 spawn（Job Object → EPERM），而 Windows 通知必须拉起一个进程。
// AppHost 有 --allow-child-process，所以把“要发什么通知”写进文件，
// 让 AppHost 定时来取（见 http/ui.js 的 drainNotifications）。
function notifyDir() {
  const dir = path.join(DATA_DIR, "_pending_notify");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

function queueNotification(payload) {
  try {
    const id = Date.now().toString(36) + randomBytes(3).toString("hex");
    fs.writeFileSync(path.join(notifyDir(), `${id}.json`), JSON.stringify({
      subject: payload.subject || "(无主题)",
      sender: payload.sender || "",
      messageId: payload.messageId || "",
      accountId: payload.accountId || "",
      queuedAt: new Date().toISOString(),
    }), "utf-8");
    return { ok: true, queued: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 取走队列（AppHost 调用）。返回并清空。 */
function drainNotifications(limit = 10) {
  const out = [];
  try {
    const dir = notifyDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(0, limit);
    for (const f of files) {
      const p = path.join(dir, f);
      try { out.push(JSON.parse(fs.readFileSync(p, "utf-8"))); } catch { /* 坏文件直接丢 */ }
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { ok: true, items: out };
}

// ── 延迟到此处才 import 后端：它们都在模块作用域读 HANAKO_PLUGIN_DATA ──
//
// 必须过 pathToFileURL：Windows 上从非 C: 盘（如 W:）用绝对路径 import() 会撞
// ERR_UNSUPPORTED_ESM_URL_SCHEME（"Received protocol 'w:'"）。把反斜杠换成斜杠
// **不够** —— 盘符仍被当成 URL scheme。
function backendModule(rel) {
  return import(pathToFileURL(path.join(BACKEND_DIR, rel)).href);
}

let inbox = null;
async function loadBackend() {
  try {
    inbox = await backendModule("inbox.mjs");
    log("INFO", "inbox 命令表已加载");
  } catch (e) {
    log("ERROR", "inbox 加载失败（依赖可能未装好，/cli 会不可用）", { error: e.message });
    inbox = null;
  }
}

async function startListeners() {
  try {
    const wsMonitor = await backendModule("ws-monitor.mjs");
    await wsMonitor.startAll();
    log("INFO", "ws-monitor 已启动");
  } catch (e) { log("ERROR", "ws-monitor 启动失败", { error: e.message }); }
  try {
    const imapIdle = await backendModule("imap-idle.mjs");
    await imapIdle.startAll();
    log("INFO", "imap-idle 已启动");
  } catch (e) { log("ERROR", "imap-idle 启动失败", { error: e.message }); }
}

// ── HTTP 服务 ──
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_HTTP_BYTES) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf-8");
      if (!s) { resolve({}); return; }
      try { resolve(JSON.parse(s)); } catch { resolve(null); }
    });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname;

  // /health 不挑方法：桥（callService）总是 POST，手工排查时常 GET。
  // 只认 GET 会让桥拿到 404 —— 实测踩过。
  if (route === "/health") {
    return send(res, 200, { ok: true, deps: checkDeps().length === 0, node: process.version, port: PORT });
  }

  if (req.method !== "POST") return send(res, 405, { ok: false, error: "method not allowed" });
  const body = await readBody(req);
  if (body === null) return send(res, 413, { ok: false, error: "body too large or invalid json" });

  try {
    if (route === "/migrate") {
      return send(res, 200, migrate(body.from || LEGACY_DIR, body.to || DATA_DIR));
    }
    if (route === "/cli") {
      if (!inbox) return send(res, 503, { ok: false, error: "backend not loaded" });
      const handler = inbox.COMMANDS?.[body.cmd];
      if (!handler) return send(res, 400, { ok: false, error: `unknown command: ${body.cmd}` });
      for (const [k, v] of Object.entries(body.env || {})) {
        if (v !== undefined && v !== null) process.env[k] = String(v);
      }
      inbox.resetAccountCache();
      const data = await handler(body.args || []);
      return send(res, 200, { ok: true, data });
    }
    if (route === "/http") return send(res, 200, await rawRequest(body));
    if (route === "/proxy") return send(res, 200, await proxyFetch(body.url));
    if (route === "/notify") return send(res, 200, queueNotification(body));
    if (route === "/pending-notify") return send(res, 200, drainNotifications(body.limit));
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }

  return send(res, 404, { ok: false, error: "not found" });
}

async function main() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
  log("INFO", "邮件后端服务启动", {
    dataDir: DATA_DIR,
    legacyDir: LEGACY_DIR,
    port: PORT,
    node: process.version,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
  });

  // 迁移放在服务里做，而不是让 AppHost 启动后再调一次：
  // AppHost 读不到 plugin-data（不在它的只读白名单里）。
  // 服务启动 = 迁移完成，两件事绑成一件。
  try {
    const res = migrate(LEGACY_DIR, DATA_DIR);
    if (res.copied.length) log("INFO", "已从 v1 数据目录迁移", { copied: res.copied, from: res.from });
    else if (res.errors?.some((e) => e.error !== "source-missing")) {
      log("ERROR", "数据迁移失败，账号可能无法读取", {
        errors: res.errors,
        hint: `可手动把 ${LEGACY_DIR} 下的 accounts.json / .cred-salt / cache 复制到 ${DATA_DIR}`,
      });
    } else {
      log("INFO", "无需迁移（v1 数据目录不存在或目标已就绪）", { skipped: res.skipped });
    }
  } catch (e) {
    log("ERROR", "数据迁移异常，账号可能无法读取", { error: e.message });
  }

  // 依赖检查不再阻塞就绪：缺失时 /cli 会报错，但服务本身要起来，
  // 这样 /health 与其它端点仍可用（也便于诊断）。
  reportDeps();
  startListeners().catch((e) => log("ERROR", "监听启动失败", { error: e.message }));

  await loadBackend();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { send(res, 500, { ok: false, error: e.message }); } catch { /* ignore */ } });
  });

  server.on("error", (e) => {
    log("ERROR", "HTTP 服务启动失败", { error: e.message, port: PORT });
    process.exit(1);
  });

  server.listen(PORT, "127.0.0.1", () => {
    log("INFO", `HTTP 已监听 127.0.0.1:${PORT}`);
    // stdout 只打这一行：宿主按它判定服务已就绪。
    process.stdout.write(READY_MARKER + "\n");
  });
}

// 启动期的同步崩溃也要留下痕迹：受管进程的 stdout/stderr 被宿主收走，
// 拿不到时 service.log 是唯一现场。
process.on("uncaughtException", (e) => {
  log("ERROR", "uncaughtException", { error: e?.stack || String(e) });
});
process.on("unhandledRejection", (e) => {
  log("ERROR", "unhandledRejection", { error: e?.stack || String(e) });
});

main().catch((e) => { log("ERROR", "服务启动失败", { error: e?.stack || String(e) }); process.exit(1); });
