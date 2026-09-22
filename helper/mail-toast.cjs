// Mail Toast Helper — 桌面级原生通知弹窗（Windows SnoreToast + node-notifier fallback）
//
// 用法：
//   node mail-toast.cjs --subject "..." --sender "..." --messageId "..." --accountId "..."
//   node mail-toast.cjs --args-file <json> --work-dir <app-data>
//
// 投递记录（机读，不靠退出码）：
//   <work-dir>/notify-last-result.json —— 每次尝试投递都写一条带时间戳的记录
// 点击回调（用户点了通知）：
//   <work-dir>/notify-click.json —— 具名管道收到 action=activate 时写入
//
// 本文件的两次大修，都在下面各自的注释里写明了原因。

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");

// 解析参数
//
// 三种写法都要认：--key、--key=value、--key value。关键修正在键名的字符集 ——
// 原来只认 \w+，于是 `--args-file <path>` 被解析成 args.args = "-file"，
// `args["args-file"]` 永远是 undefined：**JSON 参数文件从来没有被读过**，
// 主题一直静默退化成「(无主题)」。同理 --work-dir 也会被解析成 args.work。
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--([\w-]+)(?:[=\s]+([\s\S]*))?$/);
  if (!m) continue;
  args[m[1]] = (m[2] !== undefined && m[2] !== "") ? m[2] : (process.argv[i + 1] || "");
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

// ── 工作目录：本文件唯一被允许写的地方 ──
//
// 这是整条通知链路此前**一条都没弹过**的原因。原先把 sidecar 与 click 文件写进
// os.tmpdir()，而本助手是 AppHost 的子进程，**Node 权限模型会继承给子进程**
// （见 README「两个实测结论」第 1 条），写白名单只有「安装目录 + app-data」。
// 于是 fs.writeFileSync 抛 ERR_ACCESS_DENIED，进程在调用 SnoreToast 之前就死了：
//
//   Error: Access to this API has been restricted. Use --allow-fs-write ...
//     at Object.writeFileSync (node:fs:2997:20)
//     at tryNotifyViaSnoreToast (helper/mail-toast.cjs:101:6)
//
// 现在由调用方用 --work-dir 传 app-data；缺省时按 HANAKO_PLUGIN_DATA 自己推断，
// 保证手工单跑（普通 shell，没有权限模型）也能落在一个合理位置。
function resolveWorkDir() {
  const fromArg = args["work-dir"] || args.workdir || "";
  if (fromArg) return fromArg;
  if (process.env.HANAKO_PLUGIN_DATA) return process.env.HANAKO_PLUGIN_DATA;
  return path.join(os.homedir(), ".hanako", "app-data", "hanako-mail");
}
const workDir = resolveWorkDir();
try { fs.mkdirSync(workDir, { recursive: true }); } catch { /* 真正的报错留到写入那一行 */ }

const clickFile = path.join(workDir, "notify-click.json");
const RESULT_FILE = path.join(workDir, "notify-last-result.json");

// 本进程最长活多久。
//
// 带点击回调时它必须活着等管道事件，但不能无限等 ——
// 派发器那边的 execFile timeout 留了更大的余量（40 秒）。
const MAX_LIFE_MS = 25000;

// ── 投递结果：由本助手写下事实，不靠退出码 ──
//
// 为什么要多这个文件：实测 SnoreToast 在通知**已经弹出**的情况下仍然返回 -1
// （node-notifier 自己记的码表是 0=Success / 1=Hidden / 2=Dismissed / 3=TimedOut /
//  4=ButtonPressed / 5=TextEntered / -1=Failed，但实测边界并不可靠）。
// 退出码既证明不了送达、也证明不了失败，于是「取走队列 → 发不出去 → 静默丢弃」
// 这个病就一直藏着。改成：助手每次尝试投递都写一条带时间戳的记录，
// 派发器按「本次 spawn 之后是否出现过 attempted 记录」决定要不要确认删除，
// /notify-status 也直接读它。机读职责从日志移到文件，失败不再只存在于 stderr。
function markAttempt(method, extra) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify({
      at: new Date().toISOString(),
      attempted: true,
      method,
      resultId,
      snoreToastError: snoreError,
      subject,
      accountId,
      messageId,
      ...extra,
    }), "utf-8");
  } catch (e) {
    console.error("mail-toast: 结果文件写入失败:", e.message);
  }
}

/** 没有任何可用通道：明确写「没投递」，让调用方不要误标成功。 */
function markUnavailable(reason) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify({
      at: new Date().toISOString(),
      attempted: false,
      method: "none",
      reason,
      resultId,
      snoreToastError: snoreError,
      subject,
    }), "utf-8");
  } catch { /* 连这里都写不进去，就只能退化成日志了 */ }
}

// 查找 node-notifier 模块路径
function findNodeNotifier() {
  const candidates = [
    // 1) 本应用后端依赖（随包发布，backend/node_modules）
    path.join(__dirname, "..", "backend", "node_modules", "node-notifier"),
    // 2) 仓库根依赖（开发环境）
    path.join(__dirname, "..", "node_modules", "node-notifier"),
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

// ── 点击回调：具名管道，不是 -click ──
//
// SnoreToast 的**标志表里没有 `-click`**。把 snoretoast-x64.exe 按 UTF-16LE
// 读出来扫：`-click` 命中 0，而 `-close` / `-pipeName` / `-install` / `-appID` /
// `-silent` 都在。原来那句 `-click wscript.exe ...` 必然被当成坏参数 ——
// 这正是「点击回调不可用，降级为纯通知」那条日志的来源，
// 也意味着 click.vbs → notify-click.json → /clicks/latest 这条链从未被触发过。
//
// 正确做法（抄 node-notifier 的 notifiers/toaster.js）：
//   1. 自己先建一个具名管道 server；
//   2. 把**完整管道路径**用 -pipeName 传给 SnoreToast；
//   3. SnoreToast 在被点击时以 UTF-16LE 写回 `key=value;`，`action=activate` 即点击；
//   4. **管道的拥有者必须活着**才能收到事件 —— 在旧的自建方案里这意味着助手不能
//      「弹出即 exit」；现在管道归服务，所以这句话的主语是**服务进程**。
//
// 自建管道的那条路**只在普通 shell 单跑诊断时可用**。
//
// 曾经这里写着「Node 权限模型不拦具名管道，所以它在 AppHost 的子进程里可用」—— 那是错的：
// 当时实验跑在系统自带的 Node 24（还没有网络门）上，而生产是 Node 26，
// AppHost 子进程建管道直接 `ERR_ACCESS_DENIED: Use --allow-net to manage permissions`。
// 真实路径一律是调用方用 --pipe-name 把**服务拥有的**管道名交过来。
// 管道名优先由调用方给（--pipe-name）：真实运行时里管道是**服务**建的
// （AppHost 的子进程没有 net 权限），助手只负责把它交给 SnoreToast。
// 没给就自己试一次 —— 那条路只在普通 shell 里能成，用于单机诊断。
const pipeName = args["pipe-name"] || `\\\\.\\pipe\\hana-mail-toast-${toastId}`;
let clickArmed = false;
let ownsPipe = false;
let clickError = "";
// SnoreToast 自己报的错（它没弹成、降级了、或返回 -1）。
//
// 为什么不靠退出码、却又要把它记下来：ack 语义看的是「这一轮派发过了」，
// 所以 SnoreToast 失败不该阻止 ack（否则队列会为了一个永远不成功的条目卡 24 小时）。
// 但它**必须留下痕迹** —— 否则「通知没弹出来」重新变成一个查不到的现象，
// 又是本次所有工作的起点。
let snoreError = "";
// 本次投递的 id，由调用方 --result-id 传入。
// 用途：同一个结果文件被所有 helper 共享，没这个字段就没法区分
// 「我这轮的记录」和「另一个并发 helper（比如测试通知）的记录」。
const resultId = args["result-id"] || "";
let pipeServer = null;

function handlePipePayload(raw) {
  // 格式：key=value;key=value;
  const kv = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
  }
  if (kv.action !== "activate") return;
  try {
    fs.writeFileSync(clickFile, JSON.stringify({
      toastId,
      messageId,
      accountId,
      action: kv.action,
      at: new Date().toISOString(),
    }), "utf-8");
  } catch (e) {
    console.error("mail-toast: 点击记录写入失败:", e.message);
  }
}

function armClickPipe() {
  return new Promise((resolve) => {
    try {
      let handled = false;
      pipeServer = net.createServer((sock) => {
        const chunks = [];
        const settle = () => {
          if (handled) return;
          handled = true;
          handlePipePayload(Buffer.concat(chunks).toString("utf16le"));
          setTimeout(() => process.exit(0), 50);
        };
        sock.on("data", (d) => {
          chunks.push(d);
          // 有些情况下不会收到 end（SnoreToast 写完就走），所以 data 也处理一次；
          // handled 保证不会重复处理。
          const txt = d.toString("utf16le");
          if (txt.includes("action=")) {
            handlePipePayload(txt);
            handled = true;
          }
        });
        sock.on("end", settle);
        sock.on("error", () => { /* 忽略：不影响通知本身 */ });
      });
      pipeServer.once("error", (e) => {
        clickArmed = false;
        clickError = `listen: ${e.code || ""} ${e.message}`;
        console.error("mail-toast: 点击管道不可用，降级为纯通知:", e.message);
        resolve(false);
      });
      pipeServer.listen(pipeName, () => {
        clickArmed = true;
        ownsPipe = true;
        resolve(true);
      });
    } catch (e) {
      clickArmed = false;
      clickError = `createServer: ${e.code || ""} ${e.message}`;
      console.error("mail-toast: 点击管道异常，降级为纯通知:", e.message);
      resolve(false);
    }
  });
}

// ── 主流程 ──
(async function main() {
  // 硬上限：无论如何不让本进程无限活着（派发器不等我们退出，但留个底）。
  setTimeout(() => process.exit(0), MAX_LIFE_MS);

  if (snoreExe) {
    if (args["pipe-name"]) {
      // 管道是别人的（服务建的），我们不必自己建、也不必等事件 ——
      // 点击事件直接落回服务。
      clickArmed = true;
      ownsPipe = false;
    } else {
      await armClickPipe();
    }
    tryNotifyViaSnoreToast();
  } else if (notifierDir) {
    tryNotifyViaNodeNotifier();
  } else {
    const reason = "no notification method available（既无 SnoreToast，也无 node-notifier）";
    console.error("mail-toast:", reason);
    markUnavailable(reason);
    process.exit(1);
  }
})();

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
  const { execFile } = require("child_process");
  // SnoreToast 退出码：0=Success 1=Hidden 2=Dismissed 3=TimedOut（后三者均表示通知已展示，
  // 只是无人点击/超时消失），仅 -1=Failed 是真失败。execFile 把所有非 0 当 error，
  // 必须显式放行 0/1/2/3（v0.1.6 修复：此前把「已弹出但超时消失」误判为失败并降级）。
  const TOAST_OK_CODES = [0, 1, 2, 3];
  const baseArgs = [
    "-t", "Hanako Mail",
    "-m", `新邮件：${subject}`,
    "-appID", "Hanako.Mail",
    "-pipeName", pipeName,
  ];
  // 点击管道没建起来时的纯通知形态（通知本身必须弹出，点击是加分项）
  const plainArgs = [
    "-t", "Hanako Mail",
    "-m", `新邮件：${subject}`,
    "-appID", "Hanako.Mail",
    "-silent",
  ];
  const useArgs = clickArmed ? baseArgs : plainArgs;

  function fire(argv, onFail) {
    // 调下去就算「尝试投递」。退出码此后只用来决定要不要继续降级，
    // 不再用来判断送达 —— 见文件顶部 markAttempt 的说明。
    // clickError 单独记：它是「管道压根没 arm 起来」的根据。
    // 不记它的话，`click:false` 会同时指向两件事 —— 管道未 arm，
    // 或者 arm 了但带管道那次失败后降级到纯通知（markAttempt 被后续调用覆盖）。
    markAttempt("snoretoast", {
      click: clickArmed,
      pipe: clickArmed ? pipeName : "",
      clickError,
    });
    execFile(snoreExe, argv, { timeout: 20000, windowsHide: true }, (err) => {
      if (!err || TOAST_OK_CODES.includes(err.code)) {
        // 通知已展示。管道若由本进程拥有，就交给它收尾（收到事件再退）；
        // 管道属于服务、或本来就没管道，就直接退。
        if (!ownsPipe) process.exit(0);
      } else {
        // 记下来：这次失败必须在结果文件里留痕（见文件顶部 snoreError 的说明）。
        snoreError = String(err.message).split("\n")[0];
        onFail(err);
      }
    });
  }

  fire(useArgs, function (err) {
    if (!retried && !_appIdRegistered) {
      // AppID 未注册是自定义 AUMID toast 失败的常见原因：注册后重试一次
      registerAppId(function () {
        console.error("mail-toast: SnoreToast 失败，已尝试注册 AppID 后重试:", err.message);
        tryNotifyViaSnoreToast(true);
      });
      return;
    }
    console.error("mail-toast: 带管道的通知失败，降级为纯通知:", err.message);
    clickArmed = false;
    ownsPipe = false;
    clickError = `snoretoast-with-pipe: ${err.message}`;
    fire(plainArgs, function (err2) {
      console.error("mail-toast: SnoreToast failed, trying node-notifier:", err2.message);
      if (notifierDir) tryNotifyViaNodeNotifier();
      else {
        markUnavailable("snoretoast: " + err2.message);
        process.exit(1);
      }
    });
  });
}

// ── 方法 2: node-notifier（降级，无点击回调） ──
function tryNotifyViaNodeNotifier() {
  try {
    markAttempt("node-notifier", { click: false });
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
    markUnavailable("node-notifier: " + e.message);
    process.exit(1);
  }
}
