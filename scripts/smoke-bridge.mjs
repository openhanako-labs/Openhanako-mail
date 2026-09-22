/**
 * scripts/smoke-bridge.mjs — 本地跑通「AppHost ↔ 受管服务」整座桥。
 *
 * 为什么需要它：`ctx.runtime.fetch` 的返回形状、`timeoutMs` 上限、服务的
 * 端点契约，都只能在真实宿主里暴露过；每次都让用户重装一遍去试太贵。
 * 这里用一个**假的 ctx.runtime**（真 node 子进程 + 真 fetch + 真 Response）
 * 把同一条路径在本地跑一遍。
 *
 * 跑法：node scripts/smoke-bridge.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// 依赖须已就位（本测试不跑 npm）。
// 用 imapflow 而不是 imap：後者在 2026-09-22 的迁移里被摘掉了，
// 当时这条守卫就变成了假 SKIP——而 SKIP 在汇总里读起来像“没事”，很危险。
const nm = path.join(ROOT, "backend", "node_modules");
if (!fs.existsSync(path.join(nm, "imapflow", "package.json"))) {
  console.log("SKIP  需要 backend/node_modules（先 npm install 或从已安装副本拷一份）");
  process.exit(0);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mail-bridge-"));
const dataDir = path.join(home, "app-data", "hanako-mail");
const legacyDir = path.join(home, "plugin-data", "hanako-mail", "hanako-mail");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(legacyDir, { recursive: true });
// 造一个 v1 账号，验证「服务启动 = 迁移完成」
fs.writeFileSync(path.join(legacyDir, "accounts.json"), JSON.stringify([
  { id: "t1", name: "测试", email: "t@example.com", provider: "imap", apiKey: "ENC:x:y:z" },
]), "utf-8");

// 自己的端口：避开真实运行中的服务（默认 43179），否则 EADDRINUSE。
// 这也是 bridge 测试能就地跑的前提。
const PORT = Number(process.env.HANA_MAIL_SERVICE_PORT) || 43184;
process.env.HANA_MAIL_SERVICE_PORT = String(PORT);
const MARKER = "HANA_MAIL_SERVICE_READY";
let proc = null;
let probe = "";

/** 复刻宿主：真子进程 + 真 fetch + 真 Response。 */
const fakeRuntime = {
  async start({ args, service }) {
    proc = spawn(process.execPath, [path.join(ROOT, "runtime", "service.mjs"), ...args], {
      cwd: dataDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    probe = "";
    proc.stdout.on("data", (d) => { probe += d.toString(); });
    proc.stderr.on("data", (d) => { if (process.env.MAIL_DEBUG) process.stderr.write("[svc] " + d); });
    proc.on("exit", (code) => { if (process.env.MAIL_DEBUG) console.log("[svc] exited", code); });
    return {
      runtimeId: "fake-runtime",
      profile: "native",
      enforcement: "partial",
      service: { ...service, state: "pending" },
      state: "starting",
    };
  },
  async get(runtimeId) {
    if (!proc || proc.exitCode !== null) return { runtimeId, state: "exited", exitCode: proc?.exitCode ?? null };
    const ready = probe.includes(MARKER);
    return { runtimeId, state: ready ? "ready" : "starting", service: { state: ready ? "ready" : "pending" } };
  },
  async stop() {
    try { proc?.kill("SIGTERM"); } catch { /* ignore */ }
  },
  /** 关键：与宿主一样返回真 Response，而不是裸 body。 */
  async fetch(runtimeId, route, init = {}) {
    const timeoutMs = Number(init.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      throw new Error("Runtime fetch timeoutMs must be an integer from 1 through 30000.");
    }
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
      method: init.method || "GET",
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  },
};

// 用假的 runtime 装载整个应用
const mod = await load("index.js");
const ctx = {
  dataDir,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  tools: { register: () => () => {} },
  routes: { register: async () => () => {} },
  runtime: fakeRuntime,
  bus: { request: async () => ({}) },
};
process.env.HANAKO_PLUGIN_DATA = dataDir;

let dispose = null;
try { dispose = await mod.apply(ctx); } catch (e) { check("apply 不抛", false, e.message); }

const { callService, serviceState } = await load("lib/runtime-host.mjs");
check("服务状态为 ready", serviceState() === "ready", serviceState());

// 关键回归：fetch 返回 Response，桥必须解析出 JSON 而不是 "non-json"
const health = await callService("/health", {});
check("callService 能解析 Response 里的 JSON", health?.ok === true, JSON.stringify(health).slice(0, 160));
check("health 报告依赖就绪", health?.deps === true, String(health?.deps));

// 迁移：服务启动时完成（不是 AppHost 调的）
check("服务启动即完成 v1 迁移", fs.existsSync(path.join(dataDir, "accounts.json")));

// 走真正的 worker-client（tools/*.js 用的就是它）
const { runCli } = await load("backend/worker-client.mjs");
let cliErr = null;
let folders = null;
try {
  folders = await runCli("folders", ["someone@example.com"], {
    CLAWEMAIL_API_KEY: process.env.CLAW_SMOKE_KEY || "",
    CLAWEMAIL_ADDRESS: "someone@example.com",
  });
} catch (e) { cliErr = e; }
// 没有真 key 时应当是一个明确的接口错误，而不是 "non-json" 或崩溃
check("runCli 走通桥（失败也是业务错误，不是协议错误）",
  folders !== null || (cliErr && !/non-json|unavailable/.test(cliErr.message)),
  cliErr ? cliErr.message.slice(0, 120) : `返回 ${Array.isArray(folders) ? folders.length + " 个文件夹" : "数据"}`);

// 通知队列：服务写、AppHost 取
//
// v0.4.4 改了这里的语义：原来是「取走即清空」，而清空发生在 toast 被拉起**之前**，
// 于是发送失败这条通知就永久消失（实测 09-20 23:15、09-21 19:06 两次）。
// 现在是「读取不删 → 确认后删」。断言跟着行为改，不是把红灯抹掉。
await callService("/notify", { subject: "t", sender: "s", messageId: "1", accountId: "a" });
const drained = await callService("/pending-notify", { limit: 5 });
check("通知入队后能被取走", drained?.ok === true && drained.items?.length === 1, JSON.stringify(drained).slice(0, 120));
check("返回项带 id（确认删除需要它）", typeof drained?.items?.[0]?.id === "string" && drained.items[0].id.length > 0);
const drained2 = await callService("/pending-notify", { limit: 5 });
check("取走不删（发送失败不丢，等下轮重发）", drained2?.items?.length === 1, JSON.stringify(drained2).slice(0, 80));
await callService("/notify-ack", { ids: [drained.items[0].id] });
const drained3 = await callService("/pending-notify", { limit: 5 });
check("确认之后才清空", drained3?.items?.length === 0, JSON.stringify(drained3).slice(0, 80));

// AgentQQ 设备码授权：start 是真实网络调用（不需要用户参与），能验到协议对不对。
// 之所以要这一步：这套协议是从官方 CLI 的 --dry-run 与实测反推的，不是文档里拄的，
// 一旦失效必须立刻知道。
const aqq = await callService("/agentqq/login/start", { name: "smoke" });
check("AgentQQ 设备码申请成功（真网络调用）",
  aqq?.ok === true && !!aqq.data?.sessionId && !!aqq.data?.inputCode && !!aqq.data?.browserUrl,
  JSON.stringify(aqq?.data || aqq).slice(0, 160));
if (aqq?.data?.sessionId) {
  const st = await callService("/agentqq/login/status", { sessionId: aqq.data.sessionId });
  check("未授权时状态为 pending", st?.data?.state === "pending", JSON.stringify(st?.data).slice(0, 120));
}
const unk = await callService("/agentqq/login/status", { sessionId: "no-such-session" });
check("未知会话返回 unknown（不抛）", unk?.data?.state === "unknown", JSON.stringify(unk?.data).slice(0, 80));

if (typeof dispose === "function") { try { dispose(); } catch { /* ignore */ } }
try { proc?.kill("SIGTERM"); } catch { /* ignore */ }
setTimeout(() => { try { proc?.kill("SIGKILL"); } catch { /* ignore */ } fs.rmSync(home, { recursive: true, force: true }); }, 800);

setTimeout(() => {
  console.log(`\nsmoke-bridge: ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
}, 1200);
