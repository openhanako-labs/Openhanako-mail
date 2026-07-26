/**
 * AgentQQ 后端 — 封装 agently-cli
 *
 * 完整能力：list / search / read / send / reply / forward / attachment
 * 所有输出：{ ok: true, data: {...} }
 */

import { spawn } from "node:child_process";

const MAIL_CLI = "mail-cli.cmd";

function runAgentlyCli(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const escapedArgs = args.map(a => {
      if (a.includes(' ') || a.includes('"')) {
        return `"${a.replace(/"/g, '\\"')}"`;
      }
      return a;
    });
    const cmd = `agently-cli.cmd ${escapedArgs.join(' ')}`;
    const proc = spawn(cmd, {
      encoding: "utf-8",
      timeout,
      windowsHide: true,
      shell: true,
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
  const { to, body, includeAttachments = false, confirmSend = false } = options;
  if (!to) throw new Error("forwardMail: 'to' is required");

  const args = ["message", "+forward", `--id=${messageId}`];
  for (const t of (Array.isArray(to) ? to : [to])) args.push(`--to=${t}`);
  if (body) args.push(`--body=${body}`);
  if (includeAttachments) args.push("--include-attachments");
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