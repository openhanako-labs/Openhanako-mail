import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { normalizeFolder, defaultFolders, inboxEnvFor } from "../backend/common.mjs";

const BACKEND_DIR = path.join(path.dirname(path.dirname(import.meta.url)), "backend");
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

function readWsCache(ctx, accountId) {
  const cacheDir = path.join(ctx.dataDir, ctx.pluginId, "cache");
  const files = [];
  try {
    const entries = fs.readdirSync(cacheDir);
    const prefix = `ws-${accountId}-`;
    for (const f of entries) {
      if (f.startsWith(prefix) && f.endsWith(".json")) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf-8"));
          files.push({
            ...content,
            id: content.mailId || content.id || f,
          });
        } catch {}
      }
    }
  } catch {}
  return files;
}

function readEmailMonitorData(accountEmail) {
  const base = path.join("W:\\", "Games", "Hanako", "Work", "projects", "email-monitor", "data");
  const files = [];
  try {
    const entries = fs.readdirSync(base);
    for (const entry of entries) {
      const emailPath = path.join(base, entry, "email.json");
      if (!fs.existsSync(emailPath)) continue;
      try {
        const content = JSON.parse(fs.readFileSync(emailPath, "utf-8"));
        const toList = Array.isArray(content.to) ? content.to : [content.to || ""];
        if (toList.some(t => t && t.includes(accountEmail))) {
          files.push({
            id: content.mailId || entry,
            from: content.from && content.from[0] ? content.from[0] : "",
            subject: content.subject || "(无主题)",
            date: content.date || "",
            size: 0,
            read: true,
            platform: "email-monitor",
          });
        }
      } catch {}
    }
  } catch {}
  return files;
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
  const extraEnv = inboxEnvFor(account);

  try {
    let folders = [];
    try {
      const foldersRaw = await runInbox(["folders", account.email], extraEnv);
      folders = (Array.isArray(foldersRaw) ? foldersRaw : []).map(f => normalizeFolder(f, accountId));
    } catch (e) {
      ctx.log?.warn?.("mail_sync.folders_fallback", { error: e.message });
      folders = defaultFolders(accountId);
    }

    let messagesRaw = [];
    try {
      messagesRaw = await runInbox(["list", account.email, `--fid=${folder}`, "--limit=50"], extraEnv);
    } catch (e) {
      ctx.log?.warn?.("mail_sync.list_fallback", { error: e.message });
    }
    let messages = Array.isArray(messagesRaw) ? messagesRaw : [];

    // 合并 WebSocket 实时缓存（ClawEmail 账号）
    if (account.email.endsWith("@claw.163.com")) {
      const wsMails = readWsCache(ctx, accountId);
      if (wsMails.length) {
        const byId = new Map(messages.map(m => [m.id, m]));
        for (const m of wsMails) {
          if (!byId.has(m.id)) {
            byId.set(m.id, m);
          }
        }
        messages = Array.from(byId.values()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      }

      // 如果 REST API 返回的还是旧数据，补充 email-monitor 本地存档
      if (messages.length === 0 || (messages.length > 0 && messages[0].date && messages[0].date < "2026-07-01")) {
        const monitorMails = readEmailMonitorData(account.email);
        if (monitorMails.length) {
          const byId = new Map(messages.map(m => [m.id, m]));
          for (const m of monitorMails) {
            if (!byId.has(m.id)) {
              byId.set(m.id, m);
            }
          }
          messages = Array.from(byId.values()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
          ctx.log?.info?.("mail_sync.monitor_fallback", { count: monitorMails.length });
        }
      }
    }

    fs.writeFileSync(path.join(dataDir, `folders-${accountId}.json`), JSON.stringify(folders, null, 2), "utf-8");
    fs.writeFileSync(path.join(dataDir, `messages-${accountId}-${folder}.json`), JSON.stringify(messages, null, 2), "utf-8");

    return { ok: true, data: { folders, messages } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


