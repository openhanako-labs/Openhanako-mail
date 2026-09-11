/**
 * worker-client.mjs — 邮件后端命令的宿主侧客户端（v0.3.0 起：走受管服务）。
 *
 * 历史：v1 与 v2 早期是「AppHost 里 spawn 一个 node 子进程，用 stdin/stdout 传 JSON」。
 * 那条路在 v2 已经死了 —— AppHost 及其子进程都在 Node 权限模型里，没有出站网络，
 * 于是 IMAP/SMTP/ClawEmail 全部连不上（见 runtime/service.mjs 顶部注释）。
 *
 * 现在：所有命令转发给受管的 native 服务，由它执行 inbox 的命令表。
 * **runCli 的签名与返回语义保持不变**，所以 tools/*.js 与 http/ui.js 的 30 多处
 * 调用点一个字都不用改。
 *
 * 注意：`runCli` 的第三个参数 `env` 仍然按账号注入凭据，但现在是在服务进程里
 * 对 `process.env` 生效 —— 服务是单进程串行处理请求，语义与原来的 worker 一致
 * （每请求前 resetAccountCache + 注入 env，连接在构造时固化）。
 */

import { callService } from "../lib/runtime-host.mjs";

/**
 * 执行一条 inbox 命令。
 * @param {string} cmd   命令名（inbox.mjs COMMANDS 的 key：list/read/send/reply/...）
 * @param {string[]} args CLI 风格参数数组（含 email 与 --key=value）
 * @param {object} [env] 该账号的凭据环境变量
 * @returns {Promise<any>} 命令返回的数据；失败抛 Error（与旧的 worker 语义一致）
 */
export async function runCli(cmd, args, env) {
  const res = await callService("/cli", { cmd, args: args || [], env: env || {} });
  if (!res || res.ok !== true) {
    throw new Error(res?.error || "mail backend unavailable");
  }
  return res.data;
}

/** 健康检查。 */
export async function ping() {
  const res = await callService("/health", {});
  if (res?.ok !== true) throw new Error(res?.error || "mail service not ready");
  return "pong";
}

/**
 * 关闭后端 —— 现在关的是受管服务，由 lib/runtime-host.mjs 的 stopService 负责，
 * 本函数保留为空操作以维持调用点兼容（index.js 的 disposer 会走到它）。
 */
export function shutdownWorker() {
  // 受管服务的生命周期归 apply() 的 disposer 管；这里什么都不用做。
}

// 便于自动化扫描识别（语义保留：本模块代表常驻后端）
export const WORKER_PROCESS_MARKER = "managed-mail-service";
