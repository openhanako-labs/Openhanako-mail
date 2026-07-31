/**
 * blocklist.mjs — 发件人黑名单 / 白名单（持久化到 backend/data/blocklist.json）
 *
 * 被 6.3 垃圾邮件自动过滤器与「标记垃圾」联动使用：
 *   - 标记垃圾时把发件人加入黑名单
 *   - 自动过滤时，黑名单发件人的邮件直接移到垃圾箱
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "blocklist.json");

function ensure() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function read() {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return { blacklist: Array.isArray(o.blacklist) ? o.blacklist : [], whitelist: Array.isArray(o.whitelist) ? o.whitelist : [] };
  } catch {
    return { blacklist: [], whitelist: [] };
  }
}

function write(obj) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), "utf-8");
}

function norm(email) {
  return (email || "").trim().toLowerCase();
}

export function getBlocklist() {
  return read();
}

export function addToBlacklist(email) {
  const o = read();
  const e = norm(email);
  if (e && !o.blacklist.includes(e)) {
    o.blacklist.push(e);
    write(o);
  }
  return o;
}

export function addToWhitelist(email) {
  const o = read();
  const e = norm(email);
  if (e && !o.whitelist.includes(e)) {
    o.whitelist.push(e);
    // 加入白名单即移出黑名单
    o.blacklist = o.blacklist.filter((x) => x !== e);
    write(o);
  }
  return o;
}

export function removeFromBlacklist(email) {
  const o = read();
  const e = norm(email);
  o.blacklist = o.blacklist.filter((x) => x !== e);
  write(o);
  return o;
}

export function removeFromWhitelist(email) {
  const o = read();
  const e = norm(email);
  o.whitelist = o.whitelist.filter((x) => x !== e);
  write(o);
  return o;
}

export function isBlacklisted(email) {
  return read().blacklist.includes(norm(email));
}

export function isWhitelisted(email) {
  return read().whitelist.includes(norm(email));
}
