/**
 * net-child.mjs — 借受管服务发一次 HTTP 请求。
 *
 * 历史：v1/v2 早期是「AppHost 里 spawn 一个 node 子进程发请求」，因为 AppHost 的
 * 全局 fetch 被 Hana 拦。v0.3.0 起这条路在 v2 走不通了 —— AppHost 及其子进程都在
 * Node 权限模型里，**出站网络直接 ERR_ACCESS_DENIED**（实测：Node 26 的权限模型
 * 管网络；子进程也没法靠剥环境变量脱身，因为传播不走环境变量）。
 * 现在请求由受管的 native 服务发出（见 runtime/service.mjs 的 /http）。
 *
 * 返回值形状保持不变：{ ok, status?, json?, text?, error? }，网络层失败不抛异常。
 */

import { callService } from "../lib/runtime-host.mjs";

export async function postJson(url, { method = "POST", headers, body, timeoutMs = 120000 } = {}) {
  return await callService("/http", { url, method, headers, body, timeoutMs });
}
