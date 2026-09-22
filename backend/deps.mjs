/**
 * backend/deps.mjs — 后端依赖是否齐全的**唯一判定**。
 *
 * 清单来源只有一个：`backend/package.json` 的 `dependencies`。
 * 不再维护任何手写清单 —— 手写的会烂。
 *
 * 为什么要单独抽出来：
 * 0.6.0 把 `imap`（node-imap）换成 `imapflow` 时，`runtime/service.mjs` 那边
 * 写对了（从 package.json 推导），但 `http/ui.js` 里另有两份**硬编码**清单
 * （`checkBackendDeps` 与 `/deps-status`）仍然在找 `node_modules/imap/package.json`。
 * 依赖其实齐着，而同步被一条 "IMAP 依赖未安装" 的化石提示整条挡住。
 *
 * 教训：同一件事的**检查点往往不止一处**。换依赖时改了一处探针不算改完。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 返回 backend/package.json 里声明了、但 node_modules 里不存在的依赖名。
 * 读不到 package.json 时返回空数组（不把"读不到"误报成"依赖缺失"）。
 *
 * @param {string} backendDir 后端目录（含 package.json 与 node_modules）
 * @returns {string[]}
 */
export function missingBackendDeps(backendDir) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(backendDir, "package.json"), "utf-8"));
  } catch {
    return [];
  }

  const missing = [];
  for (const dep of Object.keys(manifest.dependencies || {})) {
    // scoped 包（@scope/name）在 node_modules 下是两层目录
    const segs = dep.startsWith("@") ? [dep.split("/")[0], dep.split("/")[1]] : [dep];
    if (!segs[segs.length - 1]) continue;
    if (!fs.existsSync(path.join(backendDir, "node_modules", ...segs, "package.json"))) {
      missing.push(dep);
    }
  }
  return missing;
}
