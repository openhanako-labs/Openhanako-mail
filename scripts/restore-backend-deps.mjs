/**
 * scripts/restore-backend-deps.mjs — 恢复 backend 运行时依赖。
 *
 * 背景（2026-09-20 实测）：这个 App 的 backend 依赖不随仓库发布，
 * 更新 App（原地替换安装目录）会把 backend/node_modules 整个清掉。
 * 而依赖本应由 runtime/service.mjs 自己装（它有能力 spawn + 出网），
 * 可服务起不来的时候这条自愈链路是断的 —— 于是「依赖缺失」和
 * 「服务起不来」互相卡住。
 *
 * 用法（在仓库根目录，用自己的终端跑，别在 AppHost 里跑 —— AppHost 没有出网）：
 *
 *   npm run deps
 *   # 或
 *   node scripts/restore-backend-deps.mjs
 *
 * 只检查缺什么，不重复安装已经齐全的依赖。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BACKEND = path.join(ROOT, "backend");
const NM = path.join(BACKEND, "node_modules");

const pkgPath = path.join(BACKEND, "package.json");

if (!fs.existsSync(pkgPath)) {
  console.error(`✗ 找不到 ${pkgPath}`);
  process.exit(1);
}

const deps = Object.keys(JSON.parse(fs.readFileSync(pkgPath, "utf-8")).dependencies || {});
const missing = deps.filter((d) => !fs.existsSync(path.join(NM, d)));

console.log(`仓库根:   ${ROOT}`);
console.log(`依赖目录: ${NM}`);
console.log(`声明依赖: ${deps.length} 项`);

if (missing.length === 0) {
  console.log("✓ backend 依赖齐全，无需安装。");
  process.exit(0);
}

console.log(`✗ 缺失 ${missing.length} 项: ${missing.join(", ")}`);
console.log("");
console.log("正在执行 npm ci --prefix backend ...");
console.log("（需要出网。此脚本请在你自己的终端里跑，不要在 Hana 里跑 —— AppHost 没有网络权限。）");

const r = spawnSync("npm", ["ci", "--prefix", BACKEND], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (r.error || r.status !== 0) {
  console.error("");
  console.error("✗ npm ci 失败。手工恢复：");
  console.error(`    cd ${BACKEND}`);
  console.error("    npm ci");
  process.exit(r.status ?? 1);
}

const stillMissing = deps.filter((d) => !fs.existsSync(path.join(NM, d)));
if (stillMissing.length) {
  console.error(`✗ 安装后仍缺失: ${stillMissing.join(", ")}`);
  process.exit(1);
}

console.log(`✓ backend 依赖恢复完成（${deps.length} 项）。重新加载 hanako-mail 后生效。`);
