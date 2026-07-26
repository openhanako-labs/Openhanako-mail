import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { normalizeFolder, defaultFolders } from "../backend/common.mjs";

const BACKEND_DIR = path.join(path.dirname(path.dirname(import.meta.url)), "backend");
const INBOX_PATH = path.join(BACKEND_DIR, "inbox.mjs");

async function runInbox(args) {
  return new Promise((resolve, reject) => {
    const proc = execFile(process.execPath, [INBOX_PATH, ...args], {
      cwd: BACKEND_DIR,
      encoding: "utf-8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
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

export const parameters = {
  type: "object",
  properties: {
    accountId: { type: "string", description: "账号 ID" },
  },
  required: ["accountId"],
};

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


