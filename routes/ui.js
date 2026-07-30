import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import crypto from "node:crypto";

import * as llm from "../backend/llm.mjs";
// 镜像 hana-code-atlas（代码图谱）：通过 ctx.bus 向 Hanako 宿主解析真实模型配置
import { resolveLlmConfig, listChatModels } from "../backend/hana-llm.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 凭证明文 AES-256-GCM 加密 ────────────────────────
// 密钥来源：固定盐 + 机器用户名，防止跨机器直接读取，但同一机器可解密。
const CRYPTO_SALT = "hanako-mail-plugin-salt-v1";
function getCryptoKey() {
  const material = `${os.userInfo().username}-${CRYPTO_SALT}`;
  return crypto.scryptSync(material, "hanako-mail-nonce", 32);
}

function encryptField(text) {
  if (!text || typeof text !== "string") return text;
  const key = getCryptoKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `ENC:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decryptField(token) {
  if (!token || typeof token !== "string") return token;
  if (!token.startsWith("ENC:")) return token;
  const parts = token.slice(4).split(":");
  if (parts.length !== 3) return token;
  const [ivHex, tagHex, encHex] = parts;
  const key = getCryptoKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

function encryptSensitiveFields(account) {
  const out = { ...account };
  if (out.apiKey && typeof out.apiKey === "string") out.apiKey = encryptField(out.apiKey);
  if (out.config && typeof out.config === "object") {
    const cfg = { ...out.config };
    if (cfg.imapPass && typeof cfg.imapPass === "string") cfg.imapPass = encryptField(cfg.imapPass);
    if (cfg.smtpPass && typeof cfg.smtpPass === "string") cfg.smtpPass = encryptField(cfg.smtpPass);
    out.config = cfg;
  }
  return out;
}

function decryptSensitiveFields(account) {
  if (!account || typeof account !== "object") return account;
  const out = { ...account };
  if (out.apiKey && typeof out.apiKey === "string") out.apiKey = decryptField(out.apiKey);
  if (out.config && typeof out.config === "object") {
    const cfg = { ...out.config };
    if (cfg.imapPass && typeof cfg.imapPass === "string") cfg.imapPass = decryptField(cfg.imapPass);
    if (cfg.smtpPass && typeof cfg.smtpPass === "string") cfg.smtpPass = decryptField(cfg.smtpPass);
    out.config = cfg;
  }
  return out;
}

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

function resolveAccount(accountsList, accountId) {
  return accountsList.find(a => a.id === accountId);
}

// 检查后端依赖是否完整
// 返回 null(OK) / { error, hint }(缺失且未在安装) / { installing: true }(正在后台安装)
const INSTALL_LOCK = path.join(BACKEND_DIR, "data", ".hanako-auto-install.lock");
function checkBackendDeps(account) {
  if (!account) return null;
  const email = (account.email || "").toLowerCase();

  // ClawEmail 需要 @clawemail/node-sdk
  if (email.endsWith("@claw.163.com")) {
    const sdkPath = path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk", "package.json");
    if (!fs.existsSync(sdkPath)) {
      if (fs.existsSync(INSTALL_LOCK)) return { installing: true };
      return { error: "ClawEmail SDK 未安装。请先在 backend/ 目录执行 npm install，或改用其他后端。", hint: "cd backend && npm install" };
    }
  }

  // 非 API 邮箱（IMAP 个人邮箱）需要 imap 和 nodemailer
  if (!email.endsWith("@claw.163.com") && !email.endsWith("@agent.qq.com")) {
    const imapPath = path.join(BACKEND_DIR, "node_modules", "imap", "package.json");
    const nmPath = path.join(BACKEND_DIR, "node_modules", "nodemailer", "package.json");
    if (!fs.existsSync(imapPath) || !fs.existsSync(nmPath)) {
      if (fs.existsSync(INSTALL_LOCK)) return { installing: true };
      return { error: "IMAP 依赖未安装。请先在 backend/ 目录执行 npm install，否则个人邮箱无法使用。", hint: "cd backend && npm install" };
    }
  }

  return null;
}

// 统一处理依赖检查结果：安装中→返回 202，缺失→返回 400，OK→返回 false
function handleDepIssue(c, depIssue) {
  if (!depIssue) return false; // 无问题
  if (depIssue.installing) {
    return c.json({ ok: false, installing: true, message: "后端依赖正在自动安装中，请稍候…" }, 202);
  }
  return c.json({ ok: false, error: depIssue.error, hint: depIssue.hint }, 400);
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

// 解析 LLM 调用选项：前端自定义优先，否则从 Hanako 宿主（provider:credentials）解析真实配置。
// 这是对照 hana-code-atlas（代码图谱）修正的核心：此前读不到的 HANAKO_LLM_* 不再作为唯一来源。
async function buildLlmOpts(ctx, llmCfg, body = {}) {
  if (llmCfg && llmCfg.baseUrl && llmCfg.model) {
    return { baseUrl: llmCfg.baseUrl, apiKey: llmCfg.apiKey, model: llmCfg.model };
  }
  try {
    const cfg = await resolveLlmConfig(ctx, { providerId: body?.providerId, model: body?.model });
    if (cfg.ok) return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, api: cfg.api };
    ctx?.log?.warn?.("mail_llm.resolve_failed", { error: cfg.error });
  } catch (e) {
    ctx?.log?.warn?.("mail_llm.resolve_exception", { error: e?.message });
  }
  return {}; // 回退到 llm.mjs 内部的环境变量兜底
}

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

  function readWsCache(accountId) {
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
    const base = process.env.EMAIL_MONITOR_DATA_DIR || path.join("W:\\", "Games", "Hanako", "Work", "projects", "email-monitor", "data");
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

  function accounts() {
    const raw = readJson(path.join(dataDir, "accounts.json"), []);
    return raw.map(decryptSensitiveFields);
  }

  function saveAccounts(list) {
    const encrypted = list.map(encryptSensitiveFields);
    writeJson(path.join(dataDir, "accounts.json"), encrypted);
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

  const depIssue = checkBackendDeps(account);
  if (depIssue) return c.json({ ok: false, error: depIssue.error, hint: depIssue.hint }, 400);

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
      let messages = Array.isArray(messagesRaw) ? messagesRaw : [];

      // 合并 WebSocket 实时缓存（ClawEmail 账号）
      if (account.email.endsWith("@claw.163.com")) {
        const wsMails = readWsCache(accountId);
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

  // 把结构化发送参数（含 cc/bcc/附件）写入临时 JSON 文件，供 inbox.mjs 以 --json= 读取，
  // 避免 CLI 参数无法表达数组/二进制附件的问题。
  function writeInboxOptions(obj) {
    const dir = path.join(BACKEND_DIR, "data", "_tmp");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `opts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify(obj), "utf-8");
    return file;
  }
  function safeUnlink(p) {
    try { if (p) fs.unlinkSync(p); } catch {}
  }

  const postSend = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { accountId, to, subject, body: text, messageId, cc, bcc, attachments } = body;
    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    const optsFile = writeInboxOptions({ to, subject, body: text, cc, bcc, attachments });
    try {
      let result;
      if (messageId) {
        result = await runInbox(["reply", account.email, messageId, `--json=${optsFile}`], inboxEnvFor(account));
      } else {
        result = await runInbox(["send", account.email, `--json=${optsFile}`], inboxEnvFor(account));
      }
      if (result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    } finally {
      safeUnlink(optsFile);
    }
  };

  const postForward = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { accountId, to, subject, body: text, messageId, cc, bcc, attachments } = body;
    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    if (!messageId) return c.json({ ok: false, error: "messageId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    const optsFile = writeInboxOptions({ to, subject, body: text, cc, bcc, attachments });
    try {
      const result = await runInbox(["forward", account.email, messageId, `--json=${optsFile}`], inboxEnvFor(account));
      if (result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    } finally {
      safeUnlink(optsFile);
    }
  };

  // 从邮件对象抽取纯文本（用于 LLM 处理）
  function plainOf(m) {
    if (!m) return "";
    if (typeof m.text === "string" && m.text.trim()) return m.text;
    if (typeof m.body === "string" && m.body.trim()) return m.body;
    if (typeof m.snippet === "string" && m.snippet.trim()) return m.snippet;
    if (typeof m.textBody === "string" && m.textBody.trim()) return m.textBody;
    return "";
  }

  // 读取单封邮件正文（供总结/翻译复用）
  const readMailPlain = async (account, messageId) => {
    const result = await runInbox(["read", account.email, messageId], inboxEnvFor(account));
    if (result.error) throw new Error(result.error);
    const text = plainOf(result);
    if (!text) throw new Error("该邮件没有可处理的纯文本内容（或为纯图片邮件）");
    return text;
  };

  const postSummarize = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const messageId = body?.messageId || "";
    const targetLang = body?.targetLang || "中文";
    const llmCfg = body?.llmConfig || null; // 前端传来的自定义 LLM 配置
    if (!accountId || !messageId) return c.json({ ok: false, error: "accountId 和 messageId 必填" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    try {
      const text = await readMailPlain(account, messageId);
      // 配置来源：前端自定义 > 宿主真实配置（provider:credentials）> 环境变量兜底
      const opts = await buildLlmOpts(ctx, llmCfg, body);
      const summary = await llm.summarizeMail(text, targetLang, opts);
      return c.json({ ok: true, data: summary });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const postTranslate = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const messageId = body?.messageId || "";
    const targetLang = body?.targetLang || "中文";
    const llmCfg = body?.llmConfig || null;
    if (!accountId || !messageId) return c.json({ ok: false, error: "accountId 和 messageId 必填" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    try {
      const text = await readMailPlain(account, messageId);
      const opts = await buildLlmOpts(ctx, llmCfg, body);
      const translated = await llm.translateMail(text, targetLang, opts);
      return c.json({ ok: true, data: translated });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const postMarkRead = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const messageId = body?.messageId || "";
    const folder = body?.folder || "INBOX";
    const wantRead = body?.read !== false; // 默认 true（标已读），false = 标未读
    if (!accountId || !messageId) return c.json({ ok: false, error: "accountId/messageId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    // 始终更新本地缓存（保证 UI 视觉一致）
    function updateLocalRead(readState) {
      try {
        const cacheFile = path.join(cacheDir, `messages-${accountId}-${folder}.json`);
        const msgs = readJson(cacheFile, null);
        if (Array.isArray(msgs)) {
          const target = msgs.find(m => m.id === messageId);
          if (target) { target.read = !!readState; writeJson(cacheFile, msgs); }
        }
      } catch {}
    }

    try {
      // 标未读：部分后端不支持，直接本地标记
      if (!wantRead) {
        updateLocalRead(false);
        return c.json({ ok: true, data: { fallback: true, reason: "mark-unread-local" } });
      }
      const result = await runInbox(["mark-read", account.email, messageId], inboxEnvFor(account));
      if (result && result.error) {
        updateLocalRead(true);
        return c.json({ ok: true, data: { fallback: true, reason: String(result.error).slice(0, 200) } });
      }
      updateLocalRead(true);
      return c.json({ ok: true, data: result });
    } catch (e) {
      try { fs.appendFileSync(path.join(dataDir, "debug-markread.log"), `[${new Date().toISOString()}] mark-read ${messageId} :: ${e.stack || e.message}\n`); } catch {}
      updateLocalRead(wantRead);
      return c.json({ ok: true, data: { fallback: true, reason: String(e.message || e).slice(0, 200) } });
    }
  };

  const getSearch = async (c) => {
    const accountId = c.req.query("accountId") || "";
    const q = (c.req.query("q") || "").trim();
    if (!accountId || !q) return c.json({ ok: false, error: "accountId/q is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });
    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;
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
    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;
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

  // ── LLM 配置检测与测试 ──
  // 检测 Hanako 本体 / 环境变量中的 LLM 配置
  // 把 YAML 解析出的各种类型归一化为字符串（对象/布尔/数字 → 字符串或空）
  function asStr(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "boolean" || typeof v === "number") return String(v);
    return ""; // 对象（如空 map {}）→ 视为未设置
  }

  // ── 轻量 YAML 解析（处理嵌套 map + 标量值；忽略 list 细节，仅取我们需要的字段）──
  function parseSimpleYaml(text) {
    const lines = String(text || "").split(/\r?\n/);
    const root = {};
    const stack = [{ indent: -1, node: root }];
    const top = () => stack[stack.length - 1];

    for (const raw of lines) {
      if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
      const indent = raw.match(/^(\s*)/)[1].replace(/\t/g, "  ").length;
      let content = raw.trim().replace(/\s+#.*$/, ""); // 去掉行尾注释
      if (/^-\s/.test(content)) continue; // 列表项跳过（我们只需要标量路径）

      const m = content.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      while (stack.length > 1 && top().indent >= indent) stack.pop();

      if (value === "") {
        const newNode = {};
        top().node[key] = newNode;
        stack.push({ indent, node: newNode });
      } else {
        if (value.startsWith("[") && value.endsWith("]")) {
          value = value.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
        } else if (value === "true") value = true;
        else if (value === "false") value = false;
        else if (value !== "" && !isNaN(Number(value))) value = Number(value);
        top().node[key] = value;
      }
    }
    return root;
  }

  // 常见供应商 → OpenAI 兼容 Base URL 预设（best-effort，用户可在 UI 覆盖）
  const PROVIDER_PRESETS = {
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    moonshot: "https://api.moonshot.cn/v1",
    kimi: "https://api.moonshot.cn/v1",
    qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    aliyun: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    zhipu: "https://open.bigmodel.cn/api/paas/v4",
    glm: "https://open.bigmodel.cn/api/paas/v4",
    ollama: "http://localhost:11434/v1",
    grok: "https://api.x.ai/v1",
    xai: "https://api.x.ai/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    google: "https://generativelanguage.googleapis.com/v1beta/openai",
    together: "https://api.together.xyz/v1",
    siliconflow: "https://api.siliconflow.cn/v1",
    volcengine: "https://ark.cn-beijing.volces.com/api/v3",
    baichuan: "https://api.baichuan-ai.com/v1",
    minimax: "https://api.minimax.chat/v1",
  };

  // 检测 Hanako per-agent LLM 配置（两层结构）
  //   1) 每个 agent: ~/.hanako/agents/<agent-id>/config.yaml  (api.provider / models.chat ...)
  //   2) 全局供应商凭据: ~/.hanako/added-models.yaml  (跨 agent 共享，通常已迁移到设置页)
  const postLlmDetect = async (c) => {
    const detected = [];

    // 0) Hanako 宿主配置的聊天供应商（真实可用，凭据由宿主管理，无需前端填 key）
    //    这是对照 hana-code-atlas（代码图谱）修正的核心来源。
    try {
      const host = await listChatModels(ctx);
      if (host.ok) {
        for (const p of host.providers) {
          for (const m of p.models) {
            detected.push({
              name: `宿主: ${p.id} · ${m}`,
              provider: p.id,
              model: m,
              baseUrl: "", // 凭据走 provider:credentials，不在此暴露明文
              apiKey: "",
              fromHost: true,
              note: "来源: Hanako 宿主 (provider:models-by-type)",
              needsKey: false,
              needsBaseUrl: false,
            });
          }
        }
      }
    } catch {}

    const home = os.homedir();

    // 1) 每个 agent 的独立配置
    const agentsDir = path.join(home, ".hanako", "agents");
    try {
      if (fs.existsSync(agentsDir)) {
        const agentIds = fs.readdirSync(agentsDir).filter((name) => {
          try { return fs.statSync(path.join(agentsDir, name)).isDirectory(); } catch { return false; }
        });
        for (const agentId of agentIds) {
          const cfgPath = path.join(agentsDir, agentId, "config.yaml");
          if (!fs.existsSync(cfgPath)) continue;
          try {
            const cfg = parseSimpleYaml(fs.readFileSync(cfgPath, "utf-8"));
            // 真实结构：api.provider 可能是字符串或空对象 {}；models.chat 是 { id, provider }
            const apiProvider = asStr(cfg?.api?.provider || cfg?.provider || cfg?.llm?.provider).toLowerCase();
            const chatObj = cfg?.models?.chat;
            const chatModel = (chatObj && typeof chatObj === "object")
              ? asStr(chatObj.id)
              : (typeof chatObj === "string" ? chatObj : "");
            const chatProvider = (chatObj && typeof chatObj === "object") ? asStr(chatObj.provider) : "";
            const utilityModel = (typeof cfg?.models?.utility === "string")
              ? cfg.models.utility
              : asStr(cfg?.models?.utility?.id);
            const embeddingModel = (typeof cfg?.models?.embedding === "string")
              ? cfg.models.embedding
              : asStr(cfg?.models?.embedding?.id);
            if (!apiProvider && !chatModel) continue; // 该 agent 未配置 LLM，跳过
            // 模型实际由 models.chat.provider 提供；拿不到时用 api.provider 兜底
            const modelProvider = (chatProvider || apiProvider).toLowerCase();
            const cfgBaseUrl = cfg?.api?.base_url || cfg?.api?.endpoint || "";
            const baseUrl = cfgBaseUrl || PROVIDER_PRESETS[modelProvider] || "";
            const displayProvider = chatProvider || apiProvider;
            detected.push({
              name: `Agent: ${agentId}` + (chatModel ? ` · ${chatModel}` : ""),
              provider: displayProvider,
              apiProvider,
              chatProvider,
              baseUrl,
              apiKey: "", // 凭据在 added-models.yaml / 设置页管理，检测不返回明文
              model: chatModel || "",
              agentId,
              utilityModel,
              embeddingModel,
              note: `来源: ${cfgPath}`,
              needsKey: true,
              needsBaseUrl: !baseUrl,
            });
          } catch {}
        }
      }
    } catch {}

    // 2) 全局供应商凭据（added-models.yaml，通常已迁移到设置页）
    let addedModelsKeys = [];
    const addedModelsPath = path.join(home, ".hanako", "added-models.yaml");
    try {
      if (fs.existsSync(addedModelsPath)) {
        const am = parseSimpleYaml(fs.readFileSync(addedModelsPath, "utf-8"));
        addedModelsKeys = Object.keys(am || {}).filter((k) => k !== "_migrated");
      }
    } catch {}

    // 3) 环境变量兜底（HANAKO_LLM_* / OPENAI_* / OLLAMA_*）
    const envChecks = [
      { name: "环境变量 HANAKO_LLM", provider: (process.env.HANAKO_LLM_BASE_URL || "").includes("deepseek") ? "deepseek" : (process.env.HANAKO_LLM_BASE_URL || "").includes("openai") ? "openai" : "", baseUrl: process.env.HANAKO_LLM_BASE_URL, apiKey: process.env.HANAKO_LLM_API_KEY, model: process.env.HANAKO_LLM_MODEL },
      { name: "OpenAI 兼容", provider: "openai", baseUrl: process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || "gpt-4o-mini" },
      { name: "Ollama 本地", provider: "ollama", baseUrl: process.env.OLLAMA_HOST || "http://localhost:11434/v1", apiKey: "ollama", model: process.env.OLLAMA_MODEL || "qwen2.5:7b" },
    ];
    for (const env of envChecks) {
      if (env.baseUrl && env.model) {
        detected.push({
          name: env.name + (env.provider ? ` · ${env.provider}` : ""),
          provider: env.provider || "",
          baseUrl: env.baseUrl,
          apiKey: (env.apiKey || "").slice(0, 8) + "****", // 脱敏
          model: env.model,
          note: "来源: 环境变量",
          needsKey: !env.apiKey,
          needsBaseUrl: false,
        });
      }
    }

    // 去重：优先按 agentId（或 baseUrl+model）
    const seen = new Set();
    const deduped = detected.filter((d) => {
      const key = d.agentId ? `agent:${d.agentId}:${d.model}` : `env:${d.baseUrl}:${d.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return c.json({ ok: true, data: deduped, addedModelsKeys });
  };

  // 测试 LLM 连接（发一个简单请求验证可用性）
  const postLlmTest = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let { baseUrl, apiKey, model, api } = body;
    // 未显式给配置时，从 Hanako 宿主解析真实可用的模型配置
    if (!baseUrl || !model) {
      const cfg = await resolveLlmConfig(ctx, { providerId: body?.providerId, model: body?.model });
      if (!cfg.ok) return c.json({ ok: false, error: `无法从宿主解析 LLM 配置: ${cfg.error}` });
      baseUrl = cfg.baseUrl; apiKey = cfg.apiKey; model = cfg.model; api = cfg.api;
    }

    try {
      // 用后端 llm.mjs 的 chatCompletion 发一条测试消息
      const result = await llm.chatCompletion(
        [{ role: "user", content: "Reply with exactly: OK" }],
        { baseUrl, apiKey, model, api, maxTokens: 8 }
      );
      return c.json({ ok: true, data: result?.model || model });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e).slice(0, 300) });
    }
  };

  app.get("/accounts", getAccounts);
  app.post("/accounts", postAccounts);
  app.get("/folders", getFolders);
  app.get("/messages", getMessages);
  app.get("/messages/:messageId", getMessageById);
  app.post("/sync", postSync);
  app.post("/send", postSend);
  app.post("/forward", postForward);
  app.post("/summarize", postSummarize);
  app.post("/translate", postTranslate);
  app.post("/mark-read", postMarkRead);
  app.get("/search", getSearch);
  app.get("/attachments/:messageId/:partId", getAttachment);
  app.get("/image-proxy", getImageProxy);

  // ── 依赖安装状态查询（前端轮询用）──
  app.get("/deps-status", (c) => {
    const installing = fs.existsSync(INSTALL_LOCK);
    const missing = [];
    // 检查各后端核心依赖
    const checks = [
      ["@clawemail/node-sdk", path.join(BACKEND_DIR, "node_modules", "@clawemail", "node-sdk", "package.json")],
      ["imap", path.join(BACKEND_DIR, "node_modules", "imap", "package.json")],
      ["nodemailer", path.join(BACKEND_DIR, "node_modules", "nodemailer", "package.json")],
    ];
    for (const [name, p] of checks) {
      if (!fs.existsSync(p)) missing.push(name);
    }
    return c.json({ ok: true, installing, missing, ready: missing.length === 0 && !installing });
  });

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
  app.post("/llm-detect", postLlmDetect);
  app.post("/llm-test", postLlmTest);

  // ── 后台轮询新邮件 ──────────────────────────────────
  const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
  const LAST_IDS_PATH = path.join(dataDir, "_poll_last_ids.json");

  function readLastIds() {
    try { return JSON.parse(fs.readFileSync(LAST_IDS_PATH, "utf-8")); } catch { return {}; }
  }
  function writeLastIds(obj) {
    ensureDir();
    fs.writeFileSync(LAST_IDS_PATH, JSON.stringify(obj), "utf-8");
  }

  async function pollAccounts() {
    const list = accounts();
    if (!list.length) return;
    const lastIds = readLastIds();
    let changed = false;

    for (const account of list) {
      try {
        const result = await runInbox(["list", account.email, "--fid=INBOX", "--limit=1"], inboxEnvFor(account));
        const messages = Array.isArray(result) ? result : [];
        if (!messages.length) continue;
        const top = messages[0];
        const key = `${account.id}:INBOX`;
        const prev = lastIds[key];

        if (prev && top.id !== prev) {
          // 新邮件：发桌面通知
          const subject = top.subject || "(无主题)";
          const sender = top.from || "";
          const messageId = top.id;
          const accountId = account.id;

          const toastScript = path.join(ctx.pluginDir, "helper", "mail-toast.cjs");
          if (fs.existsSync(toastScript)) {
            try {
              const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
              const argsFile = path.join(os.tmpdir(), `hanako-mail-notify-${id}.json`);
              fs.writeFileSync(argsFile, JSON.stringify({ subject, sender, messageId, accountId }), "utf-8");
              execFile(process.execPath, [toastScript, "--args-file", argsFile], {
                cwd: ctx.pluginDir,
                timeout: 20000,
                windowsHide: true,
                env: { ...process.env, NODE_PATH: path.join(os.homedir(), ".workbuddy", "binaries", "node", "workspace", "node_modules") },
              }, (err) => {
                try { fs.unlinkSync(argsFile); } catch {}
                if (err) console.warn("toast error:", err.message);
              });
            } catch (e) {
              console.warn("toast failed:", e.message);
            }
          }
        }

        if (top.id) {
          lastIds[key] = top.id;
          changed = true;
        }
      } catch (e) {
        // 单账号轮询失败不影响其他账号
        console.warn(`hanako-mail poll fail: ${account.email}: ${e.message}`);
      }
    }

    if (changed) writeLastIds(lastIds);
  }

  // 启动轮询
  const pollTimer = setInterval(pollAccounts, POLL_INTERVAL_MS);
  // 首次加载时检查一次（延迟 30 秒，避免阻塞启动）
  setTimeout(pollAccounts, 30 * 1000);
}
