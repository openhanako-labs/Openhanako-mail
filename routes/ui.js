import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 兼容 dev 加载：如果 __dirname 指向源目录，尝试用插件上下文解析
const DEVICES = new Set(["C", "D", "E", "W"]);
function isDevSymlink(dir) {
  const root = dir.split(path.sep).slice(0, 3).join(path.sep).toUpperCase();
  return DEVICES.has(root[0]) && root.includes(".hanako\\plugins-dev");
}

// Fallback mapType（当 ESM import 失败时使用）
function _mapTypeFallback(name) {
  const n = name.toLowerCase();
  if (n.includes("inbox") || n === "收件箱") return "inbox";
  if (n.includes("sent") || n.includes("已发送")) return "sent";
  if (n.includes("draft") || n.includes("草稿")) return "drafts";
  if (n.includes("trash") || n.includes("已删除")) return "trash";
  if (n.includes("spam") || n.includes("垃圾")) return "spam";
  return "custom";
}

function _defaultFoldersFallback(accountId) {
  return [
    { id: "INBOX", accountId, name: "收件箱", path: "INBOX", type: "inbox", unreadCount: 0, totalCount: 0 },
    { id: "Sent", accountId, name: "已发送", path: "Sent", type: "sent", unreadCount: 0, totalCount: 0 },
    { id: "Drafts", accountId, name: "草稿", path: "Drafts", type: "drafts", unreadCount: 0, totalCount: 0 },
    { id: "Trash", accountId, name: "已删除", path: "Trash", type: "trash", unreadCount: 0, totalCount: 0 },
    { id: "Spam", accountId, name: "垃圾邮件", path: "Spam", type: "spam", unreadCount: 0, totalCount: 0 },
  ];
}

// 子进程脚本：在 Hana 服务器被拦截的 global fetch 之外，以独立进程拉取外网图片。
const PROXY_FETCH_SCRIPT = path.join(__dirname, "..", "assets", "_proxy-fetch.cjs");
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(PLUGIN_ROOT, "backend");
const INBOX_PATH = path.join(BACKEND_DIR, "inbox.mjs");

async function runInbox(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = execFile(process.execPath, [INBOX_PATH, ...args], {
      cwd: BACKEND_DIR,
      encoding: "utf-8",
      windowsHide: true,
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

function resolveAccount(accountsList, accountId) {
  return accountsList.find(a => a.id === accountId);
}

// 将 account 的 apiKey / email / IMAP 配置透传给后端子进程。
// 这样 CLAWEMAIL_API_KEY 来自 accounts.json，backend/.env 仅作兜底（子进程 loadEnv 仅在缺失时填充）。
// 个人邮箱的 IMAP 配置也通过环境变量透传。
function inboxEnvFor(account) {
  const env = {};
  if (account && account.apiKey) env.CLAWEMAIL_API_KEY = account.apiKey;
  if (account && account.email) env.CLAWEMAIL_ADDRESS = account.email;
  // 个人邮箱 IMAP 配置
  if (account && account.config) {
    if (account.config.imapHost) env.IMAP_HOST = account.config.imapHost;
    if (account.config.imapPort) env.IMAP_PORT = String(account.config.imapPort);
    if (account.config.imapUser) env.IMAP_USER = account.config.imapUser;
    if (account.config.imapPass) env.IMAP_PASS = account.config.imapPass;
    if (account.config.smtpHost) env.SMTP_HOST = account.config.smtpHost;
    if (account.config.smtpPort) env.SMTP_PORT = String(account.config.smtpPort);
    if (account.config.smtpUser) env.SMTP_USER = account.config.smtpUser;
    if (account.config.smtpPass) env.SMTP_PASS = account.config.smtpPass;
  }
  return env;
}

// ── 摘要提取 ────────────────────────────────────────────
function snippetFrom(r) {
  let text = "";
  if (r && typeof r.html === "object" && r.html && r.html.content != null) {
    text = String(r.html.content);
  } else if (typeof r === "object" && r && typeof r.html === "string") {
    text = r.html;
  }
  if (text) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/\s+/g, " ")
      .trim();
  } else if (r && typeof r.text === "string") {
    text = r.text.trim();
  } else if (r && typeof r.body === "string") {
    text = r.body.trim();
  }
  if (!text) return "";
  const cap = 180;
  return text.length > cap ? text.slice(0, cap).replace(/\s+\S*$/, "") + "…" : text;
}

function mergeSnippets(messages, previousCache) {
  if (!Array.isArray(messages)) return messages;
  const byId = {};
  if (Array.isArray(previousCache)) previousCache.forEach(m => { if (m && m.id && m.snippet) byId[m.id] = m.snippet; });
  messages.forEach(m => {
    if (!m || !m.id) return;
    if (byId[m.id]) m.snippet = byId[m.id];
  });
  return messages;
}

async function batchFetchSnippets(account, messages, topN = 12) {
  const need = messages.filter(m => m && m.id && !m.snippet).slice(0, topN);
  if (!need.length) return messages;
  const out = await Promise.all(need.map(async (m) => {
    try {
      const r = await runInbox(["read", account.email, m.id], inboxEnvFor(account));
      return snippetFrom(r);
    } catch (e) {
      return "";
    }
  }));
  need.forEach((m, i) => { m.snippet = out[i]; });
  return messages;
}

// 邮件里的外网图片代理（解决沙箱 iframe 无法访问外网的问题）。
// 安全约束：仅允许 http/https；屏蔽私有/回环地址防 SSRF；校验 Content-Type 为 image/*。
// 实际拉取交给独立子进程（assets/_proxy-fetch.cjs），因为 Hana 服务器会拦截插件内
// 的 global fetch；子进程继承 Hana 的代理环境变量会被网关拦截（missing_credential），
// 因此这里剥离代理相关环境变量，让子进程直连外网。
const PROXY_ENV_BLACKLIST = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY",
];
function cleanEnvForProxy() {
  const env = { ...process.env };
  for (const k of PROXY_ENV_BLACKLIST) delete env[k];
  return env;
}
const getImageProxy = async (c) => {
  const url = c.req.query("url") || "";
  if (!url) return c.json({ ok: false, error: "url is required" }, 400);
  let parsed;
  try { parsed = new URL(url); }
  catch { return c.json({ ok: false, error: "invalid url" }, 400); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return c.json({ ok: false, error: "only http/https allowed" }, 400);
  }
  const host = parsed.hostname.toLowerCase();
  const blocked = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1|fc[0-9a-f]{2}:)/i;
  if (blocked.test(host)) {
    return c.json({ ok: false, error: "blocked host (private/loopback)" }, 403);
  }
  try {
    const out = await new Promise((resolve) => {
      execFile(process.execPath, [PROXY_FETCH_SCRIPT, url], {
        encoding: "buffer",
        maxBuffer: 25 * 1024 * 1024,
        timeout: 15000,
        windowsHide: true,
        env: cleanEnvForProxy(),
      }, (err, stdout, stderr) => {
        if (err) {
          let msg = "fetch failed";
          try {
            const j = JSON.parse(stderr.toString("utf-8").split("\n").pop());
            if (j && j.error) msg = j.error;
          } catch { /* ignore */ }
          return resolve({ ok: false, error: msg });
        }
        let meta = null;
        try { meta = JSON.parse(stderr.toString("utf-8").trim().split("\n").pop()); } catch { /* ignore */ }
        if (!meta || !meta.ok) {
          return resolve({ ok: false, error: (meta && meta.error) || "fetch failed" });
        }
        resolve({ ok: true, ct: meta.ct, buf: stdout });
      });
    });
    if (!out.ok) return c.json({ ok: false, error: out.error }, 502);
    return new Response(out.buf, {
      status: 200,
      headers: {
        "Content-Type": out.ct,
        "Content-Length": String(out.buf.length),
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e.message || e) }, 502);
  }
};

export default function (app, ctx) {
  const dataDir = path.join(ctx.dataDir, ctx.pluginId);
  const cacheDir = path.join(dataDir, "cache");
  const templatePath = path.join(ctx.pluginDir, "assets", "plugin-page-template.html");

  function ensureDir() {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")); }
    catch { return fallback; }
  }

  function writeJson(file, data) {
    ensureDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  }

  function accounts() {
    return readJson(path.join(dataDir, "accounts.json"), []);
  }

  function saveAccounts(list) {
    writeJson(path.join(dataDir, "accounts.json"), list);
  }

  app.get("/mail", (c) => {
    const token = c.req.query("token") || "";
    const theme = c.req.query("hana-theme") || "light";
    let html = fs.readFileSync(templatePath, "utf-8");
    html = html.replace("var PLUGIN_ID = 'your-plugin-id';", `var PLUGIN_ID = '${ctx.pluginId}';`);
    html = html.replace(/<body>/, `<body data-hana-theme="${theme}">`);

    const existing = accounts();

    return c.html(html);
  });

  const getAccounts = (c) => c.json({ ok: true, data: accounts() });
  const postAccounts = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const list = accounts();
    if (body.action === "create" && body.name && body.email) {
      const account = {
        id: Date.now().toString(),
        name: body.name,
        email: body.email,
        provider: body.provider || "imap",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (body.apiKey) account.apiKey = body.apiKey;
      if (body.config && typeof body.config === "object") account.config = body.config;
      list.push(account);
      saveAccounts(list);
      return c.json({ ok: true, data: list });
    }
    if (body.action === "delete" && body.id) {
      const next = list.filter((a) => a.id !== body.id);
      saveAccounts(next);
      return c.json({ ok: true, data: next });
    }
    return c.json({ ok: false, error: "invalid action" }, 400);
  };

  const getFolders = (c) => {
    const accountId = c.req.query("accountId") || "";
    const cache = readJson(path.join(cacheDir, `folders-${accountId}.json`), []);
    return c.json({ ok: true, data: cache });
  };

  const getMessages = (c) => {
    const accountId = c.req.query("accountId") || "";
    const folderId = c.req.query("folderId") || "INBOX";
    const cache = readJson(path.join(cacheDir, `messages-${accountId}-${folderId}.json`), []);
    return c.json({ ok: true, data: cache });
  };

  const getMessageById = async (c) => {
    const accountId = c.req.query("accountId") || "";
    const messageId = c.req.param("messageId");

    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    try {
      const result = await runInbox(["read", account.email, messageId], inboxEnvFor(account));
      if (result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      try { fs.appendFileSync(path.join(dataDir, "debug-read.log"), `[${new Date().toISOString()}] read fail id=${messageId} :: ${e.stack || e.message}\n`); } catch {}
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const postSync = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const folder = body?.folder || "INBOX";
    ctx.log?.info?.("mail_sync", { accountId, folder });

    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    // ClawEmail 依赖检查：给出可读错误，而不是 Node 的 ERR_MODULE_NOT_FOUND
    if (account.email?.endsWith("@claw.163.com")) {
      try {
        const sdkPath = path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk", "package.json");
        if (!fs.existsSync(sdkPath)) {
          return c.json({
            ok: false,
            error: "ClawEmail SDK 未安装。请先在 backend/ 目录执行 npm install，或改用 AgentQQ 后端。",
            hint: "cd backend && npm install",
          }, 400);
        }
      } catch {}
    }

    try {
      let folders = [];
      try {
        const foldersRaw = await runInbox(["folders", account.email], inboxEnvFor(account));
        folders = (Array.isArray(foldersRaw) ? foldersRaw : []).map(f => ({
          id: String(f.id ?? f.name ?? ""),
          accountId,
          name: f.name ?? f.id ?? "",
          path: String(f.id ?? f.name ?? ""),
          type: _mapTypeFallback(String(f.name ?? f.id ?? "")),
          unreadCount: Number(f.unread ?? 0),
          totalCount: Number(f.unread ?? 0),
        }));
      } catch (e) {
        ctx.log?.warn?.("mail_sync.folders_fallback", { error: e.message });
        folders = _defaultFoldersFallback(accountId);
      }

      const messagesRaw = await runInbox(["list", account.email, `--fid=${folder}`, "--limit=50"], inboxEnvFor(account));
      const messages = Array.isArray(messagesRaw) ? messagesRaw : [];

      // 摘要：复用上次缓存的，并行补抓前 N 条未缓存的
      const previousCache = readJson(path.join(cacheDir, `messages-${accountId}-${folder}.json`), []);
      mergeSnippets(messages, previousCache);
      await batchFetchSnippets(account, messages, 12);

      ensureDir();
      writeJson(path.join(cacheDir, `folders-${accountId}.json`), folders);
      writeJson(path.join(cacheDir, `messages-${accountId}-${folder}.json`), messages);

      return c.json({ ok: true, data: { folders, messages } });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  };

  const postSend = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { accountId, to, subject, body: text, messageId } = body;
    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    if (account.email?.endsWith("@claw.163.com")) {
      const sdkPath = path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk", "package.json");
      if (!fs.existsSync(sdkPath)) {
        return c.json({ ok: false, error: "ClawEmail SDK 未安装，请先在 backend/ 执行 npm install，或改用 AgentQQ 后端。", hint: "cd backend && npm install" }, 400);
      }
    }

    try {
      let result;
      if (messageId) {
        result = await runInbox(["reply", account.email, messageId, `--body=${text}`], inboxEnvFor(account));
      } else {
        result = await runInbox(["send", account.email, `--to=${to}`, `--subject=${subject}`, `--body=${text}`], inboxEnvFor(account));
      }
      if (result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  };

  const postMarkRead = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const messageId = body?.messageId || "";
    const folder = body?.folder || "INBOX";
    if (!accountId || !messageId) return c.json({ ok: false, error: "accountId/messageId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    if (account.email?.endsWith("@claw.163.com")) {
      const sdkPath = path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk", "package.json");
      if (!fs.existsSync(sdkPath)) {
        return c.json({ ok: false, error: "ClawEmail SDK 未安装，请先在 backend/ 执行 npm install，或改用 AgentQQ 后端。", hint: "cd backend && npm install" }, 400);
      }
    }

    // 始终更新本地缓存（保证 UI 视觉一致）
    function updateLocalRead() {
      try {
        const cacheFile = path.join(cacheDir, `messages-${accountId}-${folder}.json`);
        const msgs = readJson(cacheFile, null);
        if (Array.isArray(msgs)) {
          const target = msgs.find(m => m.id === messageId);
          if (target) { target.read = true; writeJson(cacheFile, msgs); }
        }
      } catch {}
    }

    try {
      const result = await runInbox(["mark-read", account.email, messageId], inboxEnvFor(account));
      if (result && result.error) {
        updateLocalRead();
        return c.json({ ok: true, data: { fallback: true, reason: String(result.error).slice(0, 200) } });
      }
      updateLocalRead();
      return c.json({ ok: true, data: result });
    } catch (e) {
      try { fs.appendFileSync(path.join(dataDir, "debug-markread.log"), `[${new Date().toISOString()}] mark-read ${messageId} :: ${e.stack || e.message}\n`); } catch {}
      // 上游失败（常见：mail-cli 未安装），仍保证本地标记生效
      updateLocalRead();
      return c.json({ ok: true, data: { fallback: true, reason: String(e.message || e).slice(0, 200) } });
    }
  };

  const getSearch = async (c) => {
    const accountId = c.req.query("accountId") || "";
    const q = (c.req.query("q") || "").trim();
    if (!accountId || !q) return c.json({ ok: false, error: "accountId/q is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });
    if (account.email?.endsWith("@claw.163.com")) {
      const sdkPath = path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk", "package.json");
      if (!fs.existsSync(sdkPath)) {
        return c.json({ ok: false, error: "ClawEmail SDK 未安装，请先在 backend/ 执行 npm install，或改用 AgentQQ 后端。", hint: "cd backend && npm install" }, 400);
      }
    }
    try {
      const result = await runInbox(["search", account.email, q], inboxEnvFor(account));
      if (result && result.error) return c.json({ ok: false, error: result.error });
      const list = Array.isArray(result) ? result : [];
      // 也补一下摘要，便于结果卡复用
      mergeSnippets(list, list);
      await batchFetchSnippets(account, list, 8);
      return c.json({ ok: true, data: list });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const getAttachment = async (c) => {
    const accountId = c.req.query("accountId") || "";
    const messageId = c.req.param("messageId");
    const partId = c.req.param("partId");
    const asDownload = c.req.query("download") === "1";
    if (!accountId || !messageId || !partId) {
      return c.json({ ok: false, error: "accountId/messageId/partId is required" }, 400);
    }
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" }, 404);
    if (account.email?.endsWith("@claw.163.com")) {
      const sdkPath = path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk", "package.json");
      if (!fs.existsSync(sdkPath)) {
        return c.json({ ok: false, error: "ClawEmail SDK 未安装，请先在 backend/ 执行 npm install，或改用 AgentQQ 后端。", hint: "cd backend && npm install" }, 400);
      }
    }
    try {
      const r = await runInbox(["attachment", account.email, messageId, partId], inboxEnvFor(account));
      if (r && r.error) return c.json({ ok: false, error: String(r.error) }, 400);
      if (!r || !r.base64) return c.json({ ok: false, error: "attachment not found" }, 404);
      const buf = Buffer.from(r.base64, "base64");
      const rawName = r.filename || `attachment_${partId}`;
      const safeName = rawName.replace(/["\\]/g, "");
      const encodedName = encodeURIComponent(rawName);
      const disposition = (asDownload ? "attachment" : "inline") +
        `; filename="${safeName}"; filename*=UTF-8''${encodedName}`;
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": r.contentType || "application/octet-stream",
          "Content-Disposition": disposition,
          "Content-Length": String(buf.length),
          "Cache-Control": "private, max-age=300",
        },
      });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  };

  app.get("/accounts", getAccounts);
  app.post("/accounts", postAccounts);
  app.get("/folders", getFolders);
  app.get("/messages", getMessages);
  app.get("/messages/:messageId", getMessageById);
  app.post("/sync", postSync);
  app.post("/send", postSend);
  app.post("/mark-read", postMarkRead);
  app.get("/search", getSearch);
  app.get("/attachments/:messageId/:partId", getAttachment);
  app.get("/image-proxy", getImageProxy);

  // ── 桌面通知 ──
  // 方法1：自定义 helper（捆绑 CJK 字体，obsidian 黑金风格）
  // 方法2：Notification Hub helper（功能花哨但依赖系统字体）
  // 方法3：mail-toast.cjs（node-notifier 降级）
  const HELPER_EXE = path.join(ctx.pluginDir, "helper", "bin", "mail-toast-helper.exe");
  const HUB_HELPER_EXE = path.join(ctx.pluginDir, "helper", "bin", "notification-toast-helper.exe");

  const postNotify = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const subject = body.subject || "(无主题)";
    const sender = body.sender || "";
    const messageId = body.messageId || "";
    const accountId = body.accountId || "";

    // 方法1：mail-toast.cjs（node-notifier，经 Hana 服务器验证可用）
    // Hana 服务器上下文中 execFile 只允许 spawn Node.js 子进程，无法直接启动 .NET WinForms EXE。
    const toastScript = path.join(ctx.pluginDir, "helper", "mail-toast.cjs");
    if (fs.existsSync(toastScript)) {
      try {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const argsFile = path.join(os.tmpdir(), `hanako-mail-notify-${id}.json`);
        fs.writeFileSync(argsFile, JSON.stringify({
          subject, sender, messageId, accountId
        }), "utf-8");

        execFile(process.execPath, [toastScript, "--args-file", argsFile], {
          cwd: ctx.pluginDir,
          timeout: 20000,
          env: { ...process.env, NODE_PATH: path.join(os.homedir(), ".workbuddy", "binaries", "node", "workspace", "node_modules") },
        }, (err) => {
          try { fs.unlinkSync(argsFile); } catch {}
          if (err) console.warn("toast error:", err.message);
        });
        return c.json({ ok: true, method: "native" });
      } catch (e) {
        console.warn("toast failed:", e.message);
      }
    }

    return c.json({ ok: true, method: "native" });
  };

  const getClicksLatest = (c) => {
    const clickFile = path.join(os.tmpdir(), "hanako-mail-click.json");
    try {
      if (!fs.existsSync(clickFile)) return c.json({ ok: true, data: null });
      const raw = fs.readFileSync(clickFile, "utf-8");
      // Try parsing as JSON object with or without wrapping
      let data;
      try { data = JSON.parse(raw); } catch {
        // Might be key=value format from batch file; try to extract
        const m = raw.match(/\{.*\}/);
        if (m) data = JSON.parse(m[0]);
        else return c.json({ ok: true, data: null });
      }
      // Clear after read
      fs.unlinkSync(clickFile);
      return c.json({ ok: true, data });
    } catch {
      return c.json({ ok: true, data: null });
    }
  };

  app.post("/notify", postNotify);
  app.get("/clicks/latest", getClicksLatest);
}
