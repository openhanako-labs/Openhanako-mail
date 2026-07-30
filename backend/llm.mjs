// ─────────────────────────────────────────────────────────────
// LLM 客户端（OpenAI 兼容 /chat/completions，兼容 Anthropic）
//
// 配置来源优先级（关键修正，对照 hana-code-atlas / 代码图谱）：
//   1) 调用时显式传入的 opts（前端自定义，最高优先级）
//   2) 宿主下发的配置 hostConfig —— 由 routes/ui.js 经 ctx.bus 解析
//      （provider:models-by-type + provider:credentials）后注入，
//      这是「真实可用」的配置，不再依赖不存在的 HANAKO_LLM_* 变量
//   3) 环境变量 HANAKO_LLM_* / OPENAI_* —— 仅作为本地自托管网关的覆盖兜底
//   4) 内置默认值
// ─────────────────────────────────────────────────────────────

// 环境变量仅作本地覆盖兜底（自托管 / 调试用），生产环境由宿主下发。
const ENV_BASE = (process.env.HANAKO_LLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "").replace(/\/$/, "");
const ENV_KEY = process.env.HANAKO_LLM_API_KEY || process.env.OPENAI_API_KEY || "";
const ENV_MODEL = process.env.HANAKO_LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

// 宿主下发的配置（由 setHostLlmConfig 注入），生产环境真实可用。
let hostConfig = null;

/** 由插件主进程（routes/ui.js）注入宿主解析出的真实配置。 */
export function setHostLlmConfig(cfg) {
  if (cfg && typeof cfg === "object") hostConfig = cfg;
}

/** 是否已具备可调用的 LLM 配置。 */
export function llmConfigured() {
  return Boolean((hostConfig && hostConfig.baseUrl) || ENV_BASE);
}

function notConfigured() {
  return "LLM 未配置：宿主未返回可用的模型配置，且未设置 HANAKO_LLM_BASE_URL / OPENAI_BASE_URL 兜底。请在 Hanako 设置中配置至少一个聊天供应商。";
}

function buildRequest(api, baseUrl, apiKey, model, messages, opts) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    const endpoint = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    const sys = messages.find((m) => m.role === "system");
    const userMsgs = messages.filter((m) => m.role !== "system");
    const body = {
      model,
      max_tokens: opts.max_tokens ?? 1500,
      temperature: opts.temperature ?? 0.3,
      system: sys?.content || "",
      messages: userMsgs,
    };
    return { endpoint, headers, body };
  }
  // 默认 OpenAI 兼容 /chat/completions（openai-responses 也走此兼容路径）
  const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const headers = { "content-type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  const body = { model, messages, temperature: opts.temperature ?? 0.3, max_tokens: opts.max_tokens ?? 1500 };
  return { endpoint, headers, body };
}

/**
 * 通用 chat completion 调用
 * @param {string|Array} systemOrMessages 系统提示 或 messages 数组
 * @param {string} [user] 用户内容（当第一个参数是 string 时使用）
 * @param {{temperature?:number, max_tokens?:number, baseUrl?:string, apiKey?:string, model?:string, api?:string}} [opts]
 * @returns {Promise<string>} 模型输出文本
 */
export async function chatCompletion(systemOrMessages, user, opts = {}) {
  let messages;
  if (Array.isArray(systemOrMessages)) {
    messages = systemOrMessages;
  } else {
    messages = [
      { role: "system", content: systemOrMessages },
      { role: "user", content: user || "" },
    ];
  }

  // 配置优先级：opts > 宿主下发 > 环境变量 > 默认
  const baseUrl = opts.baseUrl || hostConfig?.baseUrl || ENV_BASE;
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : (hostConfig?.apiKey ?? ENV_KEY);
  const model = opts.model || hostConfig?.model || ENV_MODEL;
  const api = opts.api || hostConfig?.api || "openai-completions";

  if (!baseUrl) throw new Error(notConfigured());

  const { endpoint, headers, body } = buildRequest(api, baseUrl, apiKey, model, messages, opts);

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LLM 请求失败 ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 返回内容为空");
  return content.trim();
}

// ── 业务封装 ───────────────────────────────────────────────

export async function summarizeMail(text, targetLang = "中文", llmOpts = {}) {
  const system =
    "你是一个邮件助手。请将以下邮件内容总结为简洁的要点，" +
    `使用${targetLang}输出，3-5 条，保留关键信息和待办事项；若邮件很短则直接给出核心内容。` +
    "只输出总结本身，不要多余解释。";
  return chatCompletion(system, text, { temperature: 0.2, max_tokens: 800, ...llmOpts });
}

export async function translateMail(text, targetLang = "中文", llmOpts = {}) {
  const system =
    "你是一个翻译助手。请将以下邮件正文翻译为" +
    `${targetLang}，保留原始段落结构与格式，仅输出译文，不要添加任何解释或前言。`;
  return chatCompletion(system, text, { temperature: 0.1, max_tokens: 2000, ...llmOpts });
}
