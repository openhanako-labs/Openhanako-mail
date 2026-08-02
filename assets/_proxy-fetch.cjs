// Standalone external-image fetcher for the Hanako Mail image proxy.
// Runs as a CHILD PROCESS of the plugin (not inside the Hana server's intercepted
// global fetch), so it has normal outbound internet access — same pattern as the
// inbox.mjs CLI. Fetches a single http(s) image, validates it is an image, and
// writes a JSON metadata line to stderr then the raw bytes to stdout.
//
// Protocol (parent reads):
//   success -> stderr: {"ok":true,"ct":"image/png","len":N}   stdout: <binary>
//   error   -> stderr: {"ok":false,"error":"...","code":N}    stdout: (empty)
// Exit code 0 on success, non-zero on error.
//
// Security (SSRF hardening):
//   - 仅允许 http/https，协议白名单
//   - 初始 URL 与每次 302 重定向后的 URL 都重新校验 host（防重定向绕过）
//   - 除 host 字符串匹配外，还做 DNS 解析并校验解析出的 IP（防 DNS rebinding）
//   - 限制响应体积（防内存耗尽）
const https = require("node:https");
const http = require("node:http");
const dns = require("node:dns");

const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1|fc[0-9a-f]{2}:|fe80:)/i;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB 上限

function fail(code, error) {
  process.stderr.write(JSON.stringify({ ok: false, error: String(error), code }) + "\n");
  process.exit(code);
}

function isBlockedHost(host) {
  const h = String(host || "").toLowerCase();
  if (BLOCKED.test(h)) return true;
  // IPv4-mapped IPv6，如 ::ffff:10.0.0.1
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && BLOCKED.test(mapped[1])) return true;
  return false;
}

// 校验 URL（协议 + host 字符串），非法即退出
function checkUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { fail(3, "invalid url"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail(4, "only http/https allowed");
  if (isBlockedHost(parsed.hostname)) fail(5, "blocked host (private/loopback)");
  return parsed;
}

// DNS 解析并校验所有解析 IP（防 DNS rebinding）
function verifyResolved(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) return reject(new Error("dns lookup failed: " + err.message));
      const ips = (addrs || []).map((a) => a.address);
      for (const ip of ips) {
        if (isBlockedHost(ip)) return reject(new Error("blocked resolved ip: " + ip));
      }
      resolve();
    });
  });
}

const target = process.argv[2];
if (!target) fail(2, "url argument required");
checkUrl(target);

async function fetchUrl(u, redirectsLeft) {
  const parsed = checkUrl(u); // 重定向后重新走完整校验
  try {
    await verifyResolved(parsed.hostname);
  } catch (e) {
    fail(5, e.message);
  }

  const lib = parsed.protocol === "https:" ? https : http;
  const req = lib.get(parsed, {
    timeout: 8000,
    headers: { "User-Agent": "Hanako-Mail/1.0", "Accept": "image/*" },
  }, (resp) => {
    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
      if (redirectsLeft <= 0) { resp.resume(); fail(6, "too many redirects"); return; }
      let next;
      try { next = new URL(resp.headers.location, parsed); } catch { resp.resume(); fail(3, "bad redirect location"); return; }
      resp.resume();
      fetchUrl(next, redirectsLeft - 1); // next 在 fetchUrl 内部重新 checkUrl + DNS 校验
      return;
    }
    if (resp.statusCode !== 200) { resp.resume(); fail(6, "upstream " + resp.statusCode); return; }
    const ct = (resp.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("image/")) { resp.resume(); fail(7, "not an image (content-type " + ct + ")"); return; }

    const chunks = [];
    let total = 0;
    resp.on("data", (c) => {
      total += c.length;
      if (total > MAX_BYTES) {
        resp.destroy();
        fail(10, "response too large (>8MB)");
        return;
      }
      chunks.push(c);
    });
    resp.on("end", () => {
      const buf = Buffer.concat(chunks);
      process.stderr.write(JSON.stringify({ ok: true, ct, len: buf.length }) + "\n");
      process.stdout.write(buf);
      process.exit(0);
    });
  });
  req.on("error", (e) => { fail(8, "request error: " + e.message); });
  req.on("timeout", () => { req.destroy(); fail(9, "request timeout"); });
}

fetchUrl(target, 4);
