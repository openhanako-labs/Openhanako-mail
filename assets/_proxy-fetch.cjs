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
const https = require("node:https");
const http = require("node:http");

const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1|fc[0-9a-f]{2}:)/i;

function fail(code, error) {
  process.stderr.write(JSON.stringify({ ok: false, error: String(error), code }) + "\n");
  process.exit(code);
}

const target = process.argv[2];
if (!target) fail(2, "url argument required");

let parsed;
try { parsed = new URL(target); } catch { fail(3, "invalid url"); }
if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail(4, "only http/https allowed");

const host = parsed.hostname.toLowerCase();
if (BLOCKED.test(host)) fail(5, "blocked host (private/loopback)");

function fetchUrl(u, redirectsLeft) {
  const lib = u.protocol === "https:" ? https : http;
  const req = lib.get(u, {
    timeout: 8000,
    headers: { "User-Agent": "Hanako-Mail/1.0", "Accept": "image/*" },
  }, (resp) => {
    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
      if (redirectsLeft <= 0) { resp.resume(); fail(6, "too many redirects"); return; }
      let next;
      try { next = new URL(resp.headers.location, u); } catch { resp.resume(); fail(3, "bad redirect location"); return; }
      resp.resume();
      fetchUrl(next, redirectsLeft - 1);
      return;
    }
    if (resp.statusCode !== 200) { resp.resume(); fail(6, "upstream " + resp.statusCode); return; }
    const ct = (resp.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("image/")) { resp.resume(); fail(7, "not an image (content-type " + ct + ")"); return; }

    const chunks = [];
    resp.on("data", (c) => chunks.push(c));
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

fetchUrl(parsed, 4);
