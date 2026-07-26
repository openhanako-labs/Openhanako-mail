/**
 * AgentQQ CLI 轮询适配器
 * 
 * 通过 agently-cli 命令行工具轮询新邮件，输出格式与 ClawEmail 完全一致，
 * 可无缝接入 monitor.mjs 的统一处理管道。
 * 
 * 轮询间隔：60 秒（可通过 POLL_INTERVAL_SEC 环境变量覆盖）
 * 
 * 依赖：npm install -g @tencent-qqmail/agently-cli
 * 前置条件：agently-cli auth login 已完成 OAuth 授权
 */

/**
 * ⚠️ DEPRECATED - 此文件已被 agentqq-backend.mjs 替代
 * 
 * 原功能：通过 agently-cli 轮询新邮件
 * 现状：轮询逻辑已迁移至 backend/agentqq-backend.mjs + inbox.mjs 统一入口
 * 状态：未使用，待确认无外部依赖后删除
 * 
 * 如果此文件仍在工作，请检查是否有外部脚本直接调用了 pollLoop。
 */

import { spawnSync, spawn } from "node:child_process";

// AgentQQ CLI 绝对路径（Windows npm global）
const AGENTQQ_CLI_PATH = "C:\\Users\\USERNAME\\AppData\\Roaming\\npm\\agently-cli.cmd";

// 执行 CLI 命令（Windows 兼容 .cmd 文件）
function runCli(args, timeout = 15000) {
  // Windows .cmd 文件需要用 cmd.exe /c 调用
  const cmdArgs = ["/c", AGENTQQ_CLI_PATH, ...args];
  const result = spawnSync("cmd.exe", cmdArgs, {
    encoding: "utf-8",
    timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.stdout || result.stderr || "";
}
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ────────────────────────────────────────────────
function getPollInterval() {
  return parseInt(process.env.AGENTQQ_POLL_INTERVAL_SEC || "60", 10);
}
function getAgentQQExtraAddresses() {
  return (process.env.AGENTQQ_EXTRA_ADDRESSES || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

// AgentQQ 地址列表（优先使用 .env 配置，fallback 到 +me 检测）
function getAgentQQAddresses() {
  const AGENTQQ_ADDRESSES = getAgentQQExtraAddresses();
  const addresses = [...AGENTQQ_ADDRESSES.filter(a => a.trim())];
  
  // 如果 .env 没配地址，尝试通过 +me 自动检测
  if (addresses.length === 0) {
    try {
      const result = runCli(["+me"], 15000);
      const data = extractJson(result);
      if (data && data.data && data.data.aliases) {
        const primary = data.data.aliases.find(a => a.is_primary);
        if (primary && primary.email && !addresses.includes(primary.email)) {
          addresses.push(primary.email);
        }
      }
    } catch (e) {
      console.warn("[AGENTQQ] +me 检测失败:", e.message.slice(0, 100));
    }
  }

  return addresses;
}

// ── 提取 JSON 输出（过滤 tip: 等非 JSON 行） ───────────
function extractJson(output) {
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch {}
    }
  }
  return null;
}

// ── 解析 CLI 邮件列表输出 ───────────────────────────────
function parseMessageList(output) {
  const data = extractJson(output);
  if (!data || !data.data) return [];
  return data.data.filter(m => m.id);
}

// ── 调用 CLI 拉取邮件 ───────────────────────────────────
function fetchMessages(address, limit = 10) {
  try {
    const result = runCli(["message", "+list", "--limit", String(limit)], 30000);
    return parseMessageList(result);
  } catch (e) {
    console.warn(`[AGENTQQ] 拉取邮件失败 (${address}):`, e.message.slice(0, 100));
    return [];
  }
}

// ── 调用 CLI 读取邮件详情 ───────────────────────────────
function readMessage(msgId) {
  try {
    const result = runCli(["message", "+read", "--id", msgId], 30000);
    // CLI 输出可能是 JSON 或格式化文本，尝试解析
    try {
      return JSON.parse(result);
    } catch {
      // 如果不是 JSON，返回原始文本
      return { raw: result, id: msgId };
    }
  } catch (e) {
    console.warn(`[AGENTQQ] 读取邮件失败 (${msgId}):`, e.message.slice(0, 100));
    return null;
  }
}

// ── 下载附件 ────────────────────────────────────────────
function downloadAttachment(msgId, attId, outputDir) {
  try {
    runCli(["attachment", "+download", "--msg", msgId, "--att", attId, "--output", outputDir], 60000);
    return true;
  } catch (e) {
    console.warn(`[AGENTQQ] 附件下载失败 (${msgId}/${attId}):`, e.message.slice(0, 100));
    return false;
  }
}

// ── 轮询循环 ────────────────────────────────────────────
async function pollLoop(processCallback, identityMap) {
  const addresses = getAgentQQAddresses();
  
  if (addresses.length === 0) {
    console.warn("[AGENTQQ] 未检测到任何邮箱地址，请检查 CLI 是否已授权");
    return;
  }

  console.log(`[AGENTQQ] 检测到 ${addresses.length} 个邮箱地址`, addresses);

  // 已处理的邮件 ID 集合（按地址分片，避免跨地址冲突）
  const processed = new Map();
  for (const addr of addresses) {
    processed.set(addr, new Set());
  }

  while (true) {
    for (const address of addresses) {
      const addrProcessed = processed.get(address) || new Set();
      
      try {
        const messages = fetchMessages(address, 10);
        
        for (const msg of messages) {
          if (addrProcessed.has(msg.id)) continue;
          
          // 读取邮件详情
          const detail = readMessage(msg.id);
          if (!detail) continue;

          // 构建与 ClawEmail 一致的邮件对象
          const email = {
            id: msg.id,
            from: detail.from || msg.from || "",
            to: detail.to || address,
            subject: detail.subject || msg.subject || "",
            date: detail.date || msg.date || new Date().toISOString(),
            text: { content: detail.text?.content || detail.raw?.split("\n").slice(-5).join("\n") || "" },
            html: detail.html ? { content: detail.html?.content || "" } : null,
            attachments: detail.attachments || [],
            headers: detail.headers || {},
          };

          // 传递给统一处理管道
          await processCallback(email, address, "agentqq");
          
          addrProcessed.add(msg.id);
        }

        processed.set(address, addrProcessed);

      } catch (e) {
        console.error(`[AGENTQQ] 轮询 ${address} 失败:`, e.message.slice(0, 200));
      }
    }

    // 等待下一个轮询周期
    await new Promise(resolve => setTimeout(resolve, getPollInterval() * 1000));
  }
}

// ── 导出 ────────────────────────────────────────────────
export {
  pollLoop,
  fetchMessages,
  readMessage,
  downloadAttachment,
  getAgentQQAddresses,
  parseMessageList,
};
