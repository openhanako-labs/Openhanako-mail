import fs from "node:fs";
import path from "node:path";

export const name = "mail_accounts";
export const description = "邮件账号管理：列表/创建/删除账号";

export async function execute(input, ctx) {
  const action = input?.action || "list";
  ctx.log?.info?.("mail_accounts", { action });

  const dataDir = path.join(ctx.dataDir, ctx.pluginId);
  const accountsPath = path.join(dataDir, "accounts.json");

  function readAccounts() {
    try { return JSON.parse(fs.readFileSync(accountsPath, "utf-8")); }
    catch { return []; }
  }

  function writeAccounts(list) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(accountsPath, JSON.stringify(list, null, 2), "utf-8");
  }

  if (action === "list") {
    return { ok: true, data: readAccounts() };
  }

  if (action === "create") {
    const { name, email, provider } = input || {};
    if (!name || !email) return { ok: false, error: "name and email are required" };
    const list = readAccounts();
    const account = { id: Date.now().toString(), name, email, provider: provider || "imap", createdAt: Date.now(), updatedAt: Date.now() };
    list.push(account);
    writeAccounts(list);
    return { ok: true, data: list };
  }

  if (action === "delete") {
    const { id } = input || {};
    const list = readAccounts().filter((a) => a.id !== id);
    writeAccounts(list);
    return { ok: true, data: list };
  }

  return { ok: false, error: "unknown action" };
}
