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

function resolveAccount(ctx, accountId) {
  const dataDir = path.join(ctx.dataDir, ctx.pluginId);
  const accountsPath = path.join(dataDir, "accounts.json");
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(accountsPath, "utf-8")); } catch {}
  const account = accounts.find(a => a.id === accountId);
  if (!account) return null;
  return account;
}

export const name = "mail_sync";
export const description = "同步邮箱文件夹";

export const parameters = {
  type: "object",
  properties: {
    accountId: { type: "string", description: "账号 ID" },
    folder: { type: "string", description: "文件夹名（可选，默认 INBOX）" },
  },
  required: ["accountId"],
};

export async function execute(input, ctx) {
  const accountId = input?.accountId || "";
  const folder = input?.folder || "INBOX";
  ctx.log?.info?.("mail_sync", { accountId, folder });

  const dataDir = path.join(ctx.dataDir, ctx.pluginId, "cache");
  fs.mkdirSync(dataDir, { recursive: true });

  const account = resolveAccount(ctx, accountId);
  if (!account) return { ok: false, error: "account not found" };

  try {
    let folders = [];
    try {
      const foldersRaw = await runInbox(["folders", account.email]);
      folders = (Array.isArray(foldersRaw) ? foldersRaw : []).map(f => normalizeFolder(f, accountId));
    } catch (e) {
      ctx.log?.warn?.("mail_sync.folders_fallback", { error: e.message });
      folders = defaultFolders(accountId);
    }

    const messagesRaw = await runInbox(["list", account.email, `--fid=${folder}`, "--limit=50"]);
    const messages = Array.isArray(messagesRaw) ? messagesRaw : [];

    fs.writeFileSync(path.join(dataDir, `folders-${accountId}.json`), JSON.stringify(folders, null, 2), "utf-8");
    fs.writeFileSync(path.join(dataDir, `messages-${accountId}-${folder}.json`), JSON.stringify(messages, null, 2), "utf-8");

    return { ok: true, data: { folders, messages } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


