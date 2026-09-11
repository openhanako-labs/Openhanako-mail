/**
 * AgentQQ 后端 —— 依赖外部 `agently-cli`，**在 v2 下不可用**。
 *
 * 原因：它必须 spawn 子进程，而本模块跑在受管 native 服务里，
 * 那个进程被 Job Object 管着、不能再 spawn（实测 spawn EPERM）。
 * 与 ClawEmail 不同，这个 CLI 没有等价的进程内 SDK，所以只能如实报错。
 *
 * 要支持 AgentQQ 的话需要换一个不靠子进程的接入方式（官方 API 或 SDK）。
 * 在那之前，用 @agent.qq.com 账号会看到明确的说明，而不是神秘的 EPERM。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function unsupported() {
  throw new Error(
    "AgentQQ 后端在当前架构下不可用：它依赖外部 agently-cli 子进程，"
    + "而受管运行时不允许再创建子进程（spawn EPERM）。"
    + "请改用 IMAP 个人邮箱或 ClawEmail 账号。",
  );
}

// 保留入口探测（仅供诊断显示用）
function resolveCliEntry() {
  const local = path.join(__dirname, "node_modules", "@tencent-qqmail", "agently-cli", "scripts", "run.js");
  return fs.existsSync(local) ? local : null;
}

let _cliEntry = undefined;
function getCliEntry() {
  if (_cliEntry === undefined) _cliEntry = resolveCliEntry();
  return _cliEntry;
}

function runAgentlyCli() {
  return Promise.reject(new Error(
    "AgentQQ 后端在当前架构下不可用：它依赖外部 agently-cli 子进程，"
    + "而受管运行时不允许再创建子进程（spawn EPERM）。"
    + "请改用 IMAP 个人邮箱或 ClawEmail 账号。",
  ));
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