/**
 * lib/runtime-host.mjs — 受管邮件服务的宿主侧句柄。
 *
 * AppHost 里没有网络、也读不到安装目录之外的任何文件（见 runtime/service.mjs 顶部
 * 的长注释）。所以 AppHost 只做三件事：注册工具、挂路由、把要干活的请求转发给
 * 那个受管 native 服务。这个文件就是「转发」那一半。
 *
 * 持有 module-level 的单例 ctx，是为了让 tools/*.js、http/ui.js 这些**拿不到 ctx**
 * 的老代码能直接 call() —— 与 backend/cred-crypto.mjs 的 setCryptoDataDir 同一套路数。
 */

import { APP_ID } from "./env.mjs";

/** 服务监听端口。换值要同时确认没有别的 App 占用。 */
export const SERVICE_PORT = Number(process.env.HANA_MAIL_SERVICE_PORT) || 43179;
export const READY_MARKER = "HANA_MAIL_SERVICE_READY";

/**
 * ctx.runtime.fetch 的 timeoutMs 上限。
 *
 * 宿主管得很死：必须是 1..30000 的整数，超出直接拒（实测报
 * "Runtime fetch timeoutMs must be an integer from 1 through 30000"）。
 * 传 120000 会被抛掉 —— 而这个接口是用来转发 email 命令的，一抛就是全链失败。
 */
const SERVICE_FETCH_TIMEOUT_MS = 30000;

/** ctx.runtime.fetch 的请求体上限是 1 MiB（UTF-8），留点余量。 */
const MAX_BODY_BYTES = 900 * 1024;

/** 启动失败后的冷却时间，避免失败时被轮询反复拉起进程。 */
const RETRY_COOLDOWN_MS = 30000;
const MAX_CONSECUTIVE_FAILURES = 3;  // 连续失败 3 次后进入休眠
const DORMANT_TIMEOUT_MS = 10 * 60 * 1000; // 休眠 10 分钟后再试
let _lastFailureAt = 0;
let _consecutiveFailures = 0;
let _dormantUntil = 0;

/**
 * 启动就绪的超时。
 *
 * 不再长等依赖安装：服务现在不等 npm 就绪就先打 ready（依赖装好后再起监听），
 * 所以这个值关系到的是进程能不能起来，不是 npm 快不快。15 秒足够。
 */
const READY_TIMEOUT_MS = 15000;

let _ctx = null;
let _runtimeId = null;
let _startArgs = null;      // { dataDir, legacyDir } —— 惰性重启要用
let _starting = null;       // in-flight promise，防并发重复拉起
// 日志用 v1 形状的 { info, warn, error }（由 lib/legacy-ctx.mjs 包装），不是单个函数。
let _log = { info: () => {}, warn: () => {}, error: () => {} };
let _state = "idle"; // idle | starting | ready | failed
let _profile = ""; // 实际生效的 profile：native 失败时会降级到 local-machine

function logInfo(msg, data) { try { _log.info(msg, data); } catch { /* ignore */ } }
function logWarn(msg, data) { try { _log.warn(msg, data); } catch { /* ignore */ } }
function logError(msg, data) { try { _log.error(msg, data); } catch { /* ignore */ } }

export function serviceState() {
  return _state;
}

/** 实际生效的 profile。native 建不起沙箱时会降级到 local-machine。 */
export function serviceProfile() {
  return _profile;
}

export function serviceRuntimeId() {
  return _runtimeId;
}

/** 暴露给前端用的路径前缀（浏览器直连服务时用；本应用目前只走 AppHost 转发）。 */
export function serviceProxyPrefix() {
  return _runtimeId ? `/api/apps/${APP_ID}/routes/_runtime/${_runtimeId}` : "";
}

/**
 * 启动受管服务并等它就绪。
 * @param {object} ctx v2 App ctx
 * @param {{dataDir:string, legacyDir:string, log:Function}} opts
 */
export async function startService(ctx, { dataDir, legacyDir, log }) {
  _ctx = ctx;
  if (log) _log = log;
  _startArgs = { dataDir, legacyDir };
  return await doStart();
}

/**
 * 真正拉一次服务。
 *
 * 为什么它可能失败、而之后又该能成功：**装载与权限记账之间有窗口**。实测
 * 首次装载时 `apply()` 跑在 `23:58:44.097`，而 `app/runtime.execute` 写进账本
 * 是 `23:58:44.287` —— 晚了约 190ms，于是第一次申请必然被拒，而 apply 只跑一次。
 * 所以失败不当作终态：记住启动参数，等第一次真调用时再试（见 callService）。
 */
async function doStart() {
  if (!_ctx || !_startArgs) return false;
  if (_state === "ready" && _runtimeId) return true;
  if (_starting) return await _starting;
  // 刚失败过就先歇一会儿：调用方多是定时轮询（auto_sync / poll），
  // 不加冷却会在失败时反复 spawn 进程、反复跑 npm install。
  if (_lastFailureAt && Date.now() - _lastFailureAt < RETRY_COOLDOWN_MS) {
    return false;
  }
  // 连续失败多次后进入休眠，避免权限缺失时持续消耗 CPU。
  // 权限问题不会自动修复，重试只是浪费资源。
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    if (Date.now() < _dormantUntil) {
      return false;
    }
    // 休眠时间到了，允许再试一次（万一用户中途补了授权）
    _consecutiveFailures = 0;
    logInfo("邮件后端服务休眠结束，尝试重新启动", { dormantForMs: DORMANT_TIMEOUT_MS });
  }

  const { dataDir, legacyDir } = _startArgs;
  _state = "starting";

  const startWith = (profile) => _ctx.runtime.start({
    runtime: "node",
    entry: "runtime/service.mjs",
    // 参数走 args，不走 env —— 受管运行时的 env 也是宿主的白名单。
    args: [dataDir, legacyDir || "", String(SERVICE_PORT)],
    profile,
    // native 与 local-machine 都强制要求 network: "external"（宿主原话：
    // "The cross-platform native and local-machine profiles require explicit
    //  network: 'external' and its separate grant"）。
    network: "external",
    cwd: dataDir,
    service: { port: SERVICE_PORT, readyMarker: READY_MARKER },
  });

  _starting = (async () => {
    try {
      let rec;
      try {
        rec = await startWith("native");
        _profile = "native";
      } catch (nativeErr) {
        // 降级：native 沙箱身份在某些机器上**永远**建不起来 ——
        // 宿主 sandbox helper 见到 HANA_HOME 上有符号链接/重解析点就直接拒绝：
        //   [native-identity] reparse root is not supported (Win32 0)
        // 这不是「权限没给」，是机器布局决定的，重试多少次都一样。
        //
        // 实测本机就是这种情况（`C:\Users\<user>\.hanako` 本身是符号链接），
        // 而实测的另一半是：早先部署的构建带着这段降级，重装一个没有它的版本
        // 会让「邮件后端服务启动失败」——邮件功能整个不可用，且因为派发器挂在
        // ready 分支里，连通知也没了。所以这段不是可选项。
        //
        // 代价是明说的：local-machine **不提供文件隔离**，服务以当前系统用户权限运行
        //（enforcement: none）。对邮件后端这是唯一能让应用可用的选择 —— 它离开网络
        // 就不存在，而 native 这条路上不去。
        //
        // 注意：manifest 必须声明 app/runtime.local-machine，否则这里会被宿主的
        // capability 校验拒掉，就成了「降级也降不下来」。
        logWarn("沙箱 profile 不可用，尝试降级", {
          from: "native",
          to: "local-machine",
          error: nativeErr?.message || String(nativeErr),
        });
        rec = await startWith("local-machine");
        _profile = "local-machine";
        logWarn("邮件后端已降级到无沙箱 profile 启动", {
          profile: "local-machine",
          enforcement: rec?.enforcement,
          port: SERVICE_PORT,
          reason: "native 沙箱身份创建失败（HANA_HOME 上有符号链接/重解析点）",
          tradeoff: "local-machine 不提供文件隔离，服务以当前系统用户权限运行",
        });
      }
      _runtimeId = rec?.runtimeId ?? null;
      logInfo("邮件后端服务已启动", {
        runtimeId: _runtimeId,
        profile: rec?.profile || _profile,
        enforcement: rec?.enforcement,
        port: SERVICE_PORT,
      });
    } catch (e) {
      _state = "failed";
      _runtimeId = null;
      _lastFailureAt = Date.now();
      _consecutiveFailures++;
      const shouldDormant = _consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
      if (shouldDormant) {
        _dormantUntil = Date.now() + DORMANT_TIMEOUT_MS;
      }
      logError("邮件后端服务启动失败（邮件功能不可用）", {
        error: e?.message || String(e),
        consecutiveFailures: _consecutiveFailures,
        willDormant: shouldDormant,
        dormantForMs: shouldDormant ? DORMANT_TIMEOUT_MS : null,
        hint: "需要 app/runtime.execute + app/runtime.native（或 app/runtime.local-machine）"
          + " + app/runtime.network；缺任一项都会在这里被拒。若报 native-identity/reparse，"
          + "说明 HANA_HOME 上有符号链接，本应用会先降级到 local-machine —— 那条路也需要单独声明并授权。",
      });
      return false;
    }

    // 就绪要等服务的 stdout 打出 marker，start() 本身是立即返回的。
    const ok = await waitReady(READY_TIMEOUT_MS);    _state = ok ? "ready" : "failed";
    if (!ok) {
      _lastFailureAt = Date.now();
      logError(`邮件后端服务未在 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒内就绪，邮件功能不可用`, { runtimeId: _runtimeId });
    } else {
      _lastFailureAt = 0;
      _consecutiveFailures = 0;
    }
    return ok;
  })().finally(() => { _starting = null; });

  return await _starting;
}

/** 服务是否可用（供 UI 显示状态）。 */
export function isServiceReady() {
  return _state === "ready";
}

async function waitReady(timeoutMs) {
  if (!_runtimeId || !_ctx) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let rec = null;
    try { rec = await _ctx.runtime.get(_runtimeId); } catch { /* 继续重试 */ }
    if (rec?.state === "ready") return true;
    if (rec?.state === "failed" || rec?.state === "exited" || rec?.state === "stopped") {
      // 把宿主捕获的服务输出一起报出来 —— 否则这里只剩一句“未就绪”，
      // 而真正的错因（入口路径、缺失文件、启动期异常）全在 rec.log 里。
      logError("邮件后端服务提前退出", {
        runtimeId: _runtimeId,
        state: rec.state,
        exitCode: rec.exitCode,
        signal: rec.signal,
        enforcement: rec.enforcement,
        output: String(rec.log || "").slice(-1500) || "(宿主未捕获到输出)",
      });
      return false;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** 停掉受管服务（apply 的 disposer 里调用）。 */
export async function stopService() {
  if (!_runtimeId || !_ctx) return;
  try {
    await _ctx.runtime.stop(_runtimeId);
    logInfo("邮件后端服务已停止");
  } catch (e) {
    logWarn("停止邮件后端服务失败", { error: e?.message });
  }
  _runtimeId = null;
  _state = "idle";
}

/**
 * 调一次服务。
 * @param {string} route 形如 "/cli"
 * @param {object} payload JSON 负载
 * @returns {Promise<object>} 服务返回的 JSON；失败时返回 { ok:false, error }
 */
export async function callService(route, payload = {}) {
  if (!_ctx) return { ok: false, error: "mail service unavailable（apply 尚未运行）" };

  // 惰性自愈：首次装载时权限可能还没记账（实测差约 190ms），那时 startService 被拒。
  // 第一次真调用时补起，用户就不必手动“重新加载”应用。
  if (_state !== "ready" || !_runtimeId) {
    const ok = await doStart();
    if (!ok) return { ok: false, error: "mail service unavailable（启动未成功）" };
  }

  let body;
  try {
    body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf-8") > MAX_BODY_BYTES) {
      // ponytail: 单次请求硬上限 1 MiB。超大邮件正文只截断送去总结/翻译，
      //          需要完整原文时按 messageId 分块取。
      return { ok: false, error: "payload too large for runtime bridge" };
    }
  } catch (e) {
    return { ok: false, error: "payload not serializable: " + e.message };
  }

  try {
    const res = await _ctx.runtime.fetch(_runtimeId, route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      timeoutMs: SERVICE_FETCH_TIMEOUT_MS,
    });

    // ctx.runtime.fetch 返回的是**真正的 Response 对象**（宿主内部 new Response(...)），
    // 不是字符串也不是 JSON。取 res.body 会拿到 ReadableStream —— JSON.parse 必败，
    // 实测报“service returned non-json”。必须走 res.text()/res.json()。
    let text;
    if (typeof res === "string") text = res;
    else if (typeof res?.text === "function") text = await res.text();
    else if (typeof res?.json === "function") text = JSON.stringify(await res.json());
    else text = String(res ?? "");

    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: "service returned non-json", raw: String(text).slice(0, 300) };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
