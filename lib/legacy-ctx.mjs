/**
 * lib/legacy-ctx.mjs — 把 v2 的 App ctx 投影成 v1 插件 ctx 的形状。
 *
 * 为什么需要它：`http/ui.js`、`tools/*.js`、`backend/*.mjs` 共 1900+ 行，
 * 里面只有 5 类 ctx 成员（pluginDir / log / pluginId / bus / dataDir）。
 * 与其把这些调用点散落改一遍（改错一处就是一个新 bug），不如在一个地方做投影：
 *
 *   v1 写法                                  v2 真身
 *   ───────────────────────────────────────  ────────────────────────────
 *   path.join(ctx.dataDir, ctx.pluginId)  →  ctx.dataDir（v2 已是 App 专属目录）
 *   ctx.pluginDir                         →  App 包根目录（安装目录，只读）
 *   ctx.pluginId                          →  manifest 的 id
 *   ctx.log.info/warn/error               →  ctx.logger（吞掉 Promise，老代码不 await）
 *   ctx.bus                               →  ctx.bus（同名同义）
 *
 * dataDir 那个「反向偏移」是刻意的：老代码写的是 join(dataDir, pluginId)，
 * 所以这里把 dataDir 报成父目录，让那条表达式原样解析到真实的 App 数据目录。
 * 新代码请直接用 ctx.dataDir，不要走这个投影。
 */

import path from "node:path";
import { APP_ID, PLUGIN_ROOT } from "./env.mjs";

/**
 * 把 logger 包装成「调用即忘、绝不抛」的 v1 风格 log。
 *
 * 一个必须注意的差异：v2 的 `ctx.logger.info(format, ...param)` 把额外参数交给
 * 宿主的格式器，实测不会落到日志行里（只打 format）。v1 的 `ctx.log.*(msg, data)`
 * 则是把 data 一起打出来。所以这里自己把参数拼进字符串，
 * 否则 `log.warn("启动失败", { error })` 会变成半句话——排查时等于没有。
 */
function stringify(v) {
  if (v instanceof Error) return v.message;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function makeLog(logger) {
  const call = (level) => (msg, ...rest) => {
    try {
      const fn = logger?.[level];
      if (typeof fn !== "function") return;
      const text = rest.length ? `${msg} ${rest.map(stringify).join(" ")}` : String(msg);
      // v2 的 logger 方法返回 Promise；老代码不会 await，必须自己兜住 rejection。
      const r = fn.call(logger, text);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch { /* 日志失败不影响业务 */ }
  };
  return {
    info: call("info"),
    warn: call("warn"),
    error: call("error"),
    debug: call("debug"),
  };
}

/**
 * @param {object} ctx v2 App ctx
 * @returns {object} 兼具 v1 成员与 v2 真实成员的投影对象
 */
export function legacyCtx(ctx) {
  const real = ctx.dataDir || process.env.HANAKO_PLUGIN_DATA || "";
  return {
    // ── v2 真实成员：原样透传，新代码用这些 ──
    ...ctx,
    appId: APP_ID,

    // ── v1 投影 ──
    pluginId: path.basename(real) || APP_ID,
    pluginDir: PLUGIN_ROOT,
    dataDir: path.dirname(real),
    log: makeLog(ctx.logger),
  };
}
