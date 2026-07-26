import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, "backend");

function checkDeps() {
  const missing = [];

  // ClawEmail SDK
  const sdkPath = path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk", "package.json");
  if (!fs.existsSync(sdkPath)) missing.push("@clawemail/node-sdk");

  // IMAP 依赖
  const imapPath = path.join(BACKEND_DIR, "node_modules", "imap", "package.json");
  if (!fs.existsSync(imapPath)) missing.push("imap");
  const nmPath = path.join(BACKEND_DIR, "node_modules", "nodemailer", "package.json");
  if (!fs.existsSync(nmPath)) missing.push("nodemailer");

  return missing;
}

function autoInstallDeps() {
  const lockFile = path.join(BACKEND_DIR, "node_modules", ".hanako-auto-install.lock");
  if (fs.existsSync(lockFile)) return; // 已在安装中或已安装过

  const missing = checkDeps();
  if (missing.length === 0) return;

  fs.writeFileSync(lockFile, Date.now().toString());
  execFile(process.execPath, ["-e", "", "--"], {
    cwd: BACKEND_DIR,
    windowsHide: true,
    timeout: 120000,
  });

  // 用 spawn 后台跑 npm install
  const proc = require("node:child_process").spawn("npm", ["install"], {
    cwd: BACKEND_DIR,
    windowsHide: true,
    stdio: "ignore",
  });

  proc.on("close", (code) => {
    try { fs.unlinkSync(lockFile); } catch {}
    if (code === 0) {
      console.log("[hanako-mail] 后端依赖自动安装成功");
    } else {
      console.warn("[hanako-mail] 后端依赖自动安装失败，请手动执行: cd backend && npm install");
    }
  });

  proc.on("error", () => {
    try { fs.unlinkSync(lockFile); } catch {}
    console.warn("[hanako-mail] 无法自动安装依赖，请手动执行: cd backend && npm install");
  });
}

export default class HanakoMailPlugin {
  async onload() {
    const ctx = this.ctx;
    ctx.log?.info?.("hanako-mail loaded", { pluginId: ctx.pluginId });

    const missing = checkDeps();
    if (missing.length > 0) {
      ctx.log?.warn?.("hanako-mail: 后端依赖缺失，尝试自动安装", { missing });
      autoInstallDeps();
    }
  }

  async onunload() {
    this.ctx.log?.info?.("hanako-mail unloaded");
  }
}