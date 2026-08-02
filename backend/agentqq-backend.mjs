/**
 * AgentQQ 后端 — 封装 agently-cli
 *
 * 完整能力：list / search / read / send / reply / forward / attachment
 * 所有输出：{ ok: true, data: {...} }
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 解析 agently-cli 真实 JS 入口（绕过 .cmd shim，避免 shell 拼接注入） ──
// npm 安装的 agently-cli 是 Windows shim（.cmd），内部最终执行：
//   node "<dp0>\node_modules\@tencent-qqmail\agently-cli\scripts\run.js" %*
// 我们直接解析出 run.js 路径，用 spawn(node, [entry, ...args], {shell:false})
// 传参，用户可控参数（to/subject/body/keyword 等）不再经过 cmd.exe 解析，
// 从根本上消除命令注入（原实现用 \" 转义在 cmd.exe 下无效，可被 & | 等绕过）。
function resolveCliEntry() {
  // 1) 本地安装（backend/node_modules/...）
  const local = path.join(__dirname, "node_modules", "@tencent-qqmail", "agently-cli", "scripts", "run.js");
  if (fs.existsSync(local)) return local;
  // 2) 全局 npm shim：定位 agently-cli.cmd 并解析其指向的 run.js
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(which, ["agently-cli"], { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
    const first = String(out).split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (!first) return null;
    const cmdPath = /\.cmd$/i.test(first) ? first : `${first}.cmd`;
    if (!fs.existsSync(cmdPath)) return null;
    const content = fs.readFileSync(cmdPath, "utf-8");
    const m = content.match(/%dp0%\\node_modules\\([^"%\s]+)/i);
    if (m) {
      const p = path.join(path.dirname(cmdPath), "node_modules", m[1].trim());
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 继续走下方错误路径 */ }
  return null;
}

let _cliEntry = undefined;
function getCliEntry() {
  if (_cliEntry === undefined) _cliEntry = resolveCliEntry();
  return _cliEntry;
}

function runAgentlyCli(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const entry = getCliEntry();
    if (!entry) {
      return reject(new Error("未找到 agently-cli 入口（@tencent-qqmail/agently-cli 未安装或不在 PATH），请先执行: npm install -g agently-cli"));
    }
    // shell:false + 数组参数 → 用户输入永不进入 cmd.exe 解析，无注入面
    const proc = spawn(process.execPath, [entry, ...args], {
      encoding: "utf-8",
      timeout,
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`agently-cli exit ${code}: ${stderr.trim() || stdout.slice(-200)}`));
      }
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) resolve(JSON.parse(jsonMatch[0]));
        else reject(new Error(`agently-cli no JSON in output: ${stdout.slice(0, 200)}`));
      } catch (e) {
        reject(new Error(`agently-cli JSON parse failed: ${e.message}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`spawn agently-cli failed: ${err.message}`));
    });
  });
}

// ── 列表/搜索 ──────────────────────────────────────────

export async function listMessages(options = {}) {
  const { limit = 20, after, before, hasAttachments, isUnread, cursor } = options;
  const args = ["message", "+list"];
  if (limit) args.push(`--limit=${limit}`);
  if (after) args.push(`--after=${after}`);
  if (before) args.push(`--before=${before}`);
  if (hasAttachments !== undefined) args.push(`--has-attachments=${hasAttachments}`);
  if (isUnread !== undefined) args.push(`--is-unread=${isUnread}`);
  if (cursor) args.push(`--cursor=${cursor}`);

  const result = await runAgentlyCli(args);
  return result.data?.data || [];
}

export async function searchMessages(keyword, options = {}) {
  const { limit = 20, hasAttachments, isUnread } = options;
  const args = ["message", "+search", `--q=${keyword}`];
  if (limit) args.push(`--limit=${limit}`);
  if (hasAttachments !== undefined) args.push(`--has-attachments=${hasAttachments}`);
  if (isUnread !== undefined) args.push(`--is-unread=${isUnread}`);

  const result = await runAgentlyCli(args);
  return result.data?.data || [];
}

// ── 读取 ───────────────────────────────────────────────

export async function readMessage(messageId) {
  const result = await runAgentlyCli(["message", "+read", `--id=${messageId}`]);
  return result.data;
}

export async function downloadAttachment(messageId, attId, outputDir) {
  const result = await runAgentlyCli([
    "attachment", "+download",
    `--msg=${messageId}`,
    `--att=${attId}`,
    `--output=${outputDir}`,
  ]);
  return {
    savedTo: result.data?.saved_to,
    filename: result.data?.filename,
  };
}

export async function uploadAttachment(filePath) {
  const result = await runAgentlyCli([
    "attachment", "+upload",
    `--file=${filePath}`,
  ]);
  return result.data?.file_id;
}

// ── 发送/回复/转发 ─────────────────────────────────────

export async function sendMail(options) {
  const { to, cc, bcc, subject, body, bodyFormat = "text", fileIds = [] } = options;
  if (!to) throw new Error("sendMail: 'to' is required");
  if (!subject) throw new Error("sendMail: 'subject' is required");
  if (!body) throw new Error("sendMail: 'body' is required");

  const args = ["message", "+send"];
  for (const t of (Array.isArray(to) ? to : [to])) args.push(`--to=${t}`);
  if (cc) for (const c of (Array.isArray(cc) ? cc : [cc])) args.push(`--cc=${c}`);
  if (bcc) for (const b of (Array.isArray(bcc) ? bcc : [bcc])) args.push(`--bcc=${b}`);
  args.push(`--subject=${subject}`);
  args.push(`--body=${body}`);
  if (bodyFormat === "html") args.push(`--body-format=html`);
  for (const fid of fileIds.slice(0, 3)) args.push(`--attachment-file-id=${fid}`);

  const result = await runAgentlyCli(args);
  return result.data;
}

export async function replyToMail(messageId, options = {}) {
  const { body, bodyFormat = "text", replyAll = false, fileIds = [], confirmSend = false } = options;
  if (!body) throw new Error("replyToMail: 'body' is required");

  const args = ["message", "+reply", `--id=${messageId}`];
  if (replyAll) args.push("--reply-all");
  args.push(`--body=${body}`);
  if (bodyFormat === "html") args.push(`--body-format=html`);
  for (const fid of fileIds.slice(0, 3)) args.push(`--attachment-file-id=${fid}`);
  if (confirmSend) args.push("--confirm-send");

  const result = await runAgentlyCli(args);
  return result.data;
}

export async function forwardMail(messageId, options = {}) {
  const { to, body, includeAttachments = false, confirmSend = false, fileIds = [] } = options;
  if (!to) throw new Error("forwardMail: 'to' is required");

  const args = ["message", "+forward", `--id=${messageId}`];
  for (const t of (Array.isArray(to) ? to : [to])) args.push(`--to=${t}`);
  if (body) args.push(`--body=${body}`);
  if (includeAttachments) args.push("--include-attachments");
  for (const fid of (Array.isArray(fileIds) ? fileIds : []).slice(0, 3)) args.push(`--attachment-file-id=${fid}`);
  if (confirmSend) args.push("--confirm-send");

  const result = await runAgentlyCli(args);
  return result.data;
}

// ── 文件夹 ─────────────────────────────────────────────

export async function listFolders() {
  const result = await runAgentlyCli(["+me"]);
  return result.data;
}

// ── 标记已读 ───────────────────────────────────────────

export async function markRead(messageId, read = true) {
  if (read) {
    await runAgentlyCli(["message", "+read", `--id=${messageId}`]);
    return { status: "read" };
  }
  throw new Error("markRead(unread=false): agently-cli does not support marking as unread.");
}