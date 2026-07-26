import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export default class HanakoMailPlugin {
  async onload() {
    const ctx = this.ctx;
    ctx.log?.info?.("hanako-mail loaded", { pluginId: ctx.pluginId });

    const missing = checkDeps();
    if (missing.length > 0) {
      ctx.log?.warn?.("hanako-mail: 后端依赖缺失", { missing, hint: "cd backend && npm install" });
    }
  }

  async onunload() {
    this.ctx.log?.info?.("hanako-mail unloaded");
  }
}