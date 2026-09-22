/**
 * 日志滚动 —— 统一上限，防止长期运行后无限增长。
 *
 * 起因：ws-monitor.log 从 2026-09-10 起每行 appendFileSync，到 09-22 已 710 KB，
 * 且**没有任何上限**；imap-idle.log 同类问题（只是增长慢些）。
 * 而 runtime/service.mjs 里早就有一套「保留 64 KB、超出后滚到 48 KB」的内联实现 ——
 * 三个日志里只有它一个有。这里把那套抽出来共用，三个日志同一规则。
 *
 * 比较用「字符长度」而非「字节数」，与 service.mjs 既有实现保持一致
 * （中文按 1 字符算，实际字节数会大些，对上限不敏感）。
 */

import fs from "node:fs";

export const LOG_MAX_CHARS = 64 * 1024;
export const LOG_KEEP_CHARS = 48 * 1024;

/**
 * 追加一行日志，超过上限时保留末尾 keepChars 个字符。
 * 任何失败都被吞掉 —— 日志不能影响业务。
 */
export function appendRolling(file, line, maxChars = LOG_MAX_CHARS, keepChars = LOG_KEEP_CHARS) {
  try {
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf-8");
    } catch {
      existing = "";
    }
    const trimmed = existing.length > maxChars ? existing.slice(-keepChars) : existing;
    fs.writeFileSync(file, trimmed + line + "\n", "utf-8");
  } catch {
    /* 日志失败绝不能影响业务 */
  }
}
