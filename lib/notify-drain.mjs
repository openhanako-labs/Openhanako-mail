/**
 * lib/notify-drain.mjs — 把服务排队的桌面通知派发出去。
 *
 * 为什么需要这一层：Windows 通知必须拉起一个进程，而**受管 native 服务不能 spawn**
 * （Job Object，实测 spawn EPERM）。反过来 AppHost 有 `--allow-child-process`，
 * 但 AppHost 不跑收件监听、收不到新邮件事件。
 *
 * 所以分成两半：
 *   服务（收得到邮件、但不能 spawn）→ 把要发的通知写进 `<dataDir>/_pending_notify/`
 *   AppHost（能 spawn、但收不到事件）→ 定时向服务取队列并拉起 mail-toast.cjs
 *
 * 5 秒一轮，所以通知延迟最多 5 秒 —— 比原来 60 秒的轮询兜底更快，
 * 也避免了“实时监听秒级、通知却慢一分钟”的割裂。
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { callService } from "./runtime-host.mjs";
import { PLUGIN_ROOT, runtimeDataDir } from "./env.mjs";

const POLL_MS = 5000;
const TOAST_SCRIPT = path.join(PLUGIN_ROOT, "helper", "mail-toast.cjs");
const TOAST_NODE_PATH = path.join(PLUGIN_ROOT, "backend", "node_modules");

let timer = null;

function spawnToast(item) {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(TOAST_SCRIPT)) { resolve({ ok: false, error: "mail-toast.cjs missing" }); return; }
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const argsFile = path.join(runtimeDataDir(), `notify-args-${id}.json`);
      fs.writeFileSync(argsFile, JSON.stringify(item), "utf-8");
      execFile(process.execPath, [TOAST_SCRIPT, "--args-file", argsFile], {
        cwd: PLUGIN_ROOT,
        windowsHide: true,
        timeout: 20000,
        // AppHost 本身在权限模型里，但本进程只允许 spawn（--allow-child-process）；
        // 子进程要读 mail-toast.cjs 与 node-notifier，那条路径在只读白名单内。
        env: { ...process.env, NODE_PATH: TOAST_NODE_PATH },
      }, (err) => {
        try { fs.unlinkSync(argsFile); } catch { /* ignore */ }
        resolve(err ? { ok: false, error: err.message } : { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/** 取一轮队列并派发。 */
async function drainOnce(log) {
  const res = await callService("/pending-notify", { limit: 10 });
  if (!res?.ok || !Array.isArray(res.items) || res.items.length === 0) return 0;
  let sent = 0;
  for (const item of res.items) {
    const r = await spawnToast(item);
    if (r.ok) sent++;
    else log.warn("桌面通知发送失败", { error: r.error, subject: item?.subject });
  }
  return sent;
}

export function startNotificationDrain(log) {
  if (timer) return;
  timer = setInterval(() => {
    drainOnce(log).catch(() => { /* 下一轮再试 */ });
  }, POLL_MS);
  // 不要因为这个定时器把宿主进程吊住
  if (typeof timer.unref === "function") timer.unref();
  log.info("桌面通知派发已启动", { intervalMs: POLL_MS });
}

export function stopNotificationDrain() {
  if (timer) { clearInterval(timer); timer = null; }
}
