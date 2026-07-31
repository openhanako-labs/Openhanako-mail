import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { inboxEnvFor } from "../backend/common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, "..", "backend");
const INBOX_PATH = path.join(BACKEND_DIR, "inbox.mjs");

async function runInbox(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = execFile(process.execPath, [INBOX_PATH, ...args], {
      cwd: BACKEND_DIR,
      encoding: "utf-8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`JSON parse failed: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

function resolveAccount(ctx, accountId) {
  const dataDir = path.join(ctx.dataDir, ctx.pluginId);
  const accountsPath = path.join(dataDir, "accounts.json");
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(accountsPath, "utf-8")); } catch {}
  const account = accounts.find(a => a.id === accountId);
  if (!account) return null;
  return account;
}

export const name = "mail_send";
export const description = "发送邮件";

export const parameters = {
  type: "object",
  properties: {
    accountId: { type: "string", description: "账号 ID" },
    to: { type: "string", description: "收件人邮箱地址" },
    subject: { type: "string", description: "邮件主题" },
    body: { type: "string", description: "邮件正文" },
    messageId: { type: "string", description: "回复的邮件 ID（可选，传此参数时回复邮件）" },
  },
  required: ["accountId", "to", "subject", "body"],
};

export async function execute(input, ctx) {
  const { accountId, to, subject, body, messageId } = input || {};
  if (!accountId || !to || !subject || !body) {
    return { ok: false, error: "accountId, to, subject, body are required" };
  }
  ctx.log?.info?.("mail_send", { accountId, to, subject, messageId });

  const account = resolveAccount(ctx, accountId);
  if (!account) return { ok: false, error: "account not found" };
  const extraEnv = inboxEnvFor(account);

  try {
    if (messageId) {
      const result = await runInbox(["reply", account.email, messageId, `--body=${body}`], extraEnv);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, data: result };
    }

    const result = await runInbox(["send", account.email, `--to=${to}`, `--subject=${subject}`, `--body=${body}`], extraEnv);
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
