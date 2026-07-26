import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, "backend");
const SDK_CHECK = path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk");

function ensureDeps(ctx) {
  if (fs.existsSync(SDK_CHECK)) {
    ctx.log?.info?.("hanako-mail: deps already installed");
    return;
  }

  ctx.log?.info?.("hanako-mail: installing backend dependencies...");

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const proc = execFile(npm, ["install", "--no-fund", "--no-audit"], {
    cwd: BACKEND_DIR,
    timeout: 60000,
    windowsHide: true,
  }, (err, stdout, stderr) => {
    if (err) {
      ctx.log?.warn?.("hanako-mail: npm install failed", {
        error: err.message,
        stderr: stderr?.slice(0, 500),
      });
      return;
    }
    ctx.log?.info?.("hanako-mail: deps installed successfully");
  });

  proc.stdout?.on("data", (chunk) => ctx.log?.debug?.("npm:", chunk.toString().trim()));
  proc.stderr?.on("data", (chunk) => ctx.log?.debug?.("npm:", chunk.toString().trim()));
}

export default class HanakoMailPlugin {
  async onload() {
    const ctx = this.ctx;
    ctx.log?.info?.("hanako-mail loaded", { pluginId: ctx.pluginId });
    ensureDeps(ctx);
  }

  async onunload() {
    this.ctx.log?.info?.("hanako-mail unloaded");
  }
}