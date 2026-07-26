/**
 * 访客意识 / Visitor Awareness
 * 
 * 每个监听地址对应一个身份（ophelia / luoqixi / yuexiye ...）。
 * 新邮件到达后，按收件人映射到对应身份，执行该身份的规则。
 * 
 * 对外意识（External Awareness）：
 * 当外部访客（非 owner、非 self、非 internal）发邮件到任意监听地址时，
 * 系统进入"对外模式"——严格隐私过滤、默认不自动回复、限制信息透露范围。
 */

// ── 敏感信息脱敏器 ─────────────────────────────────────
class PrivacyScrubber {
  constructor() {
    // 本地路径模式
    this.pathPatterns = [
      /[A-Za-z]:\\[^\s]+/g,           // C:\Users\...
      /\/[A-Za-z0-9_\-\.\/]+/g,      // /home/user/...
      /~\/([^\s]+)/g,                  // ~/...
      /\[redacted\]/g,
    ];
    // 凭证模式
    this.credentialPatterns = [
      /(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*[^\s]+/gi,
      /sk-[a-zA-Z0-9]{20,}/g,         // OpenAI style keys
      /ck_[a-zA-Z0-9]+/g,             // ClawEmail keys
      /\b\d{4,8}\b/g,                  // 验证码/数字（谨慎处理）
    ];
    // 个人信息模式
    this.personalPatterns = [
      /[\w\.-]+@[\w\.-]+\.\w+/g,      // 邮箱
      /1[3-9]\d{9}/g,                  // 手机号
      /\b\d{18}\b/g,                   // 身份证号
    ];
  }

  scrub(text) {
    if (typeof text !== "string") return text;
    let result = text;
    
    // 脱敏凭证
    for (const pattern of this.credentialPatterns) {
      result = result.replace(pattern, "[REDACTED]");
    }
    // 脱敏个人邮箱（保留域名部分以便分类，但隐藏用户名）
    result = result.replace(/[\w\.-]+@([\w\.-]+\.\w+)/g, "***@$1");
    // 脱敏手机号
    result = result.replace(/1[3-9]\d{9}/g, "138****0000");
    // 脱敏本地路径（只保留最后一级文件名）
    result = result.replace(/[A-Za-z]:\\([^\\]+)\\([^\\]+)\\([^\\]+)/g, "...\\$3");
    result = result.replace(/[A-Za-z]:\\([^\\]+)\\([^\\]+)/g, "...\\$2");
    result = result.replace(/[A-Za-z]:\\([^\\]+)/g, "...\\$1");
    
    return result;
  }
}

// ── 规则引擎 ─────────────────────────────────────────────
class VisitorAwareness {
  constructor(map = {}, internalContacts = []) {
    this.map = new Map(Object.entries(map));
    this.internalContacts = new Set(internalContacts.map(e => e.toLowerCase()));
    this.defaultIdentity = "unknown";
    this.scrubber = new PrivacyScrubber();
  }

  /**
   * 从邮件内容推断收件身份
   */
  resolveIdentity(email) {
    const toField = email.to || "";
    const deliveredTo = email.headers?.["delivered-to"] || email.headers?.["x-original-to"] || "";
    const searchPool = [toField, deliveredTo].filter(Boolean).join(" ").toLowerCase();

    for (const [addr, identity] of this.map) {
      if (searchPool.includes(addr.toLowerCase())) {
        return identity;
      }
    }
    return this.defaultIdentity;
  }

  /**
   * 判断发件人是否为"自己人"
   */
  isSelf(email, accountEmail) {
    const fromArr = Array.isArray(email.from) ? email.from : [email.from || ""];
    return fromArr.some(f => f.includes(accountEmail));
  }

  /**
   * 判断发件人是否为内部联系人
   */
  isInternal(email) {
    const fromArr = Array.isArray(email.from) ? email.from : [email.from || ""];
    const fromStr = fromArr.join(" ").toLowerCase();
    for (const contact of this.internalContacts) {
      if (fromStr.includes(contact)) return true;
    }
    return false;
  }

  /**
   * 对外意识规则
   * external：外部访客
   * - 不自动回复（除非明确白名单）
   * - 严格隐私过滤
   * - 限制信息透露范围
   * - 通知中脱敏
   */
  getExternalAwarenessRules(email, accountEmail) {
    const fromArr = Array.isArray(email.from) ? email.from : [email.from || ""];
    const fromStr = fromArr.join(" ");
    const subjectStr = email.subject || "";
    const textContent = email.text?.content || email.html?.content || "";

    // 验证码白名单：即使外部访客也允许自动提取验证码
    const isCodeWhitelist = /验证码|verification code|verify code/i.test(subjectStr) ||
                            /验证码|verification code|verify code/i.test(textContent);

    // 系统通知白名单：允许通过但不回复
    const isSystemNotification = /noreply@|no-reply@|notifications@/i.test(fromStr) ||
                                  /verify your email|please verify/i.test(subjectStr);

    // 对外意识决策
    const externalDecision = {
      isExternal: true,
      shouldAutoReply: false,           // 默认不自动回复
      shouldNotify: true,               // 通知主人
      shouldExtractCode: isCodeWhitelist, // 验证码提取
      privacyScrub: true,               // 启用脱敏
      allowedInfoScope: "none",         // none / minimal / standard
      replyTemplate: null,              // 可配置的通用回复模板
      reason: "外部访客，触发对外意识",
    };

    // 例外：如果是系统验证邮件，允许通过但不需要回复
    if (isSystemNotification && !isCodeWhitelist) {
      externalDecision.shouldNotify = false;
      externalDecision.reason = "系统通知，跳过";
      return externalDecision;
    }

    // 例外：如果是验证码邮件，允许提取验证码
    if (isCodeWhitelist) {
      externalDecision.shouldExtractCode = true;
      externalDecision.reason = "验证码白名单，提取验证码";
    }

    return externalDecision;
  }

  /**
   * 获取某身份的规则
   */
  getRules(identity, email, accountEmail) {
    const baseRules = {
      ophelia: {
        priority: "high",
        notify: true,
        autoTag: ["ophelia", "assistant"],
        sound: true,
        requireReply: false,
      },
      luoqixi: {
        priority: "high",
        notify: true,
        autoTag: ["luoqixi", "assistant"],
        sound: false,
        requireReply: false,
      },
      yuexiye: {
        priority: "medium",
        notify: true,
        autoTag: ["yuexiye", "owner"],
        sound: true,
        requireReply: false,
      },
      unknown: {
        priority: "low",
        notify: true,
        autoTag: ["unclassified"],
        sound: false,
        requireReply: false,
      },
    };

    let rules = { ...(baseRules[identity] || baseRules.unknown) };

    // 对外意识：如果发件人不是自己人、不是内部联系人，也不是 owner
    if (identity !== "yuexiye" && 
        !this.isSelf(email, accountEmail) && 
        !this.isInternal(email)) {
      const external = this.getExternalAwarenessRules(email, accountEmail);
      rules = { ...rules, ...external };
    }

    return rules;
  }

  /**
   * 完整路由：给定邮件内容和账号，返回 { identity, rules, isExternal }
   */
  route(email, accountEmail) {
    const identity = this.resolveIdentity(email);
    const rules = this.getRules(identity, email, accountEmail);
    const isExternal = rules.isExternal === true;
    return { identity, rules, isExternal };
  }

  /**
   * 脱敏文本（对外部邮件启用）
   */
  scrub(text) {
    return this.scrubber.scrub(text);
  }
}

// ── 从环境变量构建 ────────────────────────────────────────
function buildFromEnv() {
  const raw = process.env.EMAIL_IDENTITY_MAP || "";
  const map = {};

  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const addr = trimmed.slice(0, eqIdx).trim();
    const id = trimmed.slice(eqIdx + 1).trim();
    if (addr && id) {
      map[addr.toLowerCase()] = id.toLowerCase();
    }
  }

  // 内部联系人（可选）
  const internalRaw = process.env.EMAIL_INTERNAL_CONTACTS || "";
  const internalContacts = internalRaw.split(",").map(s => s.trim()).filter(Boolean);

  return new VisitorAwareness(map, internalContacts);
}

// ── 导出 ──────────────────────────────────────────────────
export { VisitorAwareness, buildFromEnv, PrivacyScrubber };
