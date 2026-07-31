import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, "backend");
const DATA_DIR = path.join(BACKEND_DIR, "data");
const WS_MONITOR_PATH = path.join(BACKEND_DIR, "ws-monitor.mjs");

function checkDeps() {
  const missing = [];

  // 直接从 backend/package.json 读取依赖清单，保证与声明完全一致
  // （避免手写枚举漏掉部分依赖，导致 node_modules 部分残留时漏装）
  let manifest;
  try {
    const pkgPath = path.join(BACKEND_DIR, "package.json");
    manifest = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    // 读不到清单就不自动安装，避免误判
    return [];
  }

  const deps = Object.keys(manifest.dependencies || {});
  for (const dep of deps) {
    // 作用域包 @scope/name -> node_modules/@scope/name/package.json
    const rel = dep.startsWith("@")
      ? path.join("node_modules", dep.split("/")[0], dep.split("/")[1])
      : path.join("node_modules", dep);
    const pkgJson = path.join(BACKEND_DIR, rel, "package.json");
    if (!fs.existsSync(pkgJson)) missing.push(dep);
  }

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

let wsMonitorProc = null;
let wsMonitorShutdown = false;
const WS_PID_FILE = path.join(DATA_DIR, ".ws-monitor.pid");

function writeWsPid(pid) {
  try { fs.writeFileSync(WS_PID_FILE, String(pid)); } catch {}
}
function clearWsPid() {
  try { fs.unlinkSync(WS_PID_FILE); } catch {}
}

function killWsTree(proc) {
  if (!proc || proc.pid == null) return;
  const pid = proc.pid;
  try {
    // 优先 SIGTERM（Linux/Mac 走 ws-monitor 优雅退出 handler）
    proc.kill("SIGTERM");
  } catch {}
  // Windows 兜底：强制杀整棵进程树（TerminateProcess 不触发 handler，但能立刻腾出文件锁）
  if (process.platform === "win32") {
    try {
      const { spawnSync } = require("node:child_process");
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {}
  }
}

function startWsMonitor(pluginDataDir) {
  if (wsMonitorShutdown) return; // 已卸载，不再拉起
  if (wsMonitorProc) return; // 已在运行
  try {
    const env = { ...process.env };
    // 传入与 routes/tools 一致的 plugin-data 目录，否则 ws-monitor 读不到 accounts.json、
    // 实时监听账号为空 → 实时收件/通知整体失效（审计发现的结构性错位，F3）
    if (pluginDataDir) env.HANAKO_PLUGIN_DATA = pluginDataDir;
    const proc = spawn(process.execPath, [WS_MONITOR_PATH], {
      cwd: BACKEND_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env,
    });
    wsMonitorProc = proc;
    writeWsPid(proc.pid);
    proc.stdout?.on("data", (d) => console.log("[ws-monitor]", d.toString().trim()));
    proc.stderr?.on("data", (d) => console.warn("[ws-monitor]", d.toString().trim()));
    proc.on("close", (code) => {
      wsMonitorProc = null;
      clearWsPid();
      if (wsMonitorShutdown) {
        console.log("[ws-monitor] 已随插件卸载退出，不再重启");
        return;
      }
      console.warn(`[ws-monitor] 退出: ${code}，10秒后重启...`);
      setTimeout(startWsMonitor, 10000);
    });
    proc.on("error", (e) => {
      wsMonitorProc = null;
      clearWsPid();
      if (wsMonitorShutdown) return;
      console.warn("[ws-monitor] 启动失败", { error: e.message });
      setTimeout(startWsMonitor, 30000);
    });
  } catch (e) {
    console.warn("[ws-monitor] 无法启动", { error: e.message });
  }
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

    // 启动 WebSocket 实时收件监听（传入 plugin-data 目录，确保与 routes/tools 共用同一账号缓存）
    wsMonitorShutdown = false;
    const pluginDataDir = (ctx.dataDir && ctx.pluginId) ? path.join(ctx.dataDir, ctx.pluginId) : "";
    startWsMonitor(pluginDataDir);
  }

  async onunload() {
    const ctx = this.ctx;
    ctx.log?.info?.("hanako-mail unloaded");
    wsMonitorShutdown = true;
    if (wsMonitorProc) {
      killWsTree(wsMonitorProc);
      wsMonitorProc = null;
    }
    clearWsPid();
  }
}