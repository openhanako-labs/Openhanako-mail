// ─────────────────────────────────────────────────────────────
// LLM 客户端（OpenAI 兼容 /chat/completions）
//
// 设计：翻译 / 总结走「Hanako 本体 LLM」。端点通过环境变量配置，
// 不写死任何厂商，默认 OpenAI 兼容协议：
//   HANAKO_LLM_BASE_URL  — 必填，如 https://api.openai.com/v1 或本地网关
//   HANAKO_LLM_API_KEY   — 可选（某些本地网关不需要）
//   HANAKO_LLM_MODEL     — 模型名，默认 gpt-4o-mini
// ─────────────────────────────────────────────────────────────

const BASE = (process.env.HANAKO_LLM_BASE_URL || "").replace(/\/$/, "");
const KEY = process.env.HANAKO_LLM_API_KEY || "";
const MODEL = process.env.HANAKO_LLM_MODEL || "gpt-4o-mini";

export function llmConfigured() {
  return Boolean(BASE);
}

function notConfigured() {
  return "LLM 未配置：请在 backend/.env 设置 HANAKO_LLM_BASE_URL（可选 HANAKO_LLM_API_KEY / HANAKO_LLM_MODEL）。";
}

/**
 * 通用 chat completion 调用
 * @param {string|Array} systemOrMessages 系统提示 或 messages 数组
 * @param {string} [user] 用户内容（当第一个参数是 string 时使用）
 * @param {{temperature?:number, max_tokens?:number, baseUrl?:string, apiKey?:string, model?:string}} [opts]
 * @returns {Promise<string>} 模型输出文本
 */
export async function chatCompletion(systemOrMessages, user, opts = {}) {
  // 支持两种调用方式：
  //   chatCompletion(systemPrompt, userText, opts)
  //   chatCompletion(messagesArray, null, { baseUrl, apiKey, model })
  let messages;
  if (Array.isArray(systemOrMessages)) {
    messages = systemOrMessages;
  } else {
    messages = [
      { role: "system", content: systemOrMessages },
      { role: "user", content: user || "" },
    ];
  }

  const baseUrl = (opts.baseUrl || BASE || "").replace(/\/$/, "");
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : KEY;
  const model = opts.model || MODEL;

  if (!baseUrl) throw new Error(notConfigured());

  const url = `${baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens ?? 1500,
    }),
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
