import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, "backend");
const DATA_DIR = path.join(BACKEND_DIR, "data");

function checkDeps() {
  const missing = [];

  // ClawEmail SDK
  const sdkPath = path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk", "package.json");
  if (!fs.existsSync(sdkPath)) missing.push("@clawemail/node-sdk");

  // mail-cli（用于 move/mark/folders 等）
  const mailCliPath = path.join(BACKEND_DIR, "node_modules", "@clawemail", "mail-cli", "package.json");
  if (!fs.existsSync(mailCliPath)) missing.push("@clawemail/mail-cli");

  // IMAP 依赖
  const imapPath = path.join(BACKEND_DIR, "node_modules", "imap", "package.json");
  if (!fs.existsSync(imapPath)) missing.push("imap");
  const nmPath = path.join(BACKEND_DIR, "node_modules", "nodemailer", "package.json");
  if (!fs.existsSync(nmPath)) missing.push("nodemailer");

  return missing;
}

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

let autoInstallCooldown = false;
function autoInstallDeps() {
  if (autoInstallCooldown) return;

  const lockFile = path.join(DATA_DIR, ".hanako-auto-install.lock");
  if (fs.existsSync(lockFile)) return; // 已在安装中或已安装过

  const missing = checkDeps();
  if (missing.length === 0) return;

  autoInstallCooldown = true;
  fs.writeFileSync(lockFile, Date.now().toString());

  // 用 spawn 后台跑 npm install（Windows 需要 shell: true 才能找到 npm.cmd）
  const proc = spawn("npm", ["install"], {
    cwd: BACKEND_DIR,
    windowsHide: true,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d) => { stdout += d.toString(); });
  proc.stderr?.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    autoInstallCooldown = false;
    try { fs.unlinkSync(lockFile); } catch {}
    if (code === 0) {
      console.log("[hanako-mail] 后端依赖自动安装成功");
    } else {
      console.warn("[hanako-mail] 后端依赖自动安装失败", { code, stderr: stderr.slice(-500) });
    }
  });

  proc.on("error", (e) => {
    autoInstallCooldown = false;
    try { fs.unlinkSync(lockFile); } catch {}
    console.warn("[hanako-mail] 无法自动安装依赖", { error: e.message });
  });
}

export default class HanakoMailPlugin {
  async onload() {
    const ctx = this.ctx;
    ctx.log?.info?.("hanako-mail loaded", { pluginId: ctx.pluginId });

    ensureDataDir();
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