/**
 * scripts/smoke-load.mjs — 装载自检（不需要宿主，可直接 node 跑）。
 *
 * 覆盖 v1→v2 迁移里最容易静默出错的部分：
 *   1) ctx 投影：老代码 path.join(ctx.dataDir, ctx.pluginId) 必须仍解析到真实 App 数据目录
 *   2) 路由 registrar 真的能跑完：v2 里 registrar 抛错 = 整应用 failed
 *   3) 不存在与 ctx.routes.register() 互斥的顶层 routes/ 源文件
 *   4) 受管服务缺席时，apply() 只能降级、不能抛（工具与卡片要还能用）
 *   5) 转发层在服务不可用时返回 { ok:false }，不抛异常
 *
 * 真正跑通邮件链路要连宿主环境，见 README「自检」一节里单独跑 service.mjs 的办法。
 *
 * 用法：node scripts/smoke-load.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Windows 上从非 C: 盘（如 W:）用绝对路径 import() 会撞
// ERR_UNSUPPORTED_ESM_URL_SCHEME（"Received protocol 'w:'"）—— 必须先转成 file:// URL。
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

// ── 造一个隔离的 HANA_HOME ──
const home = fs.mkdtempSync(path.join(os.tmpdir(), "mail-smoke-"));
const appDataDir = path.join(home, "app-data", "hanako-mail");
fs.mkdirSync(appDataDir, { recursive: true });

process.env.HANA_HOME = home;
delete process.env.HANAKO_PLUGIN_DATA;

// ── 假的 v2 ctx：routes.register 必须真的把 registrar 跑一遍 ──
const registeredTools = [];
const registeredRoutes = [];
const fakeLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ctx = {
  dataDir: appDataDir,
  logger: fakeLogger,
  tools: { register: (t) => { registeredTools.push(t); return () => {}; } },
  routes: {
    register: async (fn) => {
      const app = {
        get: (p) => registeredRoutes.push(["GET", p]),
        post: (p) => registeredRoutes.push(["POST", p]),
        put: (p) => registeredRoutes.push(["PUT", p]),
        delete: (p) => registeredRoutes.push(["DELETE", p]),
        all: (p) => registeredRoutes.push(["ALL", p]),
      };
      await fn(app);
      return () => {};
    },
  },
  bus: { request: async () => ({}) },
  // 故意**不提供** ctx.runtime：AppHost 在服务缺席时必须降级而不是崩
};

// ── 装载 ──
const mod = await load("index.js");
check("index.js 导出 apply", typeof mod.apply === "function");

let dispose = null;
let loadErr = null;
try { dispose = await mod.apply(ctx); }
catch (e) { loadErr = e; }
check("服务缺席时 apply() 不抛（降级）", loadErr === null, loadErr?.message);
check("apply 仍返回 disposer", typeof dispose === "function");

// ── 1. 数据目录钉死 ──
check("HANAKO_PLUGIN_DATA = ctx.dataDir", process.env.HANAKO_PLUGIN_DATA === appDataDir,
  `实际=${process.env.HANAKO_PLUGIN_DATA}`);

// ── 2. ctx 投影：老表达式必须仍指向真实 App 数据目录 ──
const { legacyCtx } = await load("lib/legacy-ctx.mjs");
const lctx = legacyCtx(ctx);
check("join(lctx.dataDir, lctx.pluginId) === ctx.dataDir",
  path.join(lctx.dataDir, lctx.pluginId) === ctx.dataDir,
  `得 ${path.join(lctx.dataDir, lctx.pluginId)}`);
check("lctx.pluginDir 指向包根", lctx.pluginDir === ROOT);
check("lctx.log 是 v1 形状", typeof lctx.log.info === "function" && typeof lctx.log.warn === "function");

// ── 3. 注册面 ──
const names = registeredTools.map((t) => t.name).sort();
const expect = ["mail_accounts", "mail_folders", "mail_messages", "mail_send", "mail_sync"];
check("注册 5 个工具", names.length === 5, names.join(","));
check("工具名齐全", expect.every((n) => names.includes(n)), names.join(","));
check("每个工具都是 v2 单参 execute", registeredTools.every((t) => t.execute.length <= 1));

const paths = registeredRoutes.map(([, p]) => p);
check("路由 registrar 跑完且注册了路由", registeredRoutes.length > 15, `共 ${registeredRoutes.length} 条`);
check("包含 /accounts 与 /send", paths.includes("/accounts") && paths.includes("/send"));
check("不再有 v1 的模板路由 /mail", !paths.includes("/mail"));

// v2 把顶级 routes/ 目录当成另一条路由来源，与 ctx.routes.register() 互斥；
// 两边同时存在 = 整应用装载 failed（且 validate-app 静态校验查不到这条）。
const routesDir = path.join(ROOT, "routes");
let hasRouteSource = false;
if (fs.existsSync(routesDir)) {
  hasRouteSource = fs.readdirSync(routesDir, { withFileTypes: true })
    .some((e) => e.isFile() && /\.(m|c)?[jt]s$/.test(e.name));
}
check("不存在与 ctx.routes.register() 互斥的顶层 routes/ 源文件", !hasRouteSource);

// ── 4. 转发层：服务不可用时必须返回 { ok:false }，绝不抛 ──
const { callService, serviceState, SERVICE_PORT } = await load("lib/runtime-host.mjs");
check("服务未启动时 serviceState 为 failed（已优雅降级）", serviceState() === "failed", serviceState());
check("端口在服务允许范围内（1024-65535）", SERVICE_PORT >= 1024 && SERVICE_PORT <= 65535, String(SERVICE_PORT));
const down = await callService("/health", {});
check("服务不可用时 callService 返回 ok:false", down?.ok === false, JSON.stringify(down).slice(0, 120));

// 惰性自愈：首次装载时权限可能还没记账（实测 apply 与授权差约 190ms），
// 那时 startService 被拒。callService 必须在第一次真调用时补起，
// 而不是把“首次失败”当终态 —— 否则用户得手动重新加载一次应用。
const rtSrc = fs.readFileSync(path.join(ROOT, "lib", "runtime-host.mjs"), "utf-8");check("callService 在服务未就绪时会惰性重启", /if \(_state !== "ready" \|\| !_runtimeId\)[\s\S]{0,200}await doStart\(\)/.test(rtSrc));
check("惰性重启做了并发去重（_starting）", rtSrc.includes("_starting"));
check("失败后仍保留启动参数以便重试", rtSrc.includes("_startArgs"));

// 迁移放在服务启动流程里（AppHost 读不到 plugin-data，且 apply 可能早于授权）
const svcSrc = fs.readFileSync(path.join(ROOT, "runtime", "service.mjs"), "utf-8");
check("服务启动时自己完成 v1 迁移", /async function main\(\)[\s\S]{0,900}migrate\(LEGACY_DIR, DATA_DIR\)/.test(svcSrc));

// 残留的 childEnv 引用会变成运行期 SyntaxError（"does not provide an export named"），
// 静态语法检查查不出来 —— 这一条就是为它设的。
check("backend/lib 里不再有 childEnv 引用", (() => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(mjs|js|cjs)$/.test(e.name)) continue;
      if (fs.readFileSync(p, "utf-8").includes("childEnv")) hits.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "backend")); walk(path.join(ROOT, "lib"));
  if (hits.length) console.log("      残留:", hits.join(", "));
  return hits.length === 0;
})());

const { postJson } = await load("backend/net-child.mjs");
const netDown = await postJson("http://127.0.0.1:1/x", { timeoutMs: 1000 });
check("net-child 在服务不可用时也返回 ok:false（不抛）", netDown?.ok === false, JSON.stringify(netDown).slice(0, 120));

let runCliThrew = false;
const { runCli } = await load("backend/worker-client.mjs");
try { await runCli("folders", ["a@b.c"]); } catch { runCliThrew = true; }
check("runCli 服务不可用时抛 Error（保持旧语义）", runCliThrew);

// ── 5. imap-idle 的两处保证（不能空转退出、不能自动接管进程） ──
const imapIdleSrc = fs.readFileSync(path.join(ROOT, "backend", "imap-idle.mjs"), "utf-8");
check("imap-idle 用 runtimeDataDir（不再自己推算少一层的回退路径）", imapIdleSrc.includes("runtimeDataDir()"));
check("imap-idle 有常驻守护（不会空转退出被父进程 10s 重启）", imapIdleSrc.includes("reconcileTimer"));
check("imap-idle 被 import 时不接管进程生命周期", imapIdleSrc.includes("IS_MAIN"));
const wsSrc = fs.readFileSync(path.join(ROOT, "backend", "ws-monitor.mjs"), "utf-8");
check("ws-monitor 被 import 时不接管进程生命周期", wsSrc.includes("IS_MAIN"));

// ── 6. manifest 与实现一致 ──
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8"));
const caps = manifest.capabilities || [];
const rtHost = fs.readFileSync(path.join(ROOT, "lib", "runtime-host.mjs"), "utf-8");
check("manifest 声明了 app/runtime.execute", caps.includes("app/runtime.execute"));
check("manifest 声明了 app/runtime.native", caps.includes("app/runtime.native"));
check("manifest 声明了 app/runtime.network", caps.includes("app/runtime.network"));
check("manifest 声明了 app/process.spawn（AppHost 要用它发桌面通知）", caps.includes("app/process.spawn"));

// 核心不变量：**服务侧（backend/*.mjs）不许有任何 spawn/execFile**。
// 服务跑在受管 native 运行时里，被 Job Object 管着，spawn 会直接 EPERM ——
// 之前 npm install / mail-cli / 图片代理 / 通知全死在这里，而且只在真实装载时暴露。
// 静态语法检查查不出这类问题，所以拿一个断言把它钉死。
check("服务侧（backend/*.mjs）无 spawn/execFile", (() => {
  const bad = [];
  for (const e of fs.readdirSync(path.join(ROOT, "backend"), { withFileTypes: true })) {
    if (!e.isFile() || !/\.mjs$/.test(e.name)) continue;
    const src = fs.readFileSync(path.join(ROOT, "backend", e.name), "utf-8");
    // 去掉注释行再查，避免把解释性注释当成调用
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    if (/\b(spawn|execFile|execFileSync|spawnSync)\s*\(/.test(code)) bad.push(e.name);
  }
  if (bad.length) console.log("      含 spawn:", bad.join(", "));
  return bad.length === 0;
})());

// 通知派发必须在 AppHost 侧（那里有 --allow-child-process）
check("通知派发在 AppHost 侧（lib/notify-drain.mjs）", fs.existsSync(path.join(ROOT, "lib", "notify-drain.mjs")));
check("服务不自己发通知，而是入队", fs.readFileSync(path.join(ROOT, "runtime", "service.mjs"), "utf-8").includes("_pending_notify"));
check("profile 降级链首位是 native（优先有沙箱）", rtHost.includes('const RUNTIME_PROFILES = ["native"'));
check("profile 降级链含 local-machine（native 沙箱身份失败时的退路）", rtHost.includes('RUNTIME_PROFILES = ["native", "local-machine"]'));
check("manifest 声明了 app/runtime.local-machine", caps.includes("app/runtime.local-machine"));
check("仅沙箱身份类错误才触发降级", rtHost.includes("function shouldFallThrough"));
check("network: external 与 manifest 一致", rtHost.includes('network: "external"'));
check("readyMarker 与服务端一致",
  rtHost.includes("HANA_MAIL_SERVICE_READY")
  && fs.readFileSync(path.join(ROOT, "runtime", "service.mjs"), "utf-8").includes("HANA_MAIL_SERVICE_READY"));

// 卡片封面（face）。官方校验器**不查它**，而写坏了只会静默降级成“未声明”——
// 所以把运行时那套规则（bundle/index.js 的 wkr 函数）在这里重实现一遍作为断言：
// 相对 ui/ 目录、不能用反斜杠、分段不能空/./../以.开头、扩展名限 png|webp|svg、文件必须存在。
const FACE_EXTS = new Set([".png", ".webp", ".svg"]);
function faceProblem(image) {
  const o = String(image).trim();
  if (!o) return "empty";
  if (o.includes("\\") || o.includes("\0")) return "illegal characters";
  if (o.startsWith("/")) return "must be relative to ui/";
  const segs = o.split("/");
  if (segs.some((s) => !s || s === "." || s === ".." || s.startsWith("."))) return "escapes ui/";
  const ext = path.extname(segs[segs.length - 1]).toLowerCase();
  if (!FACE_EXTS.has(ext)) return `bad extension "${ext || "none"}"`;
  const abs = path.join(ROOT, "ui", ...segs);
  try { if (!fs.statSync(abs).isFile()) return `not a file at ui/${segs.join("/")}`; }
  catch { return `missing ui/${segs.join("/")}`; }
  return null;
}
for (const [i, card] of (manifest.contributes?.cards || []).entries()) {
  if (card.face === undefined) continue;
  const img = card.face && typeof card.face === "object" ? card.face.image : undefined;
  const prob = typeof img === "string" ? faceProblem(img) : "face.image must be a string";
  check(`卡片 "${card.id}" 的 face 声明合法`, prob === null, prob || String(img));
}

dispose();
fs.rmSync(home, { recursive: true, force: true });

console.log(`\nsmoke-load: ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
