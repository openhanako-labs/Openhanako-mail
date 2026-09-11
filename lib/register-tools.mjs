/**
 * lib/register-tools.mjs — 把 v1 形状的工具模块注册进 v2 工具表。
 *
 * v2 与 v1 的两处工具契约差异都在这里一次抹平，工具模块本身不用改：
 *   1) v1 靠 manifest 的 contributes.tools[] 声明；v2 必须编程式 ctx.tools.register()。
 *   2) v1 工具导出 `execute(input, ctx)` 双参；v2 只调一次，参数里带
 *      `context: { sessionPath, messageId, messageText, callToken }`。
 *
 *   → 注册时把 v2 的单参 payload 拆成 v1 的 (input, ctx) 再转发。
 */

import * as accounts from "../tools/accounts.js";
import * as folders from "../tools/folders.js";
import * as messages from "../tools/messages.js";
import * as send from "../tools/send.js";
import * as sync from "../tools/sync.js";

const MODULES = [accounts, folders, messages, send, sync];

/**
 * @param {object} ctx v2 App ctx
 * @param {object} lctx lib/legacy-ctx 投影出的 v1 形状 ctx
 * @returns {() => void} disposer
 */
export function registerTools(ctx, lctx) {
  const offs = [];

  for (const mod of MODULES) {
    const tool = {
      name: mod.name,
      description: mod.description,
      parameters: mod.parameters,
      // v2 单参调用 → 还原成 v1 的 (input, ctx)
      async execute(payload = {}) {
        const { context, ...input } = payload || {};
        return await mod.execute(input, lctx);
      },
    };
    try {
      const off = ctx.tools.register(tool);
      if (typeof off === "function") offs.push(off);
    } catch (e) {
      lctx.log.error(`工具注册失败: ${mod.name}`, { error: e.message });
    }
  }

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* fiber teardown */ }
    }
  };
}
