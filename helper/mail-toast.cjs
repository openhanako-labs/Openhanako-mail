// Mail Toast Helper — 桌面级原生通知弹窗（Windows SnoreToast + node-notifier fallback）
// 用法：
//   node mail-toast.cjs --subject "..." --sender "..." --messageId "..." --accountId "..."
//
// 当用户点击通知时，写入 <tempdir>/hanako-mail-click.json，
// 由插件的轮询逻辑读取 -> 打开邮件详情。

const path = require("path");
const fs = require("fs");
const os = require("os");

// 解析参数
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--(\w+)=(.*)/) || process.argv[i].match(/^--(\w+)\s*(.*)/);
  if (m) args[m[1]] = m[2] || process.argv[i + 1] || "";
}

// 如果传了 --args-file，从 JSON 文件读取参数（UTF-8 安全）
if (args["args-file"]) {
  try {
    const json = JSON.parse(fs.readFileSync(args["args-file"], "utf-8"));
    if (json.subject) args.subject = json.subject;
    if (json.sender) args.sender = json.sender;
    if (json.messageId) args.messageId = json.messageId;
    if (json.accountId) args.accountId = json.accountId;
    if (json.id) args.id = json.id;
  } catch (e) {
    console.error("mail-toast: failed to read args-file:", e.message);
  }
}

const subject = args.subject || "(无主题)";
const sender = args.sender || "(未知发件人)";
const messageId = args.messageId || "";
const accountId = args.accountId || "";
const toastId = args.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clickFile = path.join(os.tmpdir(), "hanako-mail-click.json");

// 查找 node-notifier 模块路径
function findNodeNotifier() {
  const candidates = [
    path.join(__dirname, "..", "node_modules", "node-notifier"),
    path.join(os.homedir(), ".workbuddy", "binaries", "node", "workspace", "node_modules", "node-notifier"),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    } catch {}
  }
  return null;
}
const notifierDir = findNodeNotifier();

// 查找 SnoreToast EXE
function findSnoreToast() {
  if (!notifierDir) return null;
  const td = path.join(notifierDir, "vendor", "snoreToast");
  for (const name of ["snoretoast-x64.exe", "snoretoast-x86.exe"]) {
    const exe = path.join(td, name);
    if (fs.existsSync(exe)) return exe;
  }
  // 还可能直接叫 snoretoast.exe
  const exe = path.join(td, "snoretoast.exe");
  return fs.existsSync(exe) ? exe : null;
}
const snoreExe = findSnoreToast();

// ── 主流程 ──
if (snoreExe) tryNotifyViaSnoreToast();
else if (notifierDir) tryNotifyViaNodeNotifier();
else {
  console.error("mail-toast: no notification method available");
  process.exit(1);
}

// ── 方法 1: SnoreToast（原生 Windows Toast + 点击回调） ──
function tryNotifyViaSnoreToast() {
  const clickCmd = path.join(os.tmpdir(), `hanako-click-${toastId}.cmd`);
  fs.writeFileSync(clickCmd,
    `@echo off\r\n` +
    `echo {"toastId":"${escapeJson(toastId)}","messageId":"${escapeJson(messageId)}","accountId":"${escapeJson(accountId)}"} > "${clickFile}"\r\n`,
    "utf-8"
  );
  const { execFile } = require("child_process");
  const cp = execFile(snoreExe, [
    "-title", "Hanako Mail",
    "-message", `📩 ${subject}`,
    "-appID", "Hanako.Mail",
    "-pipeName", `hanako-mail-${toastId}`,
    "-click", clickCmd,
    "-close", clickCmd,
  ], { timeout: 15000, windowsHide: true }, (err) => {
    try { fs.unlinkSync(clickCmd); } catch {}
    if (err) {
      console.error("mail-toast: SnoreToast failed, trying node-notifier:", err.message);
      if (notifierDir) tryNotifyViaNodeNotifier();
    }
    process.exit(0);
  });
  // 超时退出
  setTimeout(() => process.exit(0), 10000);
}

// ── 方法 2: node-notifier（降级） ──
function tryNotifyViaNodeNotifier() {
  try {
    const notifierPath = path.join(notifierDir, "index.js");
    const notifier = require(notifierPath);
    notifier.notify({
      title: "Hanako Mail",
      message: `📩 ${subject}`,
      sender: sender,
      sound: false,
      wait: false,
      appID: "Hanako.Mail",
    }, (err) => {
      if (err) console.error("mail-toast: node-notifier error:", err.message);
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10000);
  } catch (e) {
    console.error("mail-toast: node-notifier failed:", e.message);
    process.exit(1);
  }
}

function escapeJson(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
