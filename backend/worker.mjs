/**
 * worker.mjs — 常驻后端 Worker（替代「每次 API 调用冷启 node 子进程」）
 *
 * 通过 stdin/stdout 与宿主（routes/tools 所在的 Hana 进程）通信：
 *   请求（stdin 一行一个 JSON）：
 *     {"id":1, "type":"cli", "cmd":"list", "args":["user@example.com","--limit=20"], "env":{...}}
 *     {"id":2, "type":"ping"}
 *   响应（stdout 一行一个 JSON）：
 *     {"id":1, "ok":true, "data":{...}}
 *     {"id":1, "ok":false, "error":"..."}
 *   就绪信号：启动后先发 {"type":"ready"}（客户端等待它再放行请求）
 *
 * 关键设计：
 * - 复用 inbox.mjs 的 COMMANDS / parseOptions（同一张命令表，与 CLI 行为一致）
 * - 每个请求前重置账号缓存（resetAccountCache）+ 注入该账号的凭据 env；
 *   env 应用与命令入口的同步段在 Node 单线程内原子完成，不同账号并发请求安全
 *   （IMAP 配置在连接构造时即固化，之后不再读 process.env）
 * - 日志一律走 stderr，stdout 只承载协议，避免污染
 */

import { createInterface } from "node:readline";
import * as inbox from "./inbox.mjs";

const rl = createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch { /* ignore */ }
}

function applyEnv(env) {
  if (env && typeof env === "object") {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined || v === null) continue;
      process.env[k] = String(v);
    }
  }
}

async function dispatch(req) {
  // 心跳 / 健康检查
  if (req.type === "ping") return { ok: true, data: "pong" };

  if (req.type === "cli") {
    const cmd = req.cmd;
    const handler = inbox.COMMANDS[cmd];
    if (!handler) {
      return { ok: false, error: `unknown command: ${cmd}` };
    }
    // 注入账号凭据 + 清缓存（保证 env 变更即刻生效）
    applyEnv(req.env);
    inbox.resetAccountCache();
    const result = await handler(req.args || []);
    return { ok: true, data: result };
  }

  return { ok: false, error: `unknown request type: ${req.type}` };
}

// 就绪信号
send({ type: "ready" });

rl.on("line", (line) => {
  const trimmed = String(line).trim();
  if (!trimmed) return;
  let req;
  try { req = JSON.parse(trimmed); } catch { return; }
  if (!req || req.id === undefined) return;

  dispatch(req).then(
    (r) => send({ id: req.id, ok: !!r.ok, data: r.data, error: r.error }),
    (err) => send({ id: req.id, ok: false, error: String((err && err.message) || err) })
  );
});

// 优雅退出
function shutdown(code = 0) {
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGBREAK", () => shutdown(0)); // Windows Ctrl+Break

process.on("uncaughtException", (e) => {
  process.stderr.write(`[worker] uncaughtException: ${e && e.stack || e}\n`);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`[worker] unhandledRejection: ${e && e.stack || e}\n`);
});
