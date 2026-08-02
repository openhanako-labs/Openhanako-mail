#!/usr/bin/env node
/**
 * 清理脚本：释放被后台进程占用的插件目录锁，使插件可被正常删除。
 *
 * 使用场景：
 *   - 插件卸载时 onunload 未触发（IDE 异常退出等），ws-monitor 进程残留
 *   - 直接删除插件文件夹时提示"文件被占用 / 权限不足"
 *
 * 用法：
 *   node cleanup.cjs            释放后台进程占用（推荐先跑这个）
 *   node cleanup.cjs --delete  释放占用后顺便删除 backend/ 目录残留
 *
 * 注意：本脚本不删除插件根目录本身，删除动作请在 IDE/文件管理器中进行。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BACKEND_DIR = path.join(__dirname, "backend");
const DATA_DIR = path.join(BACKEND_DIR, "data");
const PID_FILES = [
  path.join(DATA_DIR, ".ws-monitor.pid"),
  path.join(DATA_DIR, ".worker.pid"),
  path.join(DATA_DIR, ".imap-idle.pid"),
];
// 需要清理的后台进程标记（命令行含这些片段即命中）
const PROC_MARKERS = ["ws-monitor.mjs", "worker.mjs", "imap-idle.mjs"];

function log(msg) {
  console.log("[cleanup] " + msg);
}

// 跨平台查找命令行含标记（ws-monitor / worker）的 node 进程 pid
function findProcPids() {
  const pids = new Set();
  try {
    if (process.platform === "win32") {
      const out = spawnSync("wmic", ["process", "where", "name='node.exe'", "get", "processid,commandline", "/format:csv"], { encoding: "utf8", windowsHide: true });
      const lines = (out.stdout || "").split(/\r?\n/);
      for (const line of lines) {
        if (PROC_MARKERS.some((m) => line.includes(m))) {
          const cols = line.split(",");
          const pid = cols[cols.length - 1]?.trim();
          if (pid && /^\d+$/.test(pid)) pids.add(pid);
        }
      }
    } else {
      const out = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
      const lines = (out.stdout || "").split(/\r?\n/);
      for (const line of lines) {
        if (PROC_MARKERS.some((m) => line.includes(m))) {
          const pid = line.trim().split(/\s+/)[0];
          if (pid && /^\d+$/.test(pid)) pids.add(pid);
        }
      }
    }
  } catch (e) {
    log("扫描进程失败：" + e.message);
  }
  return [...pids];
}

function killPid(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(Number(pid), "SIGKILL");
    }
    log("已终止进程 " + pid);
  } catch (e) {
    log("终止进程 " + pid + " 失败：" + e.message);
  }
}

// 1) 按 pid 文件杀（ws-monitor + worker）
let killedByPidFile = false;
for (const PID_FILE of PID_FILES) {
  if (fs.existsSync(PID_FILE)) {
    const pid = fs.readFileSync(PID_FILE, "utf8").trim();
    if (pid && /^\d+$/.test(pid)) {
      log("发现 pid 文件，终止占用进程 " + pid);
      killPid(pid);
      killedByPidFile = true;
    }
    try { fs.unlinkSync(PID_FILE); } catch {}
  }
}

// 2) 兜底：扫描所有 node 进程，杀掉命令行含 ws-monitor.mjs / worker.mjs 的
const pids = findProcPids();
if (pids.length === 0 && !killedByPidFile) {
  log("未发现残留的后台进程（ws-monitor / worker），无需清理");
} else {
  for (const pid of pids) killPid(pid);
  log("后台进程已清理，现在可以正常删除插件了");
}

// 3) 可选：删除 backend/ 目录残留
if (process.argv.includes("--delete")) {
  if (fs.existsSync(BACKEND_DIR)) {
    try {
      fs.rmSync(BACKEND_DIR, { recursive: true, force: true });
      log("已删除 backend/ 目录");
    } catch (e) {
      log("删除 backend/ 失败：" + e.message + "（可能仍有其它进程占用，请关闭后重试）");
    }
  }
}

log("完成");
