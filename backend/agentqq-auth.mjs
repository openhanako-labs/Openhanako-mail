/**
 * agentqq-auth.mjs — AgentQQ（腾讯邮件 Agent）OAuth 设备码授权 + REST 客户端。
 *
 * 为什么不用官方 CLI：`@tencent-qqmail/agently-cli` 是个 Go 原生二进制，
 * `run.js` 只是 execFileSync 它。而本应用的后端跑在受管 native 运行时里，
 * 那个进程被 Windows Job Object 管着、**不能再 spawn**（实测 EPERM）。
 * 好消息：CLI 打的只是普通 REST，服务自己就有网络，所以直连即可 ——
 * 连 `npm install -g` 都不需要了。
 *
 * 协议（全部实测确认，不是文档推测）：
 *   client_id = cli_002e8cd1b1fc89ce      UA 必须是 agently-cli/<版本>（客户端身份靠它）
 *   设备码  POST auth/oauth/device?func=1  body 必须为空
 *           → { poll_url, browser_url, input_code, expires_in }
 *   轮询    POST {poll_url}                长轮询；未授权会一直挂着（超时＝还没授权）
 *   刷新    POST auth/oauth/token         form: grant_type=refresh_token&refresh_token=…&client_id=…
 *   API     https://api.agent.qq.com/v1/…  Authorization: Bearer <access_token>
 */

const CLIENT_ID = "cli_002e8cd1b1fc89ce";
const CLIENT_UA = "agently-cli/1.0.18";
const AUTH_BASE = "https://auth.agent.qq.com";
export const API_BASE = "https://api.agent.qq.com";

const DEVICE_URL = `${AUTH_BASE}/oauth/device?func=1`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;

/** 通用请求：统一 UA、超时、JSON 解析。 */
async function req(url, { method = "GET", headers = {}, body, timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "user-agent": CLIENT_UA, ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* 非 JSON 就回原文 */ }
  return { status: res.status, json, text };
}

/**
 * 第一步：申请设备码。
 * @returns {Promise<{pollUrl:string, browserUrl:string, inputCode:string, expiresIn:number}>}
 */
export async function startDeviceFlow() {
  const r = await req(DEVICE_URL, { method: "POST", timeoutMs: 15000 });
  const d = r.json;
  if (!d || !d.poll_url) {
    throw new Error(`申请设备码失败：${String(r.text).slice(0, 200)}`);
  }
  return {
    pollUrl: d.poll_url,
    browserUrl: d.browser_url || "",
    inputCode: d.input_code || "",
    expiresIn: Number(d.expires_in) || 600,
  };
}

/**
 * 等用户完成授权。**长轮询**：服务端会挂住直到授权成功或超时。
 *
 * 循环的意义：外层超时不代表失败，只代表"还没授权"，要继续等；
 * 只有拿不到 pollUrl、或拿到明确的错误码才算失败。
 *
 * @param {string} pollUrl
 * @param {{deadlineMs:number, onTick?:Function}} opts
 * @returns {Promise<{accessToken:string, refreshToken:string, expiresAt:number}>}
 */
export async function waitForAuthorization(pollUrl, { deadlineMs, onTick } = {}) {
  const deadline = deadlineMs || Date.now() + 10 * 60 * 1000;
  let lastError = null;

  while (Date.now() < deadline) {
    const remainMs = deadline - Date.now();
    try {
      const r = await req(pollUrl, { method: "POST", timeoutMs: Math.min(remainMs, 60000) });
      const d = r.json || {};

      // 授权被拒 / 明确失败
      const errCode = d.err_code ?? d.head?.ret;
      if (errCode && errCode !== 0) {
        // -20007 之类：参数或状态问题，不再重试
        throw new Error(`授权失败（${errCode}）：${d.error_description || d.error || d.head?.msg || ""}`);
      }

      const token = d.access_token || d.result?.access_token;
      if (token) {
        return {
          accessToken: token,
          refreshToken: d.refresh_token || d.result?.refresh_token || "",
          expiresAt: Date.now() + (Number(d.expires_in || d.result?.expires_in) || 7200) * 1000,
        };
      }
      // 没令牌也没错误码：仍是 pending
      lastError = new Error(`未预期的响应：${String(r.text).slice(0, 160)}`);
    } catch (e) {
      // AbortError（本地超时）= 服务端还在等，正常
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        onTick?.();
        continue;
      }
      lastError = e;
      // 明确的服务端拒绝：直接抛出
      if (/授权失败/.test(String(e.message))) throw e;
    }
    onTick?.();
  }
  throw lastError || new Error("授权超时，请重新发起");
}

/**
 * 用 refresh_token 换新的 access_token。
 * @returns {Promise<{accessToken:string, refreshToken:string, expiresAt:number}>}
 */
export async function refreshTokens(refreshToken) {
  if (!refreshToken) throw new Error("缺少 refresh token，需要重新授权");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }).toString();

  const r = await req(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    timeoutMs: 20000,
  });
  const d = r.json || {};
  const token = d.access_token || d.result?.access_token;
  if (!token) {
    throw new Error(`刷新令牌失败：${d.error_description || d.error || String(r.text).slice(0, 160)}`);
  }
  return {
    accessToken: token,
    // 有些实现不返回新的 refresh_token，此时保留旧的
    refreshToken: d.refresh_token || d.result?.refresh_token || refreshToken,
    expiresAt: Date.now() + (Number(d.expires_in || d.result?.expires_in) || 7200) * 1000,
  };
}

/**
 * 调一次 AgentQQ API。
 * @param {string} path 以 / 开头（如 /v1/me）
 * @param {{token:string, method?:string, body?:any, timeoutMs?:number}} opts
 */
export async function apiCall(path, { token, method = "GET", body, timeoutMs = 30000 } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await req(`${API_BASE}${path}`, { method, headers, body: payload, timeoutMs });
  const d = r.json;

  // 统一把错误抛出来，让上层能给出人话
  const errCode = d?.err_code ?? d?.error?.code ?? d?.head?.ret;
  if (r.status >= 400 || (d && d.success === false) || (errCode && errCode !== 0)) {
    const msg = d?.error_description || d?.error?.message || d?.message || d?.head?.msg || d?.error || String(r.text).slice(0, 200);
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = r.status;
    err.code = errCode;
    throw err;
  }
  return d;
}
