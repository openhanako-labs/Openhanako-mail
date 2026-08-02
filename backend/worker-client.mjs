/**
 * worker-client.mjs — 常驻 Worker 的宿主侧客户端
 *
 * 职责：
 * - 懒启动 backend/worker.mjs（模块级单例，所有请求共享同一 worker 进程）
 * - 等待 worker 就绪信号后放行请求
 * - 每请求经 stdin 发 JSON，按 id 匹配响应（支持并发）
 * - worker 崩溃自动重启（指数退避）、pending 请求拒绝
 * - 提供 runCli(cmd, args, env) —— 与旧 runInbox 语义一致，调用点无需改动
 *
 * 使用：
 *   import * as worker from "./worker-client.mjs";
 *   const data = await worker.runCli("list", ["user@x.com", "--limit=20"], env);
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker.mjs");
const PID_FILE = path.join(__dirname, "data", ".worker.pid");

let proc = null;            // 当前 worker 子进程
let starting = null;        // 启动中 promise（防并发重复启动）
let nextId = 1;
const pending = new Map();  // id -> { resolve, reject, timer }
let shuttingDown = false;
let restartDelay = 1000;    // 崩溃重启退避（1s 起步，上限 30s）
const READY_TIMEOUT = 15000;

function log(...a) {
  console.log("[worker-client]", ...a);
}

function writePid(pid) {
  try { fs.writeFileSync(PID_FILE, String(pid), "utf-8"); } catch {}
}
function clearPid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function rejectAllPending(message) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
  pending.clear();
}

function spawnWorker() {
  const p = spawn(process.execPath, [WORKER_PATH], {
    cwd: __dirname,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: { ...process.env },
  });

  const rl = createInterface({ input: p.stdout, terminal: false });
  let readyResolve = null;
  let readyReject = null;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => { readyReject(new Error("worker 就绪超时")); }, READY_TIMEOUT);

  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // 就绪信号
    if (msg && msg.type === "ready") {
      clearTimeout(readyTimer);
      readyResolve && readyResolve(p);
      readyResolve = null;
      return;
    }
    // 请求响应
    if (msg && msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.ok) resolve(msg.data);
      else reject(new Error(msg.error || "worker error"));
    }
  });

  p.stderr.on("data", (d) => {
    const text = d.toString();
    // worker 日志直接透传到宿主控制台，前缀保留
    process.stderr.write(text.endsWith("\n") ? text : text + "\n");
  });

  p.on("exit", (code, signal) => {
    clearTimeout(readyTimer);
    readyReject && readyReject(new Error(`worker 启动即退出: ${code ?? signal}`));
    readyReject = null;
    if (proc === p) {
      proc = null;
      clearPid();
      rejectAllPending(`worker 进程退出（code=${code ?? signal}）`);
      if (!shuttingDown) {
        log(`worker 退出(code=${code ?? signal})，${restartDelay}ms 后重启`);
        setTimeout(() => {
          restartDelay = Math.min(restartDelay * 2, 30000);
          ensureWorker().catch((e) => log("重启失败", e.message));
        }, restartDelay);
      }
    }
  });

  p.on("error", (err) => {
    readyReject && readyReject(err);
    readyReject = null;
    log("worker spawn 错误", err.message);
  });

  return { proc: p, ready: readyPromise };
}

function ensureWorker() {
  if (proc && proc.exitCode === null && !proc.killed && proc.stdin && !proc.stdin.destroyed) {
    return Promise.resolve(proc);
  }
  if (starting) return starting;
  starting = spawnWorker().ready
    .then((p) => {
      proc = p;
      writePid(p.pid);
      restartDelay = 1000; // 成功连接后重置退避
      return p;
    })
    .finally(() => { starting = null; });
  return starting;
}

/**
 * 以 CLI 风格调用 worker（与旧 execFile runInbox 语义一致）。
 * @param {string} cmd  命令名（inbox.mjs COMMANDS 的 key：list/read/send/reply/...）
 * @param {string[]} args  CLI 参数数组（含 email 与 --key=value）
 * @param {object} [env]  该账号的凭据环境变量（透传给 worker 注入 process.env）
 * @param {number} [timeoutMs] 请求超时（默认 90s，附件 base64 较大）
 * @returns {Promise<any>} worker 返回的数据
 */
export async function runCli(cmd, args, env, timeoutMs = 90000) {
  const p = await ensureWorker();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`worker 请求超时（${timeoutMs}ms）: ${cmd}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const msg = { id, type: "cli", cmd, args: args || [], env: env || {} };
    try {
      p.stdin.write(JSON.stringify(msg) + "\n");
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

/** 健康检查（自测/诊断用）。 */
export async function ping(timeoutMs = 5000) {
  const p = await ensureWorker();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("worker ping 超时"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { p.stdin.write(JSON.stringify({ id, type: "ping" }) + "\n"); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
}

/** 主动关闭 worker（插件卸载时调用）。 */
export function shutdownWorker() {
  shuttingDown = true;
  if (proc && proc.stdin && !proc.stdin.destroyed) {
    try { proc.stdin.end(); } catch {}
    // 给 worker 一点时间自行退出，超时强杀
    setTimeout(() => {
      try { if (proc && proc.exitCode === null) proc.kill("SIGTERM"); } catch {}
    }, 300);
  }
  proc = null;
  clearPid();
}

// 便于自动化扫描识别：worker 常驻进程会带本文件路径信息
export const WORKER_PROCESS_MARKER = "worker.mjs";
