/**
 * lib/env.mjs — App 身份与路径的单一来源。
 *
 * v2 与 v1 的两处硬差异在这里一次收敛：
 *   1) 安装目录在 v2 是只读的 → 一切运行时写入必须落到 ctx.dataDir。
 *      老代码到处写 `backend/data/`，那是安装目录内的路径。
 *   2) `ctx.dataDir` 在 v2 已经是「本 App 专属目录」，不再需要 `join(dataDir, pluginId)`。
 *      但 v1 的调用点全都写成了 `path.join(ctx.dataDir, ctx.pluginId)`
 *      （共 15 处），所以这里反过来把 dataDir 报成「它的父目录」，
 *      让那条老表达式继续解析到同一个真实位置 —— 见 lib/legacy-ctx.js。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 应用 id：必须与 manifest.json 的 id 一致。 */
export const APP_ID = "hanako-mail";

/** App 包根目录（= 安装目录，只读）。'lib/env.mjs' -> '..' */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 后端脚本目录。 */
export const BACKEND_DIR = path.join(PLUGIN_ROOT, "backend");

/**
 * 运行时数据目录（可写）。
 *
 * 由 index.js 的 apply() 在启动任何东西之前写入 HANAKO_PLUGIN_DATA，
 * 因此 AppHost 与受管服务看到的是同一个目录。
 *
 * 回退顺序经过一次教训：AppHost 的 env 是宿主的白名单（只有 PATH/HOME/TMPDIR/LANG），
 * 所以 `USERPROFILE` 在这里**不保证存在** —— 能靠 `ctx.dataDir` 就别靠环境变量。
 */
export function runtimeDataDir() {
  return process.env.HANAKO_PLUGIN_DATA
    || path.join(process.env.HANA_HOME || path.join(process.env.USERPROFILE || "", ".hanako"), "app-data", APP_ID);
}

/**
 * v1 时代的数据目录（迁移来源）。
 *
 * 优先从本 App 的数据目录**反推** HANA_HOME，而不是读环境变量：
 * `ctx.dataDir` 形如 `<HANA_HOME>/app-data/<id>`，取两层 dirname 即得 HANA_HOME。
 * 这条路径在 AppHost 的白名单 env 下也成立。
 */
export function legacyDataDir() {
  const dataDir = process.env.HANAKO_PLUGIN_DATA;
  if (dataDir) {
    const home = path.dirname(path.dirname(dataDir));
    if (home && home !== dataDir) return path.join(home, "plugin-data", APP_ID, APP_ID);
  }
  const home = process.env.HANA_HOME || path.join(process.env.USERPROFILE || "", ".hanako");
  return path.join(home, "plugin-data", APP_ID, APP_ID);
}

/** HANA_HOME（本 App 数据目录的上两级）。 */
export function hanakoHome() {
  const dataDir = process.env.HANAKO_PLUGIN_DATA;
  if (dataDir) return path.dirname(path.dirname(dataDir));
  return process.env.HANA_HOME || path.join(process.env.USERPROFILE || "", ".hanako");
}
