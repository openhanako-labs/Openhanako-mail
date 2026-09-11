/**
 * lib/register-routes.mjs — 把 v1 的 HTTP 后端挂到 v2 的路由 app 上。
 *
 * 为什么这个文件在 `http/` 而不在 `routes/`：v2 把顶级 `routes/` 目录当成
 * 另一种路由来源，与 `ctx.routes.register()` **互斥** ——
 * 两边同时存在，整个应用在装载时直接 failed（app-host-entry.js:3233 / 4201）。
 * 目录形式传进来的是 v2 的 ctx（没有 `pluginId`），而这套代码写的是
 * `path.join(ctx.dataDir, ctx.pluginId)`，走目录形式会当场炸。
 * 所以选编程式注册，文件改坐 `http/` —— 名字不同就不撞那条规则。
 *
 * `http/ui.js` 的默认导出形状（app, ctx）与 v1 完全一致，可直接复用。
 * 公开 URL：/api/apps/hanako-mail/routes/<子路径>
 */

import registerUi from "../http/ui.js";

export async function registerRoutes(ctx, lctx) {
  const dispose = await ctx.routes.register((app) => {
    registerUi(app, lctx);
  });
  lctx.log.info("邮件后端路由已挂载", { prefix: "/api/apps/hanako-mail/routes" });
  return dispose;
}
