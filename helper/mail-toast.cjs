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
    // 1) 本插件后端依赖（发布后用户 cd backend && npm install 即有）
    path.join(__dirname, "..", "backend", "node_modules", "node-notifier"),
    // 2) 仓库根依赖（开发环境）
    path.join(__dirname, "..", "node_modules", "node-notifier"),
    // 3) 兜底：WorkBuddy 内置 node workspace（开发机专用，发布环境不依赖）
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
// AppID 注册：Windows 用自定义 AUMID 弹 toast 前必须先 -install 注册
// （创建开始菜单快捷方式 + 注册表 AUMID）。首次失败时自动注册并重试一次（v0.1.6）。
let _appIdRegistered = false;
function registerAppId(cb) {
  if (_appIdRegistered) return cb(true);
  const { execFile } = require("child_process");
  execFile(snoreExe, ["-install", "Hanako Mail", process.execPath, "Hanako.Mail"], {
    windowsHide: true, timeout: 15000,
  }, (e) => {
    _appIdRegistered = true; // 无论成败只尝试一次，避免每次通知都 install
    cb(!e);
  });
}

function tryNotifyViaSnoreToast(retried) {
  // 修复：原先把 messageId/sender 直接插值进 .cmd 批处理脚本，
  // 1) SnoreToast 派生的 cmd 窗口可见，弹窗消失/点击时会闪一下控制台；
  // 2) messageId 含 < > & | % 等元字符会导致 cmd 语法错误（红字一闪）。
  // 现改为：数据写入独立的 sidecar JSON 文件（路径可信、无插值），
  // 再用 wscript.exe 调用无窗口的 click.vbs 完成文件拷贝，彻底消除闪烁与报错。
  const sidecar = path.join(os.tmpdir(), `hanako-click-args-${toastId}.json`);
  fs.writeFileSync(sidecar, JSON.stringify({ toastId, messageId, accountId }), "utf-8");

  const vbs = path.join(__dirname, "click.vbs");
  const clickCmd = `wscript.exe "${vbs}" "${sidecar}" "${clickFile}"`;

  const { execFile } = require("child_process");
  // SnoreToast 退出码：0=Success 1=Hidden 2=Dismissed 3=TimedOut（后三者均表示通知已展示，
  // 只是无人点击/超时消失），仅 -1=Failed 是真失败。execFile 把所有非 0 当 error，
  // 必须显式放行 0/1/2/3（v0.1.6 修复：此前把「已弹出但超时消失」误判为失败并降级）。
  const TOAST_OK_CODES = [0, 1, 2, 3];
  const baseArgs = ["-t", "Hanako Mail", "-m", `新邮件：${subject}`, "-appID", "Hanako.Mail", "-pipeName", `hanako-mail-${toastId}`];
  // 点击回调（点击通知打开邮件详情）：尽力而为，失败时降级为纯通知（通知本身必须弹出）
  const withClickArgs = [...baseArgs, "-click", clickCmd, "-close", clickCmd];
  const plainArgs = [...baseArgs, "-silent"];

  function fire(args, onFail) {
    execFile(snoreExe, args, { timeout: 15000, windowsHide: true }, (err) => {
      if (!err || TOAST_OK_CODES.includes(err.code)) process.exit(0); // 通知已展示
      onFail(err);
    });
  }

  fire(withClickArgs, function (err) {
    try { fs.unlinkSync(sidecar); } catch {}
    if (!retried && !_appIdRegistered) {
      // AppID 未注册是自定义 AUMID toast 失败的常见原因：注册后重试一次
      registerAppId(function () {
        console.error("mail-toast: SnoreToast 失败，已尝试注册 AppID 后重试:", err.message);
        tryNotifyViaSnoreToast(true);
      });
      return;
    }
    // 点击回调不可用 → 降级为纯通知（不传 -click/-close，保证系统通知必达）
    console.error("mail-toast: 点击回调不可用，降级为纯通知:", err.message);
    fire(plainArgs, function (err2) {
      console.error("mail-toast: SnoreToast failed, trying node-notifier:", err2.message);
      if (notifierDir) tryNotifyViaNodeNotifier();
      else process.exit(1);
    });
  });
  // 超时兜底（留出 node-notifier 兜底的余量）
  setTimeout(() => process.exit(0), 15000);
}

// ── 方法 2: node-notifier（降级） ──
function tryNotifyViaNodeNotifier() {
  try {
    const notifierPath = path.join(notifierDir, "index.js");
    const notifier = require(notifierPath);
    notifier.notify({
      title: "Hanako Mail",
      message: `新邮件：${subject}`,
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
