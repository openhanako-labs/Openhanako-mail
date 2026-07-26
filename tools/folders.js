import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { normalizeFolder, defaultFolders } from "../backend/common.mjs";

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

export const name = "mail_folders";
export const description = "获取账号文件夹列表";

export async function execute(input, ctx) {
  const accountId = input?.accountId || "";
  if (!accountId) return { ok: false, error: "accountId is required" };

  const dataDir = path.join(ctx.dataDir, ctx.pluginId);
  const accountsPath = path.join(dataDir, "accounts.json");
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(accountsPath, "utf-8")); } catch {}
  const account = accounts.find(a => a.id === accountId);
  if (!account) return { ok: false, error: "account not found" };

  try {
    const result = await runInbox(["folders", account.email]);
    if (result.error) return { ok: false, error: result.error };
    const folders = (Array.isArray(result) ? result : []).map(f => normalizeFolder(f, accountId));
    return { ok: true, data: folders };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


