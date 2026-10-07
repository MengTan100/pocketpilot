// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:0f500eefe1​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
'use strict';
/**
 * bridge.js —— PocketPilot 守护进程（PC 端）
 *
 * 架构定位：
 *   手机 (Operit AI / 任意浏览器)
 *        │  ① USB: adb reverse tcp:3080 / tcp:3081  →  PC 回环
 *        │  ② 局域网: Bridge 绑 0.0.0.0 + 强随机 token
 *        ▼
 *   Bridge (本文件, 默认 :3080)  ──控制面──▶  DSH Web (:3081, 受管子进程)
 *                                            └─ 真正的 Agent 运行时
 *
 * 手机要做的三件事：
 *   - GET  /handshake  拿 DSH 的带 token URL 与本次会话凭据
 *   - POST /chat       发指令并同步等回复（长任务用 /task 异步）
 *   - 浏览器/WebView 打开 handshake 返回的 dsh.authenticatedUrl 操作完整 UI
 *
 * 安全模型：
 *   - Bridge 自身用随机 bridgeToken 鉴权（/health 与 USB 模式下的 /handshake 例外）
 *   - DSH 侧仍是它原生的 launch token + 签名 Cookie，Bridge 代为持有
 *   - 局域网模式必须显式开启，并要求 bridgeToken
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, execFile } = require('node:child_process');

const { DshClient, DEFAULT_TIMEOUT_MS } = require('./lib/dsh-client');
const { mintCookie, probeInstance } = require('./lib/desktop-auth');
const { createDshProxy } = require('./lib/dsh-proxy');
// Cloudflare Tunnel：异地（不同网络）访问用。
// PC 在 NAT 后无公网入口，而手机端不装额外 App，只能由 PC 主动出站建隧道。
const { createTunnel } = require('./lib/tunnel');

/** 二维码生成：局部依赖，缺失时降级为纯文本配对信息。 */
let qrcode = null;
try {
  qrcode = require('qrcode');
} catch {
  // 此处 log() 尚未定义，直接用 console
  console.log('[warn] 未安装 qrcode，/pair 将只显示文本配对信息');
}

const BRIDGE_VERSION = '1.0.0';
/**
 * 项目出处指纹（水印第 4 层：运行时/构建指纹）。
 * 出现在：启动日志、状态页 HTML 注释、runtime/bridge-runtime.json。
 * 作用：一份被拷走/改名分发的桥接，仍能据此确认出处。见 WATERMARK.md。
 */
const ORIGIN_MARK = 'dsh-phone-bridge/DSPB2026';
const ROOT = __dirname;
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const LOG_DIR = path.join(ROOT, 'logs');
const CONFIG_PATH = path.join(ROOT, 'bridge.config.json');
const RUNTIME_PATH = path.join(RUNTIME_DIR, 'bridge-runtime.json');
const LOG_PATH = path.join(LOG_DIR, 'bridge.log');

fs.mkdirSync(RUNTIME_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------- 工具函数

/**
 * 只保留密钥的首尾各 4 位，中间打码。
 * 用于日志：既能确认"还是不是同一个令牌"，又不会因为日志外泄而交出访问权限。
 */
function maskSecret(value) {
  const text = String(value || '');
  if (text.length <= 10) return '***';
  return `${text.slice(0, 4)}…${text.slice(-4)}（共 ${text.length} 位，已打码）`;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 写 UTF-8 无 BOM JSON（避免外部工具写入 BOM 造成解析崩溃）。 */
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findAdb() {
  const candidates = [
    process.env.DSH_BRIDGE_ADB,
    'C:\\AndroidSDK\\platform-tools\\adb.exe',
    'C:\\android-sdk-x\\platform-tools\\adb.exe',
    'C:\\asdk\\platform-tools\\adb.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    'adb',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'adb') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'adb';
}

function findDshCli() {
  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [
    process.env.DSH_BRIDGE_CLI,
    path.join(home, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/** 枚举本机可用的局域网 IPv4 地址（排除回环）。 */
/**
 * 本机全部可用的 IPv4 地址（供手机端择优）。
 *
 * 过滤掉两类不可用地址：
 *  - 169.254.* link-local：路由不可达，典型来源是尚未登录的 Tailscale 网卡；
 *  - 回环由调用方另行补充，不在此列。
 * 虚拟网卡（Tailscale 100.x、ZeroTier 等）会被保留 —— 它们是跨网络访问的入口。
 */
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      out.push({ name, address: entry.address });
    }
  }
  return out;
}

const DEFAULT_CONFIG = {
  mode: 'usb',
  bridgePort: 3080,
  dshPort: 3081,
  // 专用 profile：不加载 web profile 里版本错配的本地插件，走全局一致的官方包
  dshProfile: 'bridge',
  dshHost: '127.0.0.1',
  workspace: path.join(os.homedir(), 'dsh-phone-workspace'),
  // 是否允许把隧道建到模拟器上（默认否；模拟器可直接访问宿主机，不需要 reverse）
  allowEmulator: false,
  // 手机任务需要免值守执行；DSH 的审批应答走流通道，HTTP RPC 无法代答，
  // 因此用 danger-full-access 预设（approval=never）并在任务结束后自动恢复原预设。
  permissionPreset: 'danger-full-access',
  // 桌面端实例：手机首选连它，才能看到"当前正在进行的对话与任务"（实时状态在它内存里）。
  // 它的 launch token 不可获取，但 Cookie 签名密钥持久化在凭据里，可自签 Cookie 进入。
  preferDesktop: true,
  desktopHost: '127.0.0.1',
  desktopPort: 19387,
  dshHome: path.join(os.homedir(), '.dsh'),
  deviceSerial: '',
  trustedHosts: [],
  autoTunnel: true,
  // Cloudflare 隧道（异地/跨网络访问）。默认关闭：
  // 它会为桥接开一个公网入口，属于"扩大暴露面"的操作，必须由用户显式开启
  // （命令行 --tunnel，或配置里 enableTunnel: true）。
  enableTunnel: false,
  // 留空则用内置路径 tools/bin/cloudflared.exe
  tunnelBinary: '',
  keepDshOnExit: false,
  pushHandshakeToDevice: false,
  maxConcurrentTasks: 2,
  bridgeToken: crypto.randomBytes(24).toString('base64url'),
};

/** 按运行模式推导派生配置。 */
function applyModeRules(merged) {
  // DSH 官方禁止绑定 0.0.0.0：
  //   error: --host 0.0.0.0 is intentionally not supported yet for safety
  // 因此上游 DSH 无论哪种模式都只绑回环，"对外可用"由 Bridge 的反向代理负责。
  merged.dshHost = '127.0.0.1';
  merged.lanAddresses = lanAddresses();
  return merged;
}

/** 命令行覆盖：--mode usb|lan、--port、--profile、--workspace。 */
function applyCliOverrides(config) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--mode' && next) { config.mode = next; i += 1; }
    else if (arg === '--port' && next) { config.bridgePort = Number(next); i += 1; }
    else if (arg === '--profile' && next) { config.dshProfile = next; i += 1; }
    else if (arg === '--workspace' && next) { config.workspace = next; i += 1; }
    // 异地通道：--tunnel 开启 Cloudflare 隧道；--no-tunnel 关闭
    else if (arg === '--tunnel') { config.enableTunnel = true; }
    else if (arg === '--no-tunnel') { config.enableTunnel = false; }
    else if (arg === '--tunnel-binary' && next) { config.tunnelBinary = next; i += 1; }
  }
  return applyModeRules(config);
}

function loadConfig() {
  const existing = readJson(CONFIG_PATH);
  let merged;
  if (!existing) {
    writeJson(CONFIG_PATH, DEFAULT_CONFIG);
    log(`已生成默认配置：${CONFIG_PATH}`);
    merged = { ...DEFAULT_CONFIG };
  } else {
    merged = { ...DEFAULT_CONFIG, ...existing };
    if (!existing.bridgeToken) {
      merged.bridgeToken = DEFAULT_CONFIG.bridgeToken;
      writeJson(CONFIG_PATH, merged);
    }
  }
  // 局域网模式：DSH 必须绑到可被外部访问的地址，并放行本机网卡 authority
  applyModeRules(merged);
  // 派生字段不写入配置文件，每次解析
  merged.adbPath = findAdb();
  merged.dshCli = findDshCli();
  return merged;
}

// ---------------------------------------------------------------- ADB 隧道

const tunnel = {
  adbPath: 'adb',
  deviceSerial: '',
  devices: [],
  mappings: [],
  lastError: null,
  lastSyncAt: null,
  usbConnected: false,
};

function adbExec(args, timeoutMs = 15000) {
  const adb = tunnel.adbPath || findAdb();
  return new Promise((resolve) => {
    execFile(adb, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? error.message : null,
      });
    });
  });
}

async function listDevices() {
  const res = await adbExec(['devices', '-l']);
  if (!res.ok && !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      const model = (/model:(\S+)/.exec(line) || [])[1] || '';
      return { serial, state, model, emulator: serial.startsWith('emulator-') };
    })
    .filter((device) => device.serial && device.state);
}

/**
 * 选择目标设备：优先显式配置，其次真机。
 *
 * 默认**不**回退到模拟器：模拟器本身就能直接访问宿主机，
 * adb reverse 对它没有意义，反而会把隧道建到错误设备上
 * （表现为 runtime 里 deviceSerial=emulator-xxxx、mappings 前缀变成 host-xx）。
 * 确需调试模拟器时显式打开 config.allowEmulator。
 */
function pickDevice(devices, config) {
  const online = devices.filter((d) => d.state === 'device');
  if (config.deviceSerial) {
    const hit = online.find((d) => d.serial === config.deviceSerial);
    if (hit) return hit;
  }
  const real = online.filter((d) => !d.emulator);
  if (real.length > 0) return real[0];
  if (config.allowEmulator) return online[0] || null;
  return null;
}

/** 解析 `adb reverse --list`：形如 `UsbFfs tcp:3081 tcp:19387`（remote=手机侧, local=PC侧）。 */
function parseReverseList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /tcp:(\d+)\s+tcp:(\d+)/.exec(line);
    if (match) out.push({ remote: Number(match[1]), local: Number(match[2]) });
  }
  return out;
}

/** 建立/修复 adb reverse 映射。 */
async function syncTunnel(config) {
  tunnel.adbPath = config.adbPath;
  const devices = await listDevices();
  tunnel.devices = devices;
  const device = pickDevice(devices, config);
  tunnel.usbConnected = Boolean(device);

  if (!device) {
    tunnel.deviceSerial = '';
    tunnel.mappings = [];
    tunnel.lastError = '没有处于 device 状态的 ADB 设备';
    tunnel.lastSyncAt = Date.now();
    return tunnel;
  }
  tunnel.deviceSerial = device.serial;

  if (!config.autoTunnel) {
    tunnel.lastError = 'autoTunnel 已关闭';
    tunnel.lastSyncAt = Date.now();
    return tunnel;
  }

  const current = await adbExec(['-s', device.serial, 'reverse', '--list']);
  const parsed = parseReverseList(current.stdout);
  const wanted = [config.bridgePort, config.dshPort];
  // 桌面端实例也要能被手机访问，否则面板无法连上"当前对话"
  if (config.preferDesktop) wanted.push(config.desktopPort);

  for (const port of wanted) {
    // 端口已被占用但指向别处（例如手工建到桌面端 19387），必须先拆除再重建
    const conflict = parsed.find((entry) => entry.remote === port && entry.local !== port);
    if (conflict) {
      log(`隧道冲突：手机 ${port} 当前指向 PC ${conflict.local}，重建为 PC ${port}`);
      await adbExec(['-s', device.serial, 'reverse', '--remove', `tcp:${port}`]);
      parsed.splice(parsed.indexOf(conflict), 1);
    }

    const healthy = parsed.some((entry) => entry.remote === port && entry.local === port);
    if (!healthy) {
      const res = await adbExec(['-s', device.serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
      if (!res.ok) {
        tunnel.lastError = `建立 reverse tcp:${port} 失败：${res.stderr || res.error}`;
        log(tunnel.lastError);
      } else {
        log(`反向隧道就绪：手机 127.0.0.1:${port} → PC ${port}`);
        parsed.push({ remote: port, local: port });
      }
    }
  }

  const after = await adbExec(['-s', device.serial, 'reverse', '--list']);
  tunnel.mappings = after.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (tunnel.mappings.length > 0 && !tunnel.lastError) tunnel.lastError = null;
  tunnel.lastSyncAt = Date.now();
  return tunnel;
}

/** USB 模式下把握手信息推到手机共享目录（可选，便于 ToolPkg 免网络读取）。 */
async function pushHandshakeToDevice(config, payload) {
  if (!config.pushHandshakeToDevice || !tunnel.deviceSerial) return;
  const local = path.join(RUNTIME_DIR, 'handshake.json');
  writeJson(local, payload);
  const remoteDir = '/sdcard/Download/dsh-bridge';
  await adbExec(['-s', tunnel.deviceSerial, 'shell', 'mkdir', '-p', remoteDir], 10000);
  const res = await adbExec(['-s', tunnel.deviceSerial, 'push', local, `${remoteDir}/handshake.json`], 20000);
  if (!res.ok) log(`推送握手文件失败：${res.stderr || res.error}`);
}

// ---------------------------------------------------------------- 任务队列

/** @type {Map<string, any>} */
const tasks = new Map();
let runningTasks = 0;
const taskQueue = [];

function taskSummary(task) {
  return {
    taskId: task.id,
    status: task.status,
    message: task.message,
    sessionId: task.sessionId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    elapsedMs: Date.now() - task.createdAt,
    reply: task.reply ?? null,
    error: task.error ?? null,
  };
}

function drainQueue() {
  while (runningTasks < Math.max(1, config.maxConcurrentTasks) && taskQueue.length > 0) {
    const task = taskQueue.shift();
    if (!task || task.status === 'cancelled') continue;
    runningTasks += 1;
    runTask(task).finally(() => {
      runningTasks -= 1;
      drainQueue();
    });
  }
}

async function runTask(task) {
  task.status = 'running';
  task.updatedAt = Date.now();
  try {
    await dsh.withPermissionPreset(config.permissionPreset, async () => {
      const submitted = await dsh.prompt({
        message: task.message,
        sessionId: task.sessionId,
        cwd: task.cwd,
      });
      task.sessionId = submitted.sessionId;
      task.baselineSeq = submitted.baselineSeq;
      if (!submitted.accepted) throw new Error('DSH 未接受该消息（accepted=false）。');
      const reply = await dsh.waitForReply({
        sessionId: task.sessionId,
        message: task.message,
        baselineSeq: task.baselineSeq,
        timeoutMs: task.timeoutMs,
      });
      task.reply = reply.text;
      task.status = 'completed';
    });
  } catch (error) {
    task.error = error && error.message ? error.message : String(error);
    task.status = error && error.timeout ? 'timeout' : 'failed';
  } finally {
    task.updatedAt = Date.now();
    log(`任务 ${task.id} 结束：${task.status}`);
  }
}

// ---------------------------------------------------------------- 全局状态

const config = applyCliOverrides(loadConfig());
const dsh = new DshClient({
  cli: config.dshCli,
  profile: config.dshProfile,
  port: config.dshPort,
  host: config.dshHost,
  workspace: config.workspace,
  trustedHosts: config.trustedHosts,
  log,
});

dsh.onExit = (code) => {
  log(`DSH 异常退出（code=${code}），3 秒后自动重启`);
  setTimeout(() => {
    dsh.start().catch((error) => log(`DSH 重启失败：${error.message}`));
  }, 3000);
};

// ---------------------------------------------------------------- 异地通道

/**
 * Cloudflare 隧道实例（异地/跨网络访问用）。
 *
 * 只在配置里开启时才建立。地址是临时的（trycloudflare.com），
 * 每次重启会变，因此统一由 /pair.json 与配对页发布给手机，
 * App 每次配对/握手都会取到当前有效地址。
 *
 * 安全边界：隧道只指向桥接端口，不直接暴露 DSH；
 * 桥接自身的 token 鉴权在隧道之上依然生效（隧道不绕过鉴权）。
 */
const tunnelBinary = config.tunnelBinary || path.join(__dirname, 'tools', 'bin', 'cloudflared.exe');
// 注意命名：文件前面已有一个 tunnel 常量（ADB 隧道），这里必须区分开
const cfTunnel = config.enableTunnel
  ? createTunnel({
      binary: tunnelBinary,
      target: `http://127.0.0.1:${config.bridgePort}`,
      log,
    })
  : null;

if (cfTunnel) {
  log(`异地通道已启用，正在建立隧道（binary=${tunnelBinary}）`);
  const r = cfTunnel.start();
  if (!r.ok) log(`隧道启动失败：${r.error}`);
}

// ---------------------------------------------------------------- 桌面端直连

/**
 * 桌面端实例状态。手机首选连它：只有它持有"当前会话 + 正在跑的任务 + 审批弹窗"
 * 这些实时状态；桥接实例虽然共享会话存储，但看不到实时流。
 */
const desktop = {
  alive: false,
  status: 0,
  requiresAuth: false,
  cookieReady: false,
  lastError: null,
  checkedAt: 0,
};

/** 探测桌面端实例；结果缓存 5 秒，避免频繁打扰。 */
async function refreshDesktopState(force) {
  if (!config.preferDesktop) {
    desktop.alive = false;
    desktop.lastError = 'preferDesktop 已关闭';
    return desktop;
  }
  if (!force && Date.now() - desktop.checkedAt < 5000) return desktop;
  try {
    const probe = await probeInstance(config.desktopHost, config.desktopPort);
    desktop.alive = probe.alive;
    desktop.status = probe.status;
    desktop.requiresAuth = probe.requiresAuth;
    desktop.lastError = null;
  } catch (error) {
    desktop.alive = false;
    desktop.lastError = error.message;
  }
  desktop.checkedAt = Date.now();
  return desktop;
}

/** 为桌面端 authority 现签一个会话 Cookie（密钥持久化在凭据里）。 */
function desktopCookie() {
  const authority = `${config.desktopHost}:${config.desktopPort}`;
  const cookie = mintCookie({ homeDir: config.dshHome, authority });
  desktop.cookieReady = true;
  return cookie;
}

/**
 * 手机面板应该加载的入口地址。
 *
 * 统一走 Bridge 反代（USB 与局域网同一套入口，并顺带补静态资源缓存头）。
 * 局域网模式下必须带上访问令牌 ?k= —— 面板无法自己拼，所以由这里给出完整地址；
 * 优先用局域网 IP（不依赖数据线），拿不到网卡时退回回环（仍可经 adb reverse 生效）。
 */
function phoneEntryUrl() {
  if (config.mode === 'lan') {
    const host = config.lanAddresses.length > 0 ? config.lanAddresses[0].address : '127.0.0.1';
    return `http://${host}:${config.bridgePort}/dsh/?k=${encodeURIComponent(config.bridgeToken)}`;
  }
  return `http://127.0.0.1:${config.bridgePort}/dsh/`;
}

// ---------------------------------------------------------------- 反向代理

/**
 * 反代的当前上游：优先桌面端实例（能看到当前对话与实时任务），
 * 否则回退到桥接实例。两者都只监听回环，由本代理对外。
 */
function getProxyUpstream() {
  if (config.preferDesktop && desktop.alive) {
    try {
      const cookie = desktopCookie();
      return {
        host: config.desktopHost,
        port: config.desktopPort,
        authority: `${config.desktopHost}:${config.desktopPort}`,
        cookie: `${cookie.name}=${cookie.value}`,
      };
    } catch (error) {
      log(`桌面端 Cookie 生成失败，改用桥接实例：${error.message}`);
    }
  }
  if (dsh.running && dsh.cookie) {
    return {
      host: config.dshHost,
      port: config.dshPort,
      authority: `${config.dshHost}:${config.dshPort}`,
      cookie: dsh.cookie,
    };
  }
  return null;
}

/**
 * 让上游重新签名会话 cookie。
 *
 * 用在代理层检测到 401 时：DSH 桌面端重启后签名密钥可能变化，
 * 桥接手里的 cookie 随之失效。
 * 注意 desktopCookie() 本身就是"每次调用现签"（mintCookie 读凭据里的密钥），
 * 所以重试时自然会拿到新 cookie；这里只需让桌面端存活状态重新探测一次，
 * 保证 getProxyUpstream() 选到正确的上游。
 */
function refreshProxyUpstream() {
  refreshDesktopState(false).catch(() => {});
}

const proxy = createDshProxy({
  getUpstream: getProxyUpstream,
  refreshUpstream: refreshProxyUpstream,
  log,
});

const BRIDGE_AUTH_COOKIE = 'dsh-bridge-auth';

/**
 * 反代入口的访问控制。
 * USB 模式：桥接只绑回环、且仅经 adb reverse 暴露给手机，故直接放行；
 * 局域网模式：DSH 界面能执行任意代码，必须凭桥接令牌访问，校验后下发 Cookie。
 */
  /**
   * 恒定时间比较桥接令牌。长度不同直接 false（timingSafeEqual 要求等长）。
   * 替代原先散落三处的 indexOf 子串比较 —— 那种写法既是子串匹配（前缀对就算过）、
   * 又不是恒定时间，还与 authorize() 的实现不一致。
   */
  function tokenEquals(provided) {
    const a = Buffer.from(String(provided == null ? '' : provided), 'utf8');
    const b = Buffer.from(config.bridgeToken, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** 从 Cookie 头里取出本桥接的鉴权 cookie 值（按名精确匹配，不用子串）。 */
  function bridgeCookieValue(cookieHeader) {
    for (const part of String(cookieHeader || '').split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === BRIDGE_AUTH_COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  }

  /**
   * 反代入口的访问控制。
   * ⚠️ 必须**先算来源、再算模式**：mode 只描述「手机是如何连进来的」，
   * 不能当作「这个请求可不可信」的依据 —— 隧道把请求落在 127.0.0.1（来源看起来就是本机），
   * 但它来自公网。曾经写成 `if (config.mode !== 'lan') return true;`，于是 usb 模式 + 开隧道时，
   * 任何人访问 https://<隧道域名>/dsh/ 都能**无令牌**进入完整 DSH 界面
   * （permissionPreset 默认 danger-full-access），等于把电脑远程执行权挂到公网。
   */
  function authorizeDshAccess(req, url, res) {
    const external = isExternalRequest(req);
    if (!external && config.mode !== 'lan') return true;   // 仅「本机/内网 + 非局域网模式」才免令牌
    const cookieHeader = String(req.headers.cookie || '');
    if (tokenEquals(bridgeCookieValue(cookieHeader))) return true;
    if (tokenEquals(url.searchParams.get('k'))) {
    res.setHeader('Set-Cookie',
      `${BRIDGE_AUTH_COOKIE}=${config.bridgeToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
    return true;
  }
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('局域网访问需要令牌：请在地址后追加 ?k=<bridgeToken>（见 PC 端 runtime\\bridge-runtime.json）\n');
  return false;
}

function bridgeRuntime() {
  const status = dsh.status();
  return {
    service: 'dsh-phone-bridge',
    version: BRIDGE_VERSION,
    // 出处指纹：运维/取证时据此确认这份 runtime 状态来自原始项目（见 WATERMARK.md）
    origin: ORIGIN_MARK,
    generatedAt: new Date().toISOString(),
    mode: config.mode,
    bridgePort: config.bridgePort,
    bridgeToken: config.bridgeToken,
    permissionPreset: config.permissionPreset,
    workspace: config.workspace,
    dsh: {
      profile: config.dshProfile,
      running: status.running,
      pid: status.pid,
      host: status.host,
      port: status.port,
      baseUrl: status.baseUrl,
      authenticatedUrl: status.authenticatedUrl,
      startedAt: status.startedAt,
    },
    tunnel: {
      usbConnected: tunnel.usbConnected,
      deviceSerial: tunnel.deviceSerial,
      devices: tunnel.devices,
      mappings: tunnel.mappings,
      lastError: tunnel.lastError,
    },
    desktop: {
      enabled: config.preferDesktop,
      alive: desktop.alive,
      host: config.desktopHost,
      port: config.desktopPort,
      status: desktop.status,
      entryUrl: phoneEntryUrl(),
      lastError: desktop.lastError,
    },
    endpoints: {
      handshake: `http://<pc>:${config.bridgePort}/handshake`,
      chat: `http://<pc>:${config.bridgePort}/chat`,
      task: `http://<pc>:${config.bridgePort}/task`,
      dshUi: status.authenticatedUrl,
      // 手机端可选入口：USB 经 adb reverse 用 127.0.0.1，局域网用下面这些
      usbBase: `http://127.0.0.1:${config.bridgePort}`,
      lanBases: config.lanAddresses.map((entry) => `http://${entry.address}:${config.bridgePort}`),
      lanInterfaces: config.lanAddresses,
      // 统一入口：桥接反代（内部自动选桌面端/桥接实例，并补静态资源缓存头）
      proxyEntry: phoneEntryUrl(),
      proxyEntryLan: config.lanAddresses.map((entry) => `http://${entry.address}:${config.bridgePort}/dsh/`
        + (config.mode === 'lan' ? `?k=${config.bridgeToken}` : '')),
    },
  };
}

async function publishRuntime() {
  const runtime = bridgeRuntime();
  writeJson(RUNTIME_PATH, runtime);
  await pushHandshakeToDevice(config, runtime);
}

// ---------------------------------------------------------------- HTTP API

// /pair/claim 用配对码作凭证，因此本身无需 bridge token（内部另有限速）。
const PUBLIC_PATHS = new Set(['/health', '/', '/pair/claim']);

/**
 * 判断请求是否来自"公网/隧道"一侧。
 *
 * 依据（任一成立即视为外部）：
 *   1. Host 头是隧道域名（trycloudflare.com）—— 最直接可靠；
 *   2. 带了 Cloudflare 的 cf-connecting-ip 头 —— 说明确实过了 CF 边缘；
 *   3. 来源地址不是回环、也不是内网网段。
 *
 * 这个判据用于给公开端点降级：本机/局域网可看完整信息，
 * 公网只能拿到最小必要信息，避免把部署细节喂给扫描器。
 */
function isExternalRequest(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (/trycloudflare\.com|\.cfargotunnel\.com/.test(host)) return true;
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return true;

  const addr = (req.socket && req.socket.remoteAddress) || '';
  const ip = addr.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return false;
  if (/^10\./.test(ip)) return false;
  if (/^192\.168\./.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  if (/^169\.254\./.test(ip)) return false;
  return true;
}

/**
 * 安全审计日志：记录"谁、从哪、访问了什么、结果如何"。
 * 出问题时这是唯一能回溯的依据，因此对公网请求一律记录，
 * 对鉴权失败单独标记（便于发现扫描与爆破）。
 */
function auditLog(req, route, outcome, extra = '') {
  const addr = (req.socket && req.socket.remoteAddress) || '-';
  const ip = addr.replace(/^::ffff:/, '');
  const external = isExternalRequest(req) ? '外部' : '本地';
  const line = `${external} ${ip} ${req.method} ${route} → ${outcome}${extra ? ' ' + extra : ''}`;
  if (outcome === 'DENY' || outcome === 'UNAUTHORIZED') {
    log(`[安全] ${line}`);
  } else if (external === '外部') {
    log(`[访问] ${line}`);
  }
}

function authorize(req, body) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const fromHeader = req.headers['x-bridge-token'];
  // ?k= 与 /dsh/ 入口保持一致，?token= 作为兼容保留
  const fromQuery = url.searchParams.get('k') || url.searchParams.get('token');
  const fromCookie = (req.headers.cookie || '').indexOf(`${BRIDGE_AUTH_COOKIE}=${config.bridgeToken}`) !== -1;
  const fromBody = body && typeof body.token === 'string' ? body.token : null;
  const provided = fromHeader || fromQuery || fromBody;
  if (!provided) return fromCookie;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(config.bridgeToken));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 配对码：进程启动时随机生成一次，显示在配对页上。
 *
 * 用途是给"不方便扫码"的场景兜底（手机摄像头对不上焦、或隔着屏幕传话）。
 * 取 8 位、去掉易混字符（0/O、1/I/L），凭它就能换取地址与令牌，
 * 因此等同于本机权限：只在 PC 屏幕上展示，不写进日志、不出网。
 */
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CODE = (() => {
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += PAIR_CODE_ALPHABET[crypto.randomInt(PAIR_CODE_ALPHABET.length)];
  }
  return out;
})();

/** 配对码尝试记录：按来源 IP 分别统计失败次数与锁定时间。 */
const pairCodeAttempts = new Map();

/**
 * 配对页：手机 App 扫这个二维码即可完成配对，无需手抄地址与令牌。
 *
 * 二维码用**紧凑文本格式**而不是 JSON：
 *   dsh1|<host:port>|<token>
 * 原因：JSON 带键名与引号要 130+ 字符，二维码模块很密，手机摄像头常常解析不出来；
 * 压缩到 ~55 字符后模块数大幅下降，识别率明显提升（并把纠错级别降到 L，
 * 反正屏幕显示的二维码不存在污损问题）。
 * 手机端解析后会自行补充 127.0.0.1 与常见局域网候选，因此这里只给一条就够。
 */
function pairPayloadText() {
  const preferred = config.lanAddresses.length > 0
    ? config.lanAddresses[0].address
    : '127.0.0.1';
  return `dsh1|${preferred}:${config.bridgePort}|${config.bridgeToken}`;
}

/**
 * 渲染配对页。
 *
 * @param embed 是否为"嵌入模式"（`/pair?embed=1`，由 DSH 插件弹窗使用）：
 *   1) 整体排布更紧凑（字号/间距/二维码都缩小），但**内容一条不少**；
 *   2) 主动把自身内容的**真实自然高度** postMessage 给父窗口，
 *      父窗口据此把 iframe 调到刚好放得下 —— 于是弹窗里不需要下拉就能看全。
 *      注意不能直接报 documentElement.scrollHeight：body 设了 min-height:100%，
 *      那个值永远 ≥ iframe 高度，永远缩不下来。必须"子元素高度 + 间距 + 内边距"自己加。
 */
function renderPairPage(qrDataUrl, info, embed = false) {
  const qrBlock = qrDataUrl
    ? `<img class="qr" src="${qrDataUrl}" alt="pairing qrcode">`
    : `<p class="warn2">未安装 qrcode 依赖，请用下方配对码。</p>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PocketPilot 配对</title>
<style>
 *{box-sizing:border-box}
 html,body{height:100%}
 /* 整体居中：内容无论多少都落在可视区正中，嵌在设置面板的 iframe 里同样成立 */
 body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;
      min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
      background:#0b0d12;color:#e8eaf0;padding:20px 16px;gap:14px;text-align:center}
 h1{font-size:22px;margin:0;font-weight:600}
 .sub{color:#8b93a7;font-size:14px;line-height:1.6;max-width:520px}
 .card{background:#151922;border:1px solid #232a36;border-radius:16px;padding:18px;
       display:flex;flex-direction:column;align-items:center;gap:12px}
 img.qr{width:min(62vw,340px);height:auto;background:#fff;border-radius:12px;padding:12px;display:block}
 .meta{display:flex;gap:18px;flex-wrap:wrap;justify-content:center;font-size:14px;color:#a9b1c3}
 .meta b{color:#e8eaf0}
 .ok{color:#4ade80}.warn2{color:#fbbf24;font-size:13px}
 code{background:#0b0d12;border:1px solid #232a36;padding:5px 9px;border-radius:7px;
      font-size:13px;word-break:break-all;color:#9fb3d1}
 /* 配对码：大字等宽，便于手输 */
 .codebox{display:flex;flex-direction:column;align-items:center;gap:6px}
 .codeval{font-family:ui-monospace,Consolas,monospace;font-size:30px;letter-spacing:6px;
          font-weight:700;color:#e8eaf0;background:#0b0d12;border:1px solid #2b3446;
          border-radius:10px;padding:10px 18px}
 .tip{color:#6f7789;font-size:12px;line-height:1.7;max-width:520px}

 /* ---- 嵌入模式：只缩小尺寸，不减内容 ---- */
 body.embed{padding:12px 10px;gap:9px}
 body.embed h1{font-size:17px}
 body.embed .sub{font-size:12.5px;line-height:1.5}
 body.embed .card{padding:11px;gap:9px;border-radius:12px}
 body.embed img.qr{width:min(48vw,215px);padding:8px;border-radius:10px}
 body.embed .meta{font-size:12.5px;gap:14px}
 body.embed .codeval{font-size:23px;letter-spacing:4px;padding:7px 14px}
 body.embed .tip{font-size:11px;line-height:1.55}
 body.embed code{font-size:11.5px;padding:3px 7px}
</style></head><body class="${embed ? 'embed' : ''}">
<h1>手机连接这台电脑</h1>
<div class="sub">两种方式任选：<b>扫码</b>最省事，或把下面的<b>配对码</b>填进 App。</div>
<div class="card">
  ${qrBlock}
  <div class="meta">
    <span>通道：<b>${info.mode}</b></span>
    <span>桌面端：<b class="${info.desktopAlive ? 'ok' : 'warn2'}">${info.desktopAlive ? '在线' : '未运行'}</b></span>
  </div>
</div>
<div class="codebox">
  <div class="sub">配对码</div>
  <div class="codeval">${info.pairCode || '--------'}</div>
</div>
<div class="sub">配对地址 <code>${info.target}</code></div>
${info.tunnelUrl ? `<div class="card" style="gap:8px">
  <div class="sub"><b class="ok">异地通道已就绪</b>　人在外面也能连</div>
  <code style="font-size:12px">${info.tunnelUrl}</code>
</div>` : (info.tunnelState === 'starting' ? '<div class="sub">异地通道正在建立…</div>' : '')}
<div class="tip">二维码与配对码等同本机操作权限，请勿外发。<br>
App 里也可点「直接连接」——插着数据线或用同一 WiFi 时会自动发现；<br>
异地时会自动切换到上面的公网地址。</div>
${embed ? `<script>
(function(){
  // 把"刚好放得下"的高度告诉父窗口。父窗口会校验 origin 只认本机桥接。
  function naturalHeight(){
    var cs = getComputedStyle(document.body);
    var gap = parseFloat(cs.rowGap || cs.gap || 0) || 0;
    var kids = 0, h = 0;
    for (var i = 0; i < document.body.children.length; i++) {
      var el = document.body.children[i];
      if (el.tagName === 'SCRIPT') continue;
      h += el.getBoundingClientRect().height;
      kids++;
    }
    h += gap * Math.max(0, kids - 1);
    h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    return Math.ceil(h);
  }
  function send(){
    try { parent.postMessage({ type: 'dsh-pair-height', height: naturalHeight() }, '*'); } catch (e) {}
  }
  window.addEventListener('load', send);
  if (window.ResizeObserver) { try { new ResizeObserver(send).observe(document.body); } catch (e) {} }
  send();
})();
</script>` : ''}
</body></html>`;
}

const STATUS_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PocketPilot · 运行状态</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:20px;background:#0f1115;color:#e6e8ee}
 h1{font-size:19px;margin:0 0 4px} .sub{color:#8b93a7;font-size:13px;margin-bottom:18px}
 .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
 .card{background:#171a21;border:1px solid #242a35;border-radius:10px;padding:14px}
 .card h2{font-size:13px;margin:0 0 10px;color:#8b93a7;font-weight:600;letter-spacing:.4px}
 .kv{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:3px 0}
 .kv span:first-child{color:#8b93a7} .kv span:last-child{text-align:right;word-break:break-all}
 .ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}
 code{background:#0b0d12;padding:2px 6px;border-radius:5px;font-size:12px}
 a{color:#7dd3fc}
</style></head><body>
<h1>PocketPilot</h1>
<div class="sub">PC 端执行 · 手机端指挥 · <span id="ver"></span></div>
<div class="grid" id="grid"></div>
<script>
async function load(){
  const r = await fetch('/health'); const h = await r.json();
  const s = await fetch('/state?token=' + encodeURIComponent(new URLSearchParams(location.search).get('token')||'')).then(x=>x.json()).catch(()=>({}));
  document.getElementById('ver').textContent = 'v' + h.version;
  // 转义后再拼：这些值来自桥接/DSH/隧道状态，虽然当前都是自家生成的，
  // 但状态页是 innerHTML 拼接，任何一处将来变成"外部可控"都会变成注入点。
  const esc = (x)=>String(x).replace(/[&<>"']/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rows = (o)=>Object.entries(o).map(([k,v])=>'<div class="kv"><span>'+esc(k)+'</span><span>'+(v===null||v===undefined?'-':esc(v))+'</span></div>').join('');
  document.getElementById('grid').innerHTML =
    '<div class="card"><h2>桥接</h2>'+rows({mode:h.mode,bridgePort:h.bridgePort,uptime:h.uptime})+'</div>'+
    '<div class="card"><h2>DSH 执行端</h2>'+rows(s.dsh||{})+'</div>'+
    '<div class="card"><h2>USB 隧道</h2>'+rows(s.tunnel||{})+'</div>'+
    '<div class="card"><h2>任务</h2>'+rows(s.tasks||{})+'</div>';
}
load(); setInterval(load, 3000);
</script><!-- ${ORIGIN_MARK} · MIT · 见 WATERMARK.md --></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  try {
    // —— 反代入口：/dsh/* 整段交给 DSH 代理（含其下的 WebSocket 升级） ——
    if (url.pathname === '/dsh' || url.pathname.startsWith('/dsh/')) {
      if (!authorizeDshAccess(req, url, res)) return;
      proxy.handleRequest(req, res);
      return;
    }

    if (route === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(STATUS_PAGE);
      return;
    }

    if (route === '/health') {
      // 公开端点，但按来源分级：本机/局域网给完整信息（App 需要它做状态检测），
      // 公网只回一个存活标志 —— 否则等于把"这是 DSH 桥接、正在运行、
      // 隧道地址是 xxx"直接告诉任何扫描器。
      const external = isExternalRequest(req);
      if (external) {
        auditLog(req, route, 'OK', '(降级响应)');
        sendJson(res, 200, { ok: true, service: 'dsh-phone-bridge' });
        return;
      }
      auditLog(req, route, 'OK');
      sendJson(res, 200, {
        ok: true,
        service: 'dsh-phone-bridge',
        version: BRIDGE_VERSION,
        mode: config.mode,
        bridgePort: config.bridgePort,
        uptime: Math.round(process.uptime()),
        dshRunning: dsh.running,
        // 异地通道状态：手机据此判断"能不能跨网络连回来"
        tunnel: cfTunnel ? cfTunnel.status() : { state: 'disabled' },
        // 供手机端测算并校正与 PC 的时钟偏差（跨设备绝对时间比较需要同一基准）
        serverTime: Date.now(),
      });
      return;
    }

    // 手机上传文件需要更大的请求体上限：base64 会让体积膨胀约 1/3，
    // 默认 4MB 只够传 3MB 左右的原文件，这里放宽到 48MB。
    const bodyLimit = route === '/fs/upload' ? 48 * 1024 * 1024 : 4 * 1024 * 1024;
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req, bodyLimit) : {};

    // USB 模式下手机只能经 adb reverse 到达这里，握手/入口免鉴权；
    // 局域网模式强制鉴权，避免泄漏带 token 的入口地址。
    const usbOnlyPublic = config.mode === 'usb' && (route === '/handshake' || route === '/desktop' || route === '/pair');
    // /pair.json 与 /pair 的内容都含令牌，不能对局域网开放；
    // 但 DSH 前端的「手机连接」面板就在本机运行（它用 iframe 直接嵌 /pair 页面），
    // 需要免鉴权访问。判据用 TCP 来源地址（客户端无法伪造），只放行回环请求，
    // 因此不会扩大暴露面。
    const remoteAddr = req.socket && req.socket.remoteAddress;
    const fromLoopback = remoteAddr === '127.0.0.1'
      || remoteAddr === '::1'
      || remoteAddr === '::ffff:127.0.0.1';
    // ⚠️ 关键：cloudflared 就跑在本机，隧道进来的请求来源同样是 127.0.0.1，
    // 因此"仅凭回环地址"会把公网用户误判成本机 —— 他们就能直接读到
    // /pair.json（含 bridge token 与异地地址）。
    // 所以必须再排除"来自隧道的请求"（CF 头 / 隧道 Host）。
      // 顶层导航不带 Origin；带了 Origin 说明是页面里的跨源请求（fetch/XHR），
      // 一律不当作「本地视图」，避免本机回环被任意网页借道读走令牌。
      const localPairView = fromLoopback
        && !isExternalRequest(req)
        && !req.headers.origin
        && (route === '/pair.json' || route === '/pair');
    const isPublic = PUBLIC_PATHS.has(route) || usbOnlyPublic || localPairView;
    if (!isPublic && !authorize(req, body)) {
      auditLog(req, route, 'UNAUTHORIZED');
      sendJson(res, 401, { ok: false, error: 'unauthorized', message: '缺少或错误的 bridge token。' });
      return;
    }
    // 通过鉴权的公网请求也记一笔，便于事后追溯
    if (isExternalRequest(req)) auditLog(req, route, 'OK');

    switch (route) {
      case '/pair/claim': {
        // 手机用配对码换取连接信息（地址 + 令牌）。
        // 配对码本身就是凭证，所以本路由本身不需要 bridge token；
        // 但必须限速，避免被暴力枚举（8 位、32 字符表 ≈ 1.1e12 种）。
        //
        // 限速按来源 IP 分别统计：早先用全局计数，任何一个人猛试就能把
        // 配额耗尽，反而让真正的用户被挡住，攻击者却可以慢慢试。
        const now = Date.now();
        const srcKey = ((req.socket && req.socket.remoteAddress) || 'unknown')
          .replace(/^::ffff:/, '');
        let rec = pairCodeAttempts.get(srcKey);
        if (!rec) { rec = { fails: 0, blockedUntil: 0 }; pairCodeAttempts.set(srcKey, rec); }
        // 顺手清理过期记录，避免 Map 无限增长
        if (pairCodeAttempts.size > 500) {
          for (const [k, v] of pairCodeAttempts) {
            if (now > v.blockedUntil && v.fails === 0) pairCodeAttempts.delete(k);
          }
        }
        if (now < rec.blockedUntil) {
          auditLog(req, route, 'DENY', `(配对码锁定中 ${Math.ceil((rec.blockedUntil - now) / 1000)}s)`);
          sendJson(res, 429, {
            ok: false,
            error: 'too-many-attempts',
            message: `尝试次数过多，请 ${Math.ceil((rec.blockedUntil - now) / 1000)} 秒后再试。`,
          });
          return;
        }
        const submitted = String(body.code || '').trim().toUpperCase().replace(/[\s-]/g, '');
        if (!submitted || submitted !== PAIR_CODE) {
          rec.fails += 1;
          auditLog(req, route, 'DENY', `(配对码错误 第${rec.fails}次)`);
          if (rec.fails >= 5) {
            rec.blockedUntil = now + 60000;
            rec.fails = 0;
            log(`配对码连续输错 5 次（来源 ${srcKey}），已锁定 60 秒`);
          }
          sendJson(res, 403, { ok: false, error: 'bad-code', message: '配对码不正确，请核对电脑屏幕上显示的 8 位配对码。' });
          return;
        }
        rec.fails = 0;
        // 候选地址按"手机最可能走通"的顺序给出：本机 → 局域网 → 异地
        // 手机端逐个探测取最快，因此异地地址放在最后作为兜底。
        const bases = [`http://127.0.0.1:${config.bridgePort}`];
        for (const entry of config.lanAddresses) {
          bases.push(`http://${entry.address}:${config.bridgePort}`);
        }
        const remoteBase = cfTunnel && cfTunnel.status().publicUrl
          ? cfTunnel.status().publicUrl
          : null;
        if (remoteBase) bases.push(remoteBase);
        log(`配对码匹配成功，已下发 ${bases.length} 个候选地址${remoteBase ? '（含异地通道）' : ''}`);
        sendJson(res, 200, {
          ok: true,
          bases: Array.from(new Set(bases)),
          token: config.bridgeToken,
          mode: config.mode,
          // 异地基址单独给出，便于 App 在局域网不可达时直接切过去
          remoteBase,
        });
        return;
      }

      case '/fs/upload': {
        // 接收手机传来的文件，落到电脑上的临时目录，返回它在电脑上的路径。
        //
        // 为什么要走这一步：DSH 运行在电脑上，它读不到手机的存储，
        // 所以手机文件必须真的把内容传过来。传完同样以 @路径 的形式
        // 在对话框里引用，与"电脑文件"保持一致的用法。
        const rawName = String((body && body.name) || 'upload.bin');
        const safeName = rawName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-120);
        const data = String((body && body.data) || '');
        if (!data) {
          auditLog(req, route, 'DENY', '(缺少 data)');
          sendJson(res, 400, { ok: false, error: 'no-data', message: '缺少文件内容。' });
          return;
        }
        try {
          const dir = path.join(os.tmpdir(), 'dsh-phone-uploads');
          fs.mkdirSync(dir, { recursive: true });
          const target = path.join(dir, `${Date.now()}-${safeName}`);
          const buf = Buffer.from(data, 'base64');
          fs.writeFileSync(target, buf);
          auditLog(req, route, 'OK', `(${safeName}, ${buf.length} 字节)`);
          sendJson(res, 200, { ok: true, path: target, name: safeName, size: buf.length });
        } catch (error) {
          log(`手机文件落盘失败: ${error.message}`);
          sendJson(res, 500, { ok: false, error: 'write-failed', message: error.message });
        }
        return;
      }

      case '/fs/pick': {
        // 在**电脑上**弹出系统文件选择框，把用户选中的路径回给手机。
        //
        // 为什么不手打路径：DSH 就跑在这台电脑上，"添加电脑文件"最自然的
        // 做法是让用户用自己熟悉的文件管理器去挑，而不是在手机小键盘上
        // 一个字母一个字母敲 C:\... —— 后者又慢又容易打错。
        //
        // 技术要点：Windows 的文件对话框要求 STA 线程，
        // 所以 powershell 必须带 -STA，否则 ShowDialog 会直接抛异常。
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms;',
          '$d = New-Object System.Windows.Forms.OpenFileDialog;',
          '$d.Title = "选择要引用的文件（供手机端 DSH 使用）";',
          '$d.Multiselect = $true;',
          '$d.CheckFileExists = $false;',
          'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(($d.FileNames -join "|")) }',
        ].join(' ');
        auditLog(req, route, 'OK', '(调起电脑文件选择框)');
        execFile('powershell', ['-NoProfile', '-STA', '-Command', script],
          { timeout: 180000, windowsHide: true },
          (error, stdout) => {
            const raw = String(stdout || '').trim();
            const paths = raw ? raw.split('|').map((s) => s.trim()).filter(Boolean) : [];
            if (error && paths.length === 0) {
              log(`文件选择框异常: ${error.message}`);
            } else if (paths.length) {
              log(`电脑端选择文件 ${paths.length} 个`);
            }
            sendJson(res, 200, {
              ok: paths.length > 0,
              paths,
              canceled: !error && paths.length === 0,
              error: error && paths.length === 0 ? error.message : null,
            });
          });
        return;
      }

      case '/pair.json': {
        // 供 PC 端 DSH 插件（设置面板里的「手机连接」）拉取配对信息。
        // DSH 界面跑在另一个端口（桌面端 19387），因此需要放行跨源。
        await refreshDesktopState(false);
        const text = pairPayloadText();
        let qrDataUrl = '';
        if (qrcode) {
          try {
            qrDataUrl = await qrcode.toDataURL(text, {
              errorCorrectionLevel: 'L',
              width: 640,
              margin: 2,
            });
          } catch (error) {
            log(`二维码生成失败：${error.message}`);
          }
        }
        const body = JSON.stringify({
          ok: true,
          qrDataUrl,
          payload: text,
          target: text.split('|')[1] || '',
          mode: config.mode,
          desktopAlive: desktop.alive,
          // 异地通道：手机拿到这个地址后，在任何网络下都能连回本机。
          // 地址是临时的（trycloudflare），每次重启会变，所以每次配对都重新下发。
          tunnel: cfTunnel ? cfTunnel.status() : { state: 'disabled' },
          endpoints: {
            usbBase: `http://127.0.0.1:${config.bridgePort}`,
            lanBases: config.lanAddresses.map((e) => `http://${e.address}:${config.bridgePort}`),
            // 异地基址（有隧道时才有值）
            remoteBase: cfTunnel && cfTunnel.status().publicUrl
              ? cfTunnel.status().publicUrl
              : null,
          },
        }, null, 2);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
            // ⚠️ 原本这里是 'access-control-allow-origin': '*'，必须去掉：
            // 用户浏览器里任何网页都能 fetch('http://127.0.0.1:3080/pair.json')，
            // 本机回环 + 该响应头 = 跨源读到 bridge token（192 位明文），拿到即 RCE。
            // 插件父页面按设计**不读** /pair.json（见 client.js 注释），
            // 手机 App 是原生 HTTP 客户端不受 CORS 影响，故去掉它不影响任何功能。
        });
        res.end(body);
        return;
      }

      case '/pair': {
        // 配对页：手机 App 扫码即可拿到地址与令牌
        await refreshDesktopState(false);
        const text = pairPayloadText();
        let qrDataUrl = '';
        if (qrcode) {
          try {
            qrDataUrl = await qrcode.toDataURL(text, {
              // 纠错降到 L：屏幕显示不存在污损，换取更稀疏的模块、更高的识别率
              errorCorrectionLevel: 'L',
              width: 720,
              margin: 2,
            });
          } catch (error) {
            log(`二维码生成失败：${error.message}`);
          }
        }
        const target = text.split('|')[1] || '';
        const tunnelStatus = cfTunnel ? cfTunnel.status() : { state: 'disabled' };
        // ?embed=1 → DSH 插件弹窗内嵌用：排布更紧凑，并回报自身高度供父窗口精确适配
        const embed = url.searchParams.get('embed') === '1';
        const page = renderPairPage(qrDataUrl, {
          mode: config.mode,
          desktopAlive: desktop.alive,
          target,
          pairCode: PAIR_CODE,
          // 异地通道：让用户直观看到"人在外面也能连回家"
          tunnelState: tunnelStatus.state,
          tunnelUrl: tunnelStatus.publicUrl || '',
        }, embed);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page);
        return;
      }

      case '/desktop': {
        // 兼容旧入口：统一跳到反代入口（由代理决定连桌面端还是桥接实例）
        await refreshDesktopState(true);
        const suffix = config.mode === 'lan' ? `?k=${encodeURIComponent(config.bridgeToken)}` : '';
        res.writeHead(302, { Location: `/dsh/${suffix}`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      case '/handshake':
      case '/state': {
        await refreshDesktopState(false);
        if (!dsh.running) await dsh.start();
        await publishRuntime();
        const runtime = bridgeRuntime();
        sendJson(res, 200, {
          ok: true,
          ...runtime,
          // 手机端拿它与本机 Date.now() 相减即得其与 PC 的时钟偏差，
          // 用于把 WebView 内的页面时钟校正到与 PC 一致。
          serverTime: Date.now(),
          // USB 模式下手机直接拿到 token 即可工作；局域网模式同样需要它
          hint: config.mode === 'usb'
            ? 'USB 模式：手机 127.0.0.1 已被 adb reverse 映射到 PC。'
            : '局域网模式：请用 PC 的局域网 IP 替换 <pc>。',
        });
        return;
      }

      case '/rpc': {
        const { method, args } = body;
        if (typeof method !== 'string' || method === '') {
          sendJson(res, 400, { ok: false, error: 'method 必填' });
          return;
        }
        const value = await dsh.rpc(method, args || {});
        sendJson(res, 200, { ok: true, value });
        return;
      }

      case '/sessions': {
        const value = await dsh.listSessions(Number(body.limit) || 30);
        sendJson(res, 200, { ok: true, sessions: value });
        return;
      }

      case '/history': {
        const sessionId = body.sessionId || url.searchParams.get('sessionId');
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: 'sessionId 必填' });
          return;
        }
        const value = await dsh.history(sessionId, Number(body.limit) || 40);
        sendJson(res, 200, { ok: true, ...value });
        return;
      }

      case '/chat': {
        const message = body.message;
        if (typeof message !== 'string' || message.trim() === '') {
          sendJson(res, 400, { ok: false, error: 'message 必填' });
          return;
        }
        const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS;
        const result = await dsh.withPermissionPreset(config.permissionPreset, async () => {
          const submitted = await dsh.prompt({
            message,
            sessionId: body.sessionId || undefined,
            mode: body.mode || 'queue',
            cwd: body.cwd || undefined,
          });
          if (!submitted.accepted) throw new Error('DSH 未接受该消息（accepted=false）。');
          const reply = await dsh.waitForReply({
            sessionId: submitted.sessionId,
            message,
            baselineSeq: submitted.baselineSeq,
            timeoutMs,
          });
          return { sessionId: submitted.sessionId, reply };
        });
        sendJson(res, 200, {
          ok: true,
          status: 'completed',
          sessionId: result.sessionId,
          reply: result.reply.text,
          seq: result.reply.seq,
          uiUrl: dsh.authenticatedUrl,
        });
        return;
      }

      case '/task': {
        if (req.method === 'GET') {
          const id = url.searchParams.get('id');
          if (!id) {
            sendJson(res, 200, { ok: true, tasks: [...tasks.values()].map(taskSummary).reverse().slice(0, 50) });
            return;
          }
          const task = tasks.get(id);
          if (!task) {
            sendJson(res, 404, { ok: false, error: '任务不存在' });
            return;
          }
          sendJson(res, 200, { ok: true, task: taskSummary(task) });
          return;
        }
        const message = body.message;
        if (typeof message !== 'string' || message.trim() === '') {
          sendJson(res, 400, { ok: false, error: 'message 必填' });
          return;
        }
        if (body.action === 'cancel') {
          const task = tasks.get(body.taskId);
          if (!task) {
            sendJson(res, 404, { ok: false, error: '任务不存在' });
            return;
          }
          task.status = 'cancelled';
          task.updatedAt = Date.now();
          sendJson(res, 200, { ok: true, task: taskSummary(task) });
          return;
        }
        const id = `task-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        const task = {
          id,
          status: 'queued',
          message,
          sessionId: body.sessionId || null,
          cwd: body.cwd || null,
          timeoutMs: Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        tasks.set(id, task);
        taskQueue.push(task);
        drainQueue();
        sendJson(res, 202, { ok: true, task: taskSummary(task), poll: `GET /task?id=${id}` });
        return;
      }

      case '/restart': {
        await dsh.restart();
        await publishRuntime();
        sendJson(res, 200, { ok: true, dsh: dsh.status() });
        return;
      }

      case '/tunnel/rebuild': {
        await syncTunnel(config);
        await publishRuntime();
        sendJson(res, 200, { ok: true, tunnel });
        return;
      }

      default:
        sendJson(res, 404, { ok: false, error: `未知路径 ${route}` });
    }
  } catch (error) {
    log(`请求 ${route} 失败：${error.message}`);
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

// /state 需要在状态页里用 token 访问，上面的 isPublic 规则已覆盖 /health 与 USB 下 /handshake

// ---------------------------------------------------------------- 启动编排

// WebSocket 升级：DSH 的实时流走 HTTP Upgrade，必须一并转发
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/dsh' && !url.pathname.startsWith('/dsh/')) {
      socket.destroy();
      return;
    }
      // WebSocket 也必须「先算来源」：隧道进来的 WS 请求来源同样是 127.0.0.1，
      // 只看 mode 会让 usb+隧道场景下的 WS 通道绕过鉴权（与 /dsh/* 同源问题）。
      if (isExternalRequest(req) || config.mode === 'lan') {
        const cookieHeader = String(req.headers.cookie || '');
        if (!tokenEquals(bridgeCookieValue(cookieHeader))) {
          socket.destroy();
          return;
        }
      }
    proxy.handleUpgrade(req, socket, head);
  } catch (error) {
    log(`WS 升级转发失败：${error.message}`);
    socket.destroy();
  }
});

async function main() {
  log(`PocketPilot v${BRIDGE_VERSION} 启动（模式：${config.mode}）· ${ORIGIN_MARK}`);
  log(`dsh CLI: ${config.dshCli}`);
  log(`adb    : ${config.adbPath}`);

  // 专用工作区：避免把用户主目录当工作区（ACL 沙箱临时根会落在工作区内被拒）
  try {
    fs.mkdirSync(config.workspace, { recursive: true });
    log(`工作区: ${config.workspace}`);
  } catch (error) {
    log(`创建工作区失败：${error.message}`);
  }

  server.listen(config.bridgePort, config.mode === 'lan' ? '0.0.0.0' : '127.0.0.1', () => {
    log(`桥接控制面监听 http://${config.mode === 'lan' ? '0.0.0.0' : '127.0.0.1'}:${config.bridgePort}`);
  });

  await syncTunnel(config);

  try {
    await dsh.start();
  } catch (error) {
    log(`DSH 启动失败：${error.message}`);
  }
  await publishRuntime();
    // ⚠️ 绝不把完整令牌写进日志：日志会被复制/上传/甚至误提交到仓库，
  //    而拿到令牌就等于能在本机执行任意代码。只留指纹，用于比对"是不是同一个令牌"。
  log(`bridge token: ${maskSecret(config.bridgeToken)}`);

  setInterval(async () => {
    await syncTunnel(config);
    await refreshDesktopState(false);
    if (!dsh.running && !dsh.pending) {
      log('检测到 DSH 未运行，尝试拉起');
      dsh.start().catch((error) => log(`拉起失败：${error.message}`));
    }
    await publishRuntime();
  }, 5000).unref();
}

async function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  if (!config.keepDshOnExit) await dsh.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  log(`致命错误：${error.stack || error.message}`);
  process.exit(1);
});
