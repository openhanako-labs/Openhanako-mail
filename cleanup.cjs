#!/usr/bin/env node
/**
 * cleanup.cjs — 排查残留的邮件后端进程。
 *
 * v0.3.0 起架构变了：AppHost 不再自己 spawn 常驻子进程，改由宿主托管一个
 * native 服务（runtime/service.mjs）。那个进程的生命周期归宿主，
 * **正常情况完全用不到这个脚本**。
 *
 * 保留它是为了两种极端情况：
 *   - 宿主异常退出，托管进程成了孤儿，占着 app-data 里的日志/缓存文件
 *   - 手工删除安装目录时提示"文件被占用"
 *
 * 用法：
 *   node cleanup.cjs          列出并终止残留的服务进程
 *   node cleanup.cjs --list   只看，不动手
 *
 * 注意：本脚本不删除任何目录。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// 残留进程的命令行特征：托管服务的入口脚本
const PROC_MARKERS = ["runtime/service.mjs", "runtime\\service.mjs"];

function log(msg) {
  console.log("[cleanup] " + msg);
}

function findPids() {
  const pids = new Set();
  try {
    if (process.platform === "win32") {
      // wmic 在新系统上可能已移除，优先用 PowerShell 的 CIM
      const out = spawnSync(
        "powershell",
        ["-NoProfile", "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
        { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
      for (const line of (out.stdout || "").split(/\r?\n/)) {
        if (!PROC_MARKERS.some((m) => line.includes(m))) continue;
        const pid = line.split("\t")[0]?.trim();
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
    } else {
      const out = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
      for (const line of (out.stdout || "").split(/\r?\n/)) {
        if (!PROC_MARKERS.some((m) => line.includes(m))) continue;
        const pid = line.trim().split(/\s+/)[0];
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
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

const pids = findPids();
const listOnly = process.argv.includes("--list");

if (pids.length === 0) {
  log("未发现残留的邮件后端服务进程，无需清理");
  process.exit(0);
}

log(`发现 ${pids.length} 个残留进程：${pids.join(", ")}`);
if (listOnly) {
  log("（--list：只看不动手）");
  process.exit(0);
}

for (const pid of pids) killPid(pid);
log("清理完成。若进程反复出现，说明宿主仍在托管它 —— 请在「已安装」页停用/重新加载该应用，而不是反复杀进程。");
