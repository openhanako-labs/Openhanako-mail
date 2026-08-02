import fs from "node:fs";
import path from "node:path";
import { normalizeFolder, defaultFolders, inboxEnvFor } from "../backend/common.mjs";
// 常驻 worker IPC（v0.1.3 起替代每次冷启 node 子进程跑 inbox.mjs）
import * as workerClient from "../backend/worker-client.mjs";

async function runInbox(args, extraEnv = {}) {
  return await workerClient.runCli(args[0], args.slice(1), extraEnv);
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
    const extraEnv = inboxEnvFor(account);
    const result = await runInbox(["folders", account.email], extraEnv);
    if (result.error) return { ok: false, error: result.error };
    const folders = (Array.isArray(result) ? result : []).map(f => normalizeFolder(f, accountId));
    return { ok: true, data: folders };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


