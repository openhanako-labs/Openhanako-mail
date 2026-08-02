import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import * as llm from "../backend/llm.mjs";
// 镜像 hana-code-atlas（代码图谱）：通过 ctx.bus 向 Hanako 宿主解析真实模型配置
import { resolveLlmConfig, listChatModels } from "../backend/hana-llm.mjs";
import * as blocklist from "../backend/blocklist.mjs";
// 凭据加密统一走公共模块（routes/tools/ws-monitor 共用，消除加解密不对称）
import {
  setCryptoDataDir,
  encryptSensitiveFields,
  decryptSensitiveFields,
} from "../backend/cred-crypto.mjs";
// 常驻 worker IPC：替代「每次 API 调用冷启 node 子进程跑 inbox.mjs」
import * as workerClient from "../backend/worker-client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 凭证明文加密（实现已迁移至 backend/cred-crypto.mjs，此处仅保留说明） ──
// 历史实现：AES-256-GCM + scrypt(用户名 + 硬编码盐)。
// 现实现：AES-256-GCM + scrypt(用户名 + per-install 随机盐)，兼容旧格式解密。
// 加解密函数由上面 import 的 cred-crypto.mjs 提供。

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

// 执行后端命令：常驻 worker IPC（v0.1.3 起替代每次冷启 node 子进程）。
// 参数语义与旧 execFile 版 runInbox 完全一致（CLI 风格 args + 账号凭据 env），
// 成功 resolve 解析后的数据，失败 reject Error。
async function runInbox(args, extraEnv = {}) {
  return await workerClient.runCli(args[0], args.slice(1), extraEnv);
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

// 从 agent 的 config.yaml 解析真实 LLM 凭据（仅服务端使用，key 不返回前端）
async function resolveAgentYamlLlm(agentId) {
  if (!agentId) return null;
  const cfgPath = path.join(os.homedir(), ".hanako", "agents", agentId, "config.yaml");
  try {
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = parseSimpleYaml(fs.readFileSync(cfgPath, "utf-8"));
    const apiKey = asStr(cfg?.api?.api_key || cfg?.api_key || "").trim();
    if (!apiKey) return null;
    const baseUrl = asStr(cfg?.api?.base_url || cfg?.api?.endpoint || "");
    const chatObj = cfg?.models?.chat;
    const model = (chatObj && typeof chatObj === "object") ? asStr(chatObj.id) : (typeof chatObj === "string" ? chatObj : "");
    return { apiKey, baseUrl, model };
  } catch {
    return null;
  }
}

// 解析 LLM 调用选项：配置引用优先，真实 key 一律服务端回源，绝不信任前端传的明文 apiKey。
// 用户不需要（也不允许）手填 URL / API Key —— 直接从 Hanako 宿主或本机 agent 配置读取。
// 引用形式（来自 /llm-detect 检测结果）：
//   { agentId }                → 从 ~/.hanako/agents/<agentId>/config.yaml 读取 url + key + model
//   { providerId, model }      → 从宿主 provider:credentials 解析 baseUrl + apiKey
// 兜底：llm.mjs 内部的环境变量（HANAKO_LLM_* / OPENAI_*）
async function buildLlmOpts(ctx, llmCfg, body = {}) {
  const cfg = llmCfg || {};
  // 1) agent 配置引用（config.yaml 内已有真实 apiKey，服务端回源，最贴合"直接读取 url 和 api"）
  if (cfg.agentId) {
    const ay = await resolveAgentYamlLlm(cfg.agentId);
    if (ay && ay.apiKey) {
      return {
        baseUrl: (cfg.baseUrl && !String(cfg.baseUrl).includes("****")) ? cfg.baseUrl : (ay.baseUrl || ""),
        apiKey: ay.apiKey,
        model: cfg.model || ay.model,
      };
    }
  }
  // 2) 宿主聊天供应商（providerId + model 引用，凭据由宿主管理）
  try {
    const resolved = await resolveLlmConfig(ctx, {
      providerId: cfg.providerId || body?.providerId,
      model: cfg.model || body?.model,
    });
    if (resolved.ok) return { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.model, api: resolved.api };
    ctx?.log?.warn?.("mail_llm.resolve_failed", { error: resolved.error });
  } catch (e) {
    ctx?.log?.warn?.("mail_llm.resolve_exception", { error: e?.message });
  }
  // 3) 环境变量兜底（llm.mjs 内部处理），返回空对象即可
  return {};
}

// 从邮件对象抽取发件人邮箱（兼容 from 为字符串 / 数组 / {address} 对象）
function senderOf(msg) {
  const f = msg && msg.from;
  if (!f) return "";
  if (typeof f === "string") {
    const m = f.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    return m ? m[0].toLowerCase() : f.toLowerCase();
  }
  if (Array.isArray(f)) {
    const first = f[0];
    if (typeof first === "string") return senderOf({ from: first });
    if (first && typeof first === "object" && first.address) return String(first.address).toLowerCase();
  }
  if (typeof f === "object" && f.address) return String(f.address).toLowerCase();
  return "";
}

export default function (app, ctx) {
  const dataDir = path.join(ctx.dataDir, ctx.pluginId);
  // 凭据加密数据目录与 accounts.json 对齐（routes/tools/ws-monitor 同一路径）
  setCryptoDataDir(dataDir);
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
    if (body.action === "update" && body.id) {
      const idx = list.findIndex((a) => a.id === body.id);
      if (idx < 0) return c.json({ ok: false, error: "account not found" }, 404);
      const account = list[idx];
      const updated = { ...account, updatedAt: Date.now() };
      if (typeof body.name === "string" && body.name) updated.name = body.name;
      if (typeof body.email === "string" && body.email) updated.email = body.email;
      if (typeof body.provider === "string" && body.provider) updated.provider = body.provider;
      // 凭据仅在显式提供非空值时才更新；空值 / 未提供 = 保留原值（前端不回显密码）
      if (body.apiKey !== undefined && String(body.apiKey).trim()) {
        updated.apiKey = String(body.apiKey).trim();
      }
      if (body.config && typeof body.config === "object") {
        updated.config = { ...(updated.config || {}), ...body.config };
        // 显式传空字符串的密码字段 = 清除该字段
        for (const k of ["imapPass", "smtpPass"]) {
          if (body.config[k] === "") delete updated.config[k];
        }
      }
      list[idx] = updated;
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
      const folder = c.req.query("folder") || "INBOX";
      const result = await runInbox(["read", account.email, messageId, `--folder=${folder}`], inboxEnvFor(account));
      if (result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      try { fs.appendFileSync(path.join(dataDir, "debug-read.log"), `[${new Date().toISOString()}] read fail id=${messageId} :: ${e.stack || e.message}\n`); } catch {}
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const deleteMessage = async (c) => {
    const accountId = c.req.query("accountId") || "";
    const messageId = c.req.param("messageId");

    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    try {
      // 传入来源文件夹，使后端两步删除（INBOX→垃圾箱，垃圾箱内→永久删）按正确分支执行
      const folder = c.req.query("folder") || "INBOX";
      const result = await runInbox(["delete", account.email, messageId, `--folder=${folder}`], inboxEnvFor(account));
      if (result.error) return c.json({ ok: false, error: result.error });

      // 从本地缓存移除已删邮件，使前端列表在下次加载时立即反映删除结果
      try {
        if (fs.existsSync(cacheDir)) {
          const files = fs.readdirSync(cacheDir).filter(f => f.startsWith("messages-") && f.endsWith(".json"));
          for (const f of files) {
            const fp = path.join(cacheDir, f);
            try {
              const arr = JSON.parse(fs.readFileSync(fp, "utf-8"));
              if (Array.isArray(arr)) {
                const filtered = arr.filter(m => String(m.id) !== String(messageId));
                if (filtered.length !== arr.length) {
                  fs.writeFileSync(fp, JSON.stringify(filtered, null, 2));
                }
              }
            } catch {}
          }
        }
      } catch (cacheErr) {
        console.warn("delete cache cleanup skipped:", cacheErr.message);
      }

      return c.json({ ok: true, data: result });
    } catch (e) {
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
      }

      // 垃圾邮件自动过滤（6.3）：仅对收件箱执行，把黑名单发件人的邮件移入垃圾箱
      if (folder === "INBOX") {
        try {
          const f = await runInbox(["filter-spam", account.email, `--fid=${folder}`], inboxEnvFor(account));
          if (f && f.ok && Array.isArray(f.movedIds) && f.movedIds.length) {
            const movedSet = new Set(f.movedIds);
            messages = messages.filter((m) => !movedSet.has(String(m.id)));
            ctx.log?.info?.("mail_sync.spam_auto_filtered", { count: f.movedIds.length });
          }
        } catch (e) {
          ctx.log?.warn?.("mail_sync.spam_filter_failed", { error: e.message });
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
      const result = await runInbox(["mark-read", account.email, messageId, `--folder=${folder}`], inboxEnvFor(account));
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

  const postMarkSpam = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const messageId = body?.messageId || "";
    const folder = body?.folder || "INBOX";
    if (!accountId || !messageId) return c.json({ ok: false, error: "accountId/messageId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });

    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;

    try {
      // 先从缓存取出该邮件的发件人，用于联动黑名单
      let senderEmail = "";
      try {
        const fp = path.join(cacheDir, `messages-${accountId}-${folder}.json`);
        const arr = readJson(fp, null);
        if (Array.isArray(arr)) {
          const hit = arr.find(m => String(m.id) === String(messageId));
          if (hit) senderEmail = senderOf(hit);
        }
      } catch {}

      const result = await runInbox(["spam", account.email, messageId], inboxEnvFor(account));
      if (result && result.error) return c.json({ ok: false, error: result.error });

      // 从原文件夹缓存移除（已移到垃圾箱，列表不应再显示）
      try {
        const fp = path.join(cacheDir, `messages-${accountId}-${folder}.json`);
        const arr = readJson(fp, null);
        if (Array.isArray(arr)) {
          const filtered = arr.filter(m => String(m.id) !== String(messageId));
          if (filtered.length !== arr.length) writeJson(fp, filtered);
        }
      } catch {}

      // 联动：标记为垃圾 → 把发件人写入黑名单（6.4），下次同步自动拦截
      let blacklisted = false;
      if (senderEmail) {
        try { blocklist.addToBlacklist(senderEmail); blacklisted = true; } catch {}
      }

      return c.json({ ok: true, data: result, blacklisted, senderEmail });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    }
  };

  const getBlocklist = async (c) => {
    return c.json({ ok: true, data: blocklist.getBlocklist() });
  };

  // 批量删除（v0.1.5）：单次 IPC 处理多封，单封失败不中断
  const postBulkDelete = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const accountId = body?.accountId || "";
    const ids = Array.isArray(body?.ids) ? body.ids.map((x) => String(x)) : [];
    const folder = body?.folder || "INBOX";
    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    if (!ids.length) return c.json({ ok: false, error: "ids is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });
    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;
    const optsFile = writeInboxOptions({ ids, folder });
    try {
      const result = await runInbox(["bulk-delete", account.email, `--json=${optsFile}`], inboxEnvFor(account));
      if (result && result.error) return c.json({ ok: false, error: result.error });
      // 同步从本地缓存移除已删邮件
      try {
        const cacheFile = path.join(cacheDir, `messages-${accountId}-${folder}.json`);
        const arr = readJson(cacheFile, null);
        if (Array.isArray(arr)) {
          const rm = new Set((result?.deleted || []).map(String));
          const filtered = arr.filter((m) => !rm.has(String(m.id)));
          if (filtered.length !== arr.length) writeJson(cacheFile, filtered);
        }
      } catch {}
      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    } finally {
      safeUnlink(optsFile);
    }
  };

  // 保存草稿（v0.1.5）：仅 IMAP 后端支持（append 到 DRAFTS）
  const postDraft = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { accountId, to, cc, bcc, subject, body: text } = body;
    if (!accountId) return c.json({ ok: false, error: "accountId is required" });
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" });
    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;
    const optsFile = writeInboxOptions({ to, cc, bcc, subject, body: text });
    try {
      const result = await runInbox(["save-draft", account.email, `--json=${optsFile}`], inboxEnvFor(account));
      if (result && result.error) return c.json({ ok: false, error: result.error });
      return c.json({ ok: true, data: result });
    } catch (e) {
      return c.json({ ok: false, error: String(e.message || e) });
    } finally {
      safeUnlink(optsFile);
    }
  };

  const postBlocklist = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const type = body?.type === "white" ? "white" : "black";
    const email = (body?.email || "").trim();
    const action = body?.action === "remove" ? "remove" : "add";
    if (!email) return c.json({ ok: false, error: "email is required" });
    let data;
    if (type === "white") {
      data = action === "remove" ? blocklist.removeFromWhitelist(email) : blocklist.addToWhitelist(email);
    } else {
      data = action === "remove" ? blocklist.removeFromBlacklist(email) : blocklist.addToBlacklist(email);
    }
    return c.json({ ok: true, data });
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
    const folder = c.req.query("folder") || "INBOX";
    if (!accountId || !messageId || !partId) {
      return c.json({ ok: false, error: "accountId/messageId/partId is required" }, 400);
    }
    const account = resolveAccount(accounts(), accountId);
    if (!account) return c.json({ ok: false, error: "account not found" }, 404);
    const depIssue = checkBackendDeps(account);
    if (handleDepIssue(c, depIssue)) return;
    try {
      const r = await runInbox(["attachment", account.email, messageId, partId, `--folder=${folder}`], inboxEnvFor(account));
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
            // 直接从 agent 的 config.yaml 提取 api_key（若配置了则自动可用，无需手填）
            const cfgApiKey = asStr(cfg?.api?.api_key || cfg?.api_key || "").trim();
            detected.push({
              name: `Agent: ${agentId}` + (chatModel ? ` · ${chatModel}` : ""),
              provider: displayProvider,
              apiProvider,
              chatProvider,
              baseUrl,
              apiKey: cfgApiKey ? cfgApiKey.slice(0, 8) + "****" : "", // 仅返回脱敏占位，真实 key 运行时由 resolveAgentYamlLlm 回源
              model: chatModel || "",
              agentId,
              utilityModel,
              embeddingModel,
              note: cfgApiKey ? `来源: ${cfgPath}（已含 API Key，可一键使用）` : `来源: ${cfgPath}`,
              needsKey: !cfgApiKey,
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
  // 与总结/翻译一致：key 一律服务端回源（agent config.yaml / 宿主 provider:credentials），
  // 不接收前端传来的明文 apiKey（key 不应出现在浏览器/localStorage/网络请求中）。
  const postLlmTest = async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let { baseUrl, model, api } = body;
    let apiKey = "";

    // 优先按 agent 配置引用回源
    if (body?.agentId) {
      const ay = await resolveAgentYamlLlm(body.agentId);
      if (ay && ay.apiKey) {
        baseUrl = (baseUrl && !String(baseUrl).includes("****")) ? baseUrl : ay.baseUrl;
        apiKey = ay.apiKey;
        model = model || ay.model;
      }
    }
    // 否则从宿主解析
    if (!apiKey) {
      const cfg = await resolveLlmConfig(ctx, { providerId: body?.providerId, model: body?.model });
      if (!cfg.ok) return c.json({ ok: false, error: `无法从宿主解析 LLM 配置: ${cfg.error}` });
      baseUrl = cfg.baseUrl; apiKey = cfg.apiKey; model = cfg.model; api = cfg.api;
    }

    if (!baseUrl || !model) {
      return c.json({ ok: false, error: "未找到可用的 LLM 配置：请先在 Hanako 设置中配置聊天供应商，或检测到 agent 配置后再试" });
    }

    try {
      // 用后端 llm.mjs 的 chatCompletion 发一条测试消息
      const result = await llm.chatCompletion(
        [{ role: "user", content: "Reply with exactly: OK" }],
        { baseUrl, apiKey, model, api, max_tokens: 8 }
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
  app.delete("/messages/:messageId", deleteMessage);
  app.post("/sync", postSync);
  app.post("/send", postSend);
  app.post("/forward", postForward);
  app.post("/summarize", postSummarize);
  app.post("/translate", postTranslate);
  app.post("/mark-read", postMarkRead);
  app.post("/mark-spam", postMarkSpam);
  app.post("/bulk-delete", postBulkDelete);
  app.post("/draft", postDraft);
  app.get("/blocklist", getBlocklist);
  app.post("/blocklist", postBlocklist);
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
          env: { ...process.env, NODE_PATH: path.join(BACKEND_DIR, "node_modules") },
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
  const POLL_INTERVAL_MS = 60 * 1000; // 60 秒（v0.1.6：原 5 分钟，提升新邮件感知速度）
  const POLL_FETCH_LIMIT = 5;         // 对比最近 N 封，避免漏掉中间到达的多封
  const LAST_IDS_PATH = path.join(dataDir, "_poll_last_ids.json");
  // 系统通知统一走 backend/node_modules（发布后用户安装依赖即可用，不再依赖本机 .workbuddy 路径）
  const NOTIFY_NODE_PATH = path.join(BACKEND_DIR, "node_modules");

  function readLastIds() {
    try { return JSON.parse(fs.readFileSync(LAST_IDS_PATH, "utf-8")); } catch { return {}; }
  }
  function writeLastIds(obj) {
    ensureDir();
    fs.writeFileSync(LAST_IDS_PATH, JSON.stringify(obj), "utf-8");
  }

  // 发送桌面通知（复用 helper/mail-toast.cjs）
  function notifyMail(subject, sender, messageId, accountId) {
    const toastScript = path.join(ctx.pluginDir, "helper", "mail-toast.cjs");
    if (!fs.existsSync(toastScript)) return;
    try {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const argsFile = path.join(os.tmpdir(), `hanako-mail-notify-${id}.json`);
      fs.writeFileSync(argsFile, JSON.stringify({ subject, sender, messageId, accountId }), "utf-8");
      execFile(process.execPath, [toastScript, "--args-file", argsFile], {
        cwd: ctx.pluginDir,
        timeout: 20000,
        windowsHide: true,
        env: { ...process.env, NODE_PATH: NOTIFY_NODE_PATH },
      }, (err) => {
        try { fs.unlinkSync(argsFile); } catch {}
        if (err) console.warn("toast error:", err.message);
      });
    } catch (e) {
      console.warn("toast failed:", e.message);
    }
  }

  async function pollAccounts() {
    const list = accounts();
    if (!list.length) return;
    const lastIds = readLastIds();
    let changed = false;

    for (const account of list) {
      try {
        const result = await runInbox(["list", account.email, "--fid=INBOX", `--limit=${POLL_FETCH_LIMIT}`], inboxEnvFor(account));
        const messages = Array.isArray(result) ? result : [];
        if (!messages.length) continue;
        const key = `${account.id}:INBOX`;
        const prev = lastIds[key];
        const known = Array.isArray(prev) ? prev : (prev ? [prev] : []);
        const currentIds = messages.map((m) => String(m.id));
        const fresh = currentIds.filter((id) => !known.includes(id));

        if (fresh.length) {
          // 新邮件 → 写缓存（前端列表刷新即可见，解决「刷新也没用」）
          try {
            const cacheFile = path.join(cacheDir, `messages-${account.id}-INBOX.json`);
            const cached = readJson(cacheFile, []);
            const byId = new Map((Array.isArray(cached) ? cached : []).map((m) => [String(m.id), m]));
            for (const m of messages) byId.set(String(m.id), m);
            const merged = Array.from(byId.values()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
            writeJson(cacheFile, merged.slice(0, 50));
          } catch {}

          // 逐封弹系统通知
          for (const m of messages) {
            if (known.includes(String(m.id))) continue;
            notifyMail(m.subject || "(无主题)", m.from || "", m.id, account.id);
          }
        }

        lastIds[key] = currentIds.slice(0, POLL_FETCH_LIMIT);
        changed = true;
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

  // ── 后台自动同步（用户需求：自动同步，而非仅手动） ──
  const AUTO_SYNC_INTERVAL_MS = 3 * 60 * 1000; // 3 分钟
  let autoSyncRunning = false;
  async function autoSyncAccounts() {
    if (autoSyncRunning) return; // 防止与手动同步或上一轮重叠
    autoSyncRunning = true;
    try {
      const list = accounts();
      for (const account of list) {
        try {
          const messagesRaw = await runInbox(["list", account.email, "--fid=INBOX", "--limit=50"], inboxEnvFor(account));
          const messages = Array.isArray(messagesRaw) ? messagesRaw : [];
          // 自动过滤垃圾邮件（6.3）：移走黑名单发件人邮件后再落缓存
          try {
            const f = await runInbox(["filter-spam", account.email, "--fid=INBOX"], inboxEnvFor(account));
            if (f && f.ok && Array.isArray(f.movedIds) && f.movedIds.length) {
              const movedSet = new Set(f.movedIds);
              writeJson(path.join(cacheDir, `messages-${account.id}-INBOX.json`), messages.filter((m) => !movedSet.has(String(m.id))));
            } else {
              writeJson(path.join(cacheDir, `messages-${account.id}-INBOX.json`), messages);
            }
          } catch (fe) {
            ctx?.log?.warn?.("auto_sync.spam_filter_failed", { account: account.id, error: fe.message });
            writeJson(path.join(cacheDir, `messages-${account.id}-INBOX.json`), messages);
          }
        } catch (e) {
          ctx?.log?.warn?.("auto_sync.failed", { account: account.id, error: e.message });
        }
      }
    } finally {
      autoSyncRunning = false;
    }
  }
  setInterval(autoSyncAccounts, AUTO_SYNC_INTERVAL_MS);
  // 启动后 15 秒先做一轮，避免用户等待 3 分钟
  setTimeout(autoSyncAccounts, 15 * 1000);
}
