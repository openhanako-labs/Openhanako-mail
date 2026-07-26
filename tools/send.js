import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const INBOX_PATH = path.join(path.dirname(path.dirname(import.meta.url)), "backend", "inbox.mjs");

async function runInbox(args) {
  return new Promise((resolve, reject) => {
    const proc = execFile(process.execPath, [INBOX_PATH, ...args], {
      cwd: EMAIL_MONITOR_ROOT,
      encoding: "utf-8",
      windowsHide: true,
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

export async function execute(input, ctx) {
  const { accountId, to, subject, body, messageId } = input || {};
  if (!accountId || !to || !subject || !body) {
    return { ok: false, error: "accountId, to, subject, body are required" };
  }
  ctx.log?.info?.("mail_send", { accountId, to, subject, messageId });

  const account = resolveAccount(ctx, accountId);
  if (!account) return { ok: false, error: "account not found" };

  try {
    if (messageId) {
      const result = await runInbox(["reply", account.email, messageId, `--body=${body}`]);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, data: result };
    }

    const result = await runInbox(["send", account.email, `--to=${to}`, `--subject=${subject}`, `--body=${body}`]);
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
