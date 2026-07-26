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

export const name = "mail_messages";
export const description = "获取邮件列表或单封邮件";

export async function execute(input, ctx) {
  const accountId = input?.accountId || "";
  const folderId = input?.folderId || "INBOX";
  const messageId = input?.messageId || "";

  if (!accountId) return { ok: false, error: "accountId is required" };

  const account = resolveAccount(ctx, accountId);
  if (!account) return { ok: false, error: "account not found" };

  try {
    if (messageId) {
      const result = await runInbox(["read", account.email, messageId]);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, data: result };
    }

    const result = await runInbox(["list", account.email, `--fid=${folderId}`, `--limit=50`]);
    if (result.error) return { ok: false, error: result.error };
    const list = Array.isArray(result) ? result : [];
    return { ok: true, data: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
