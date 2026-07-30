// ─────────────────────────────────────────────────────────────
// Hanako 宿主模型配置解析
//
// 关键修正（对照 hana-code-atlas / 代码图谱 插件）：
//   邮件插件此前从 HANAKO_LLM_* 环境变量读取模型配置，但这些变量
//   从未被宿主注入，所以永远读不到。正确做法是像代码图谱一样，通过
//   插件上下文 ctx.bus 向 Hanako 宿主请求：
//     - provider:models-by-type  → 可用聊天模型列表
//     - provider:credentials     → 某供应商的 baseUrl + apiKey
//   再由 selectChatModel 选出默认 provider/model。
//
// 仅在插件主进程（routes/ui.js，拥有 ctx）中使用；spawn 出的后端进程
// 通过环境变量拿到解析后的配置即可。
// ─────────────────────────────────────────────────────────────

function normalizeApi(api) {
  const value = String(api || "openai-completions").toLowerCase();
  if (value.startsWith("anthropic")) return "anthropic-messages";
  if (value === "openai-responses") return value;
  if (value.includes("codex")) return "unsupported";
  return "openai-completions";
}

/**
 * 列出宿主中已配置的全部聊天模型（按供应商分组）。
 * @param {object} ctx 插件上下文（需含 ctx.bus.request）
 * @returns {Promise<{ok:boolean, providers:Array, error?:string, detail?:string}>}
 */
export async function listChatModels(ctx) {
  if (!ctx?.bus?.request) return { ok: false, error: "hana_bus_unavailable", providers: [] };
  try {
    const result = await ctx.bus.request("provider:models-by-type", { type: "chat" });
    const models = Array.isArray(result?.models) ? result.models : [];
    const providers = new Map();
    for (const model of models) {
      const providerId = String(model?.provider || "").trim();
      const modelId = String(model?.id || "").trim();
      if (!providerId || !modelId) continue;
      if (!providers.has(providerId)) providers.set(providerId, { models: [], meta: {} });
      const entry = providers.get(providerId);
      if (!entry.models.includes(modelId)) entry.models.push(modelId);
      entry.meta[modelId] = { reasoning: !!model?.reasoning };
    }
    return {
      ok: true,
      providers: [...providers.entries()].map(([id, { models, meta }]) => ({ id, models, modelMeta: meta })),
    };
  } catch (error) {
    return { ok: false, error: "provider_list_failed", detail: error.message, providers: [] };
  }
}

/**
 * 在可用供应商中选出目标模型（与代码图谱逻辑一致）。
 * 优先级：显式 provider+model → 仅显式 model 反查 provider → 默认
 * (deepseek / openai / 第一个可用供应商) 的 models[0]。
 */
export function selectChatModel(providers, requestedProviderId, requestedModel) {
  const available = Array.isArray(providers) ? providers : [];
  const explicitProvider = String(requestedProviderId || "").trim();
  const explicitModel = String(requestedModel || "").trim();
  if (explicitProvider && explicitModel) {
    const provider = available.find((item) => item.id === explicitProvider);
    const reasoning = !!provider?.modelMeta?.[explicitModel]?.reasoning;
    return { ok: true, providerId: explicitProvider, model: explicitModel, reasoning };
  }
  let provider = explicitProvider ? available.find((item) => item.id === explicitProvider) : null;
  if (!provider && explicitModel) provider = available.find((item) => item.models?.includes(explicitModel));
  if (explicitProvider && !provider) return { ok: false, error: "llm_model_required_for_manual_provider" };
  if (!provider) provider = available.find((item) => item.id === "deepseek") || available.find((item) => item.id === "openai") || available[0];
  if (!provider) return { ok: false, error: "llm_provider_not_configured" };
  const model = explicitModel || provider.models?.[0];
  if (!model || !provider.models?.includes(model)) return { ok: false, error: "llm_model_not_available" };
  const reasoning = !!provider.modelMeta?.[model]?.reasoning;
  return { ok: true, providerId: provider.id, model, reasoning };
}

/**
 * 向宿主请求某供应商的凭据（baseUrl + apiKey）。
 */
export async function getProviderCredentials(ctx, providerId) {
  if (!ctx?.bus?.request) return { ok: false, error: "hana_bus_unavailable" };
  try {
    const credentials = await ctx.bus.request("provider:credentials", { providerId });
    if (credentials?.error || !credentials?.apiKey || !credentials?.baseUrl) {
      return { ok: false, error: credentials?.error || "provider_credentials_missing" };
    }
    return {
      ok: true,
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      api: normalizeApi(credentials.api),
    };
  } catch (error) {
    return { ok: false, error: "provider_credentials_failed", detail: error.message };
  }
}

/**
 * 汇总成可直接喂给 llm.mjs 的配置对象：
 *   { ok, providerId, model, baseUrl, apiKey, api }
 * 失败时 ok=false 并返回 error。
 *
 * @param {object} ctx 插件上下文
 * @param {{providerId?:string, model?:string}} [requested] 前端/已存的选择
 */
export async function resolveLlmConfig(ctx, requested = {}) {
  const list = await listChatModels(ctx);
  if (!list.ok) return { ok: false, error: list.error, detail: list.detail };
  const sel = selectChatModel(list.providers, requested.providerId, requested.model);
  if (!sel.ok) return { ok: false, error: sel.error };
  const creds = await getProviderCredentials(ctx, sel.providerId);
  if (!creds.ok) return { ok: false, error: creds.error, detail: creds.detail };
  return {
    ok: true,
    providerId: sel.providerId,
    model: sel.model,
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    api: creds.api,
  };
}
