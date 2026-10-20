// SPDX-License-Identifier: MIT
'use strict';
/**
 * bridge.js —— PocketPilot 守护进程（PC 端）
 *
 * 架构定位：
 *   手机 (PocketPilot App / 任意浏览器)
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
// Cloudflare Tunnel + 可选 Tailscale：异地（不同网络）访问用。
// PC 在 NAT 后无公网入口，而手机端不装额外 App，只能由 PC 主动出站建隧道。
// provider 层见 lib/remote.js（隧道由独立守护进程持有，桥接重启复用同一地址）。
const { createRemoteLayer } = require('./lib/remote');
const tuner = require('./lib/tuner');
const versionCheck = require('./lib/version-check');

// 隧道重建冷却：Cloudflare 对快速隧道限流时（HTTP 429 / error 1015），
// 若每 5 秒重试一次，不仅没用，还会让限流持续更久（实测踩过）。
// 失败后按指数退避冷却：30s → 60s → 120s → 300s。
let tunnelRetryAt = 0;
let tunnelRetryDelayMs = 30000;
const TUNNEL_RETRY_MAX_MS = 300000;
function tunnelCoolingDown() { return Date.now() < tunnelRetryAt; }
function noteTunnelFailure(reason) {
  tunnelRetryAt = Date.now() + tunnelRetryDelayMs;
  log(`隧道重建进入冷却 ${Math.round(tunnelRetryDelayMs / 1000)}s（原因：${reason}）` +
      (/429|1015|Too Many/i.test(String(reason)) ? " —— Cloudflare 限流：请等待几分钟，局域网/USB 不受影响" : ""));
  tunnelRetryDelayMs = Math.min(TUNNEL_RETRY_MAX_MS, tunnelRetryDelayMs * 2);
}

/** 二维码生成：局部依赖，缺失时降级为纯文本配对信息。 */
let qrcode = null;
try {
  qrcode = require('qrcode');
} catch {
  // 此处 log() 尚未定义，直接用 console
  console.log('[warn] 未安装 qrcode，/pair 将只显示文本配对信息');
}

const BRIDGE_VERSION = '1.0.0';

/** 发布仓库与插件包名：配对页上的下载链接用，改版本时只改这两处。 */
const RELEASE_REPO = 'https://github.com/MengTan100/pocketpilot';
// 资产名不再带版本号：链接可以长期复用，升级时不必改页面/面板。
const PLUGIN_ZIP_NAME = 'dsh-plugin-phone-bridge.zip';

/**
 * 当前插件版本：读插件自己的 package.json（**唯一事实来源**，
 * 不再在代码里手抄一个版本号，避免"发布了新包、面板还显示旧版本"）。
 */
const PLUGIN_VERSION = (() => {
  try {
    return require('./dsh-plugin-phone-bridge/package.json').version || BRIDGE_VERSION;
  } catch {
    return BRIDGE_VERSION;
  }
})();
/**
 * 项目出处指纹（水印第 4 层：运行时/构建指纹）。
 * 出现在：启动日志、状态页 HTML 注释、runtime/bridge-runtime.json。
 * 作用：一份被拷走/改名分发的桥接，仍能据此确认出处。见 README.md。
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
 * 判断是否落在 CGNAT 段 100.64.0.0/10 —— **Tailscale 的地址段**。
 *
 * 为什么单独一个函数：这个判断现在有**两个相反的用途**，写错一个就会出事：
 *   ① 组装「局域网」候选时要**排除**它 —— 装了 Tailscale 时 100.x 常被系统排在 WLAN
 *      前面当"首选地址"，但手机在同一 Wi-Fi 下根本连不到它，当成局域网候选只会让
 *      /handshake 多下发一条死地址；
 *   ② 组装「异地」候选时要**包含**它 —— 100.x 是 CGNAT + WireGuard 加密的跨 NAT 地址，
 *      两端都登录同一个 tailnet 时人在外面也能连上，且**地址固定不变**，
 *      正好补掉 Cloudflare 快速隧道"每次重启就换地址"的致命缺点。
 * 所以这里把 100.x 从局域网里"拿走"，同时交给 remoteBases 去发布（见 remoteBases()）。
 */
function isTailscaleCgnat(address) {
  const text = String(address || '');
  // 100.64.0.0/10 → 第二段 64..127
  return /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(text);
}

/**
 * 本机全部可用的**局域网** IPv4 地址（供手机端择优）。
 *
 * 过滤掉两类不可用地址：
 *  - 169.254.* link-local：路由不可达，典型来源是尚未登录的 Tailscale 网卡；
 *  - 100.64.0.0/10（Tailscale CGNAT）：它不是局域网地址，改由 remoteBases() 作为
 *    **异地**候选发布，不能在这里丢掉（见 isTailscaleCgnat 的注释）；
 *  - 回环由调用方另行补充，不在此列。
 * 其它虚拟网卡（ZeroTier、Hyper-V 等）保持原样。
 */
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      if (isTailscaleCgnat(entry.address)) continue;
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
  // 手工固定异地地址（可选，留空 = 不影响既有行为）。
  // 形如 "https://your.domain" 或 Tailscale 的 "http://100.x.y.z:3080"。
  // 为什么要留这个口子：免费快速隧道的地址每次重启都会变（实测一小时内变过 4 次），
  // 手机里缓存的异地地址必然过期；写了固定地址就不会再有这个问题，且**优先于**隧道。
  remoteBase: '',
  // Tailscale（100.64.0.0/10）来的请求是否当作"内网"看待。
  // 默认 true：其流量本身已由 WireGuard 端到端加密，且只有登录同一 tailnet 的设备可达。
  // 注意它**不会**放宽鉴权 —— 只有"局域网模式下的本机/内网免令牌"这一条会多认 100.x；
  // 公网（隧道）请求依旧必须带令牌（见 isExternalRequest 与 authorizeDshAccess）。
  trustTailscaleAsLan: true,
  // Cloudflare 隧道（异地/跨网络访问）。默认关闭：
  // 它会为桥接开一个公网入口，属于"扩大暴露面"的操作，必须由用户显式开启
  // （命令行 --tunnel，或配置里 enableTunnel: true）。
  enableTunnel: false,
  // 留空则用内置路径 tools/bin/cloudflared.exe
  tunnelBinary: '',
  // 复用已有隧道（**默认开**）：隧道由独立守护进程持有并落盘 runtime/tunnel.json，
  // 桥接重启时读它 → 复用同一条隧道 → **异地地址保持不变**。
  // 这正是"异地永远连不上"的根治点（旧实现每次重启都换地址，App 缓存的必然过期）。
  tunnelReuse: true,
  // 退出桥接时是否把隧道一起停掉。默认 false：停了就换地址，异地又得重新学。
  tunnelStopOnExit: false,
  // 异地通道 provider 及优先级（前 = 优先）。cloudflared 由项目自带、无需账号，
  // tailscale 是可选增强（装了且登录就有**固定** 100.x 地址）。
  remoteProviders: ['cloudflared', 'tailscale'],
  // 是否允许本项目自动下载并安装 Tailscale（需要用户确认 + 管理员权限；默认只下载不安装）
  tailscaleAutoInstall: true,
  tailscaleAutoInstallConfirm: false,
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
  // ⚠️ 必须**实时**取值，不能存一次性快照。
  // 踩过的坑：这里原本是 merged.lanAddresses = lanAddresses()，只在启动时算一次。
  // 家里路由器重启后 DHCP 把地址从 192.168.0.8 换成 192.168.0.4，桥接却继续把旧
  // 地址写进二维码与 /handshake —— 手机扫码后永远连不上，只有插 USB 走 adb reverse
  // 的 127.0.0.1 才通（症状就是"不插线登不上"）。
  // 改成 getter 后，/pair.json、二维码、状态页、运行时快照、/handshake 等消费点
  // 全部自动拿到当前地址，不必逐个改。
  // ⚠️ 注意 lanAddresses 只含**局域网**地址；Tailscale 的 100.x 被它有意排除了，
  //    改由 remoteBases() 作为**异地**候选发布（快照问题同理：remoteBases() 每次现算）。
  Object.defineProperty(merged, 'lanAddresses', {
    get: () => lanAddresses(),
    enumerable: true,
    configurable: true,
  });
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
    // 隧道复用（默认开）：重启桥接时沿用同一条隧道 → 异地地址不变。
    // --tunnel-restart 是"我就要一个新地址"的显式出口（旧地址可能已被 Cloudflare 回收）。
    else if (arg === '--tunnel-reuse') { config.tunnelReuse = true; }
    else if (arg === '--tunnel-restart' || arg === '--no-tunnel-reuse') { config.tunnelReuse = false; }
    // 退出时是否连隧道一起停：默认**不停**（停了就换地址，异地又得重新学）
    else if (arg === '--tunnel-stop') { config.tunnelStopOnExit = true; }
    else if (arg === '--keep-tunnel') { config.tunnelStopOnExit = false; }
    // 异地 provider 列表与顺序（前 = 优先）：--remote-providers cloudflared,tailscale
    else if (arg === '--remote-providers' && next) {
      config.remoteProviders = String(next).split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
    // 固定异地地址（自有域名或固定 100.x）：--remote-base https://your.domain
    else if (arg === '--remote-base' && next) { config.remoteBase = next; i += 1; }
    // Tailscale（可选增强）：--install-tailscale 让项目自己下载安装；--yes 才真的执行安装
    else if (arg === '--install-tailscale') { config.tailscaleAutoInstall = true; }
    else if (arg === '--yes' || arg === '-y') { config.tailscaleAutoInstallConfirm = true; }
    else if (arg === '--no-tailscale') {
      config.remoteProviders = (config.remoteProviders || []).filter((p) => p !== 'tailscale');
    }
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

/** USB 模式下把握手信息写到手机共享目录（可选，供 App 直接读取，不必走网络）。 */
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

// ---------------------------------------------------------------- 异地通道（provider 层）

/**
 * 异地通道 = 一组可替换的 provider，由 lib/remote.js 统一管理：
 *
 *   ① remoteBase（配置里手写的固定地址）—— 最高优先，用户说了算；
 *   ② tailscale   —— 可选增强：装了并登录就有**固定不变**的 100.x 地址；
 *   ③ cloudflared —— **本项目自带**的隧道（tools/bin/cloudflared.exe）：
 *                     无需账号、无需用户安装，默认就是它兜底。
 *
 * 本代的关键改动（对应真实故障"异地永远连不上"）：
 *   隧道不再由桥接直接持有，而是交给**独立守护进程**（lib/cloudflared-supervisor.js）。
 *   桥接重启时读 runtime/tunnel.json 就能**复用同一条隧道**，
 *   Cloudflare 的域名只在隧道进程重启时才变 —— 于是地址终于稳定了。
 *   正常退出时**不杀隧道**（要显式 --tunnel-stop），地址可以长期存活。
 *
 * 安全边界：隧道只指向桥接端口，不直接暴露 DSH；
 * 桥接自身的 token 鉴权在隧道之上依然生效（隧道不绕过鉴权）。
 */
const tunnelBinary = config.tunnelBinary || path.join(__dirname, 'tools', 'bin', 'cloudflared.exe');

const remote = createRemoteLayer({
  providers: config.remoteProviders,
  remoteBase: config.remoteBase,
  port: config.bridgePort,
  cfTunnelBinary: tunnelBinary,
  cfEnabled: config.enableTunnel,
  // 持久化隧道（复用地址）是默认行为；--tunnel-restart 时 config.tunnelReuse 为 false
  cfPersistent: true,
  cfReuse: config.tunnelReuse !== false,
  runtimeDir: RUNTIME_DIR,
  log,
});

// 兼容旧命名：很多地方（/health、运行时快照）仍按"隧道"这个词读取状态
const cfTunnel = remote.tunnel;

/**
 * 启动异地通道。**不 await**：隧道首次握手要几秒，不能让 HTTP 服务等它。
 * 结果通过日志与 runtime/tunnel.json 反映，/health 与 /pair.json 每次都实时读。
 */
(async () => {
  const results = await remote.startAll();
  const ts = remote.providerByName('tailscale');
  if (ts) {
    const st = ts.status();
    log(`Tailscale（可选增强）：${st.state} · ${st.detail}`);
    if (st.action && st.action.url) log(`Tailscale 登录链接：${st.action.url}`);
  }
  const cf = remote.providerByName('cloudflared');
  if (cf) {
    const st = cf.status();
    log(`Cloudflare 隧道：${st.state}${st.publicUrl ? ` · ${st.publicUrl}` : ''}`
      + `${st.pid ? `（pid=${st.pid}）` : ''}`);
  }
  log(`异地通道候选：${remote.publicBases().join(', ') || '(暂无)'} · ${remote.note()}`);
  // 启动失败也不要影响 USB/局域网：这里只记录
  for (const r of results) {
    if (r && r.result && r.result.ok === false && r.result.error) {
      log(`${r.name} 启动未成功：${r.result.error}`);
    }
  }
})();

if (config.tunnelStopOnExit) {
  // 显式要求：退出时把隧道一起停掉（默认**不停** —— 停了地址就换，异地又得重新学）
  const stopTunnelOnExit = () => {
    try {
      const cf = remote.providerByName('cloudflared');
      if (cf) cf.stop();
    } catch (error) {
      log(`停止隧道失败：${error.message}`);
    }
  };
  process.on('exit', stopTunnelOnExit);
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
  // 桌面端自己下发的会话（权威鉴权）：插件把带 launch token 的地址交过来，
  // 桥接访问它换取 Set-Cookie。自签 Cookie 是"猜密钥"，这里才是"官方发牌"。
  sessionUrl: '',
  sessionCookie: null,   // { authority, header, at }
  authSource: 'none',    // 'session' | 'mint' | 'none' —— 排查时一眼看出用的哪条路
};

/** 探测桌面端实例；结果缓存 5 秒，避免频繁打扰。 */
/**
 * 发现桌面端 DSH 的实际监听端口。
 *
 * 为什么不能只读配置：桌面端端口**每次重启都会变**（实测 19387 → 53274 → 53760），
 * 写死或读配置都追不上，结果是 desktop.alive 永远 false、手机端报"上游不可用"。
 * 这里直接从系统里查：哪个进程是 DeepSeek Harness，它就监听在哪个端口 —— 事实来源。
 */
let desktopPortCache = { at: 0, port: 0 };
function discoverDesktopPort() {
  if (Date.now() - desktopPortCache.at < 30000) return desktopPortCache.port;
  let port = 0;
  try {
    // tasklist 拿 PID（按镜像名），netstat 拿监听端口；两者都在系统里，不引入新依赖。
    const tasks = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: 8000, encoding: "utf8" });
    const pids = new Set();
    for (const line of tasks.split(/\r?\n/)) {
      if (!/DeepSeek/i.test(line)) continue;
      const cols = line.split(",");
      const pid = Number(String(cols[1] || "").replace(/"/g, ""));
      if (pid > 0) pids.add(pid);
    }
    if (pids.size === 0) { desktopPortCache = { at: Date.now(), port: 0 }; return 0; }
    const netstat = execFileSync("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 8000, encoding: "utf8" });
    for (const line of netstat.split(/\r?\n/)) {
      const m = line.match(/LISTENING\s+(\d+)\s*$/);
      if (!m) continue;
      if (!pids.has(Number(m[1]))) continue;
      const addr = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)\s/);
      if (!addr) continue;
      const candidate = Number(addr[1]);
      if (candidate >= 1024) { port = candidate; break; }
    }
  } catch (error) {
    log("桌面端端口发现失败：" + (error && error.message ? error.message : error));
  }
  desktopPortCache = { at: Date.now(), port };
  return port;
}

async function refreshDesktopState(force) {
  log('[探活] refreshDesktopState 进入 force=' + force + ' preferDesktop=' + config.preferDesktop);
  if (!config.preferDesktop) {
    desktop.alive = false;
    desktop.lastError = 'preferDesktop 已关闭';
    return desktop;
  }
  if (!force && Date.now() - desktop.checkedAt < 5000) return desktop;
  try {
    // 桌面端端口是**会变的**（DSH 升级后实测从 19387 换到了 53760）。
    // 只认配置里那个死端口 → desktop.alive 永远 false → 手机端"上游不可用"。
    // 所以：先试配置值，再依次试已知候选端口，谁活着就用谁并记住。
    // 顺序：系统里发现的真实端口 → 配置值 → 历史已知值
    const found = discoverDesktopPort();
    // 候选顺序：**已持有会话的端口**优先 —— 我们已经用桌面端自己发的 Cookie 验证过它，
    // 这比 tasklist/netstat 猜出来的端口更权威；会话端口不通（桌面端重启换了端口）再退回去发现。
    const sessionPort = desktop.sessionCookie
      ? Number(String(desktop.sessionCookie.authority || '').split(':').pop())
      : 0;
    const candidates = [sessionPort, found, config.desktopPort, 19387, 53760]
      .filter((v, i, a) => v && a.indexOf(v) === i);
    let probe = { alive: false, status: 0, requiresAuth: false };
    for (const port of candidates) {
      // 探活也带鉴权：否则上游永远回 401，日志里全是假的"401"，
      // 既看不出上游到底能不能用，也分不清"端口没对上"和"鉴权没通过"。
      const authority = `${config.desktopHost}:${port}`;
      let probeCookie = null;
      const session = desktop.sessionCookie;
      if (session && session.authority === authority && Date.now() - session.at < 10 * 60 * 1000) {
        probeCookie = session.header;
      } else {
        try {
          const cookie = mintCookie({ homeDir: config.dshHome, authority });
          probeCookie = `${cookie.name}=${cookie.value}`;
        } catch { /* 密钥读不出来时退化成无鉴权探测（仍能判断端口是否在监听） */ }
      }
      probe = await probeInstance(config.desktopHost, port, 800, probeCookie);
      if (probe.alive) {
        if (port !== config.desktopPort) {
          log(`桌面端实际在 ${port}（配置是 ${config.desktopPort}），已自动切换`);
          config.preferDesktop = true;   // 找到真实桌面端就一定要用它（否则仍会回落到桥接实例）
          config.desktopPort = port;
        }
        break;
      }
    }
    desktop.alive = probe.alive;
    desktop.status = probe.status;
    desktop.requiresAuth = probe.requiresAuth;
    // authenticated：带了 Cookie 探活仍回 401 ⇒ 鉴权真的没通过（不是"需要登录"而已）。
    desktop.authOk = probe.alive && (probe.status !== 401);
    desktop.lastError = null;
  } catch (error) {
    desktop.alive = false;
    desktop.lastError = error.message;
  }
  desktop.port = config.desktopPort;   // 之前只改了 config，desktop.port 一直显示旧值，误导排查
  desktop.checkedAt = Date.now();
  log('[探活] refreshDesktopState 完成 alive=' + desktop.alive + ' port=' + desktop.port + ' status=' + desktop.status + ' 发现=' + discoverDesktopPort());
  return desktop;
}

/**
 * 把"探桌面端 + 拉起 DSH + 落 runtime"放到**后台**做，请求路径立即返回。
 *
 * 为什么要这样：握手（/handshake）过去是同步 await 这两步的。实测在 DSH 未运行时，
 * `await dsh.start()` 会把响应拖到 **12.4 秒**，而手机端握手超时只有 8 秒 ——
 * 结果就是**每次握手都被判超时**，用户看到的现象是"扫码连不上 / 握手时好时坏"。
 * 握手要回答的只是"手机该连哪、用什么令牌"，这些都在缓存状态里，不需要等 DSH 起来。
 */
let backgroundRefreshInFlight = false;
let backgroundRefreshLastAt = 0;
function kickBackgroundRefresh() {
  // 5 秒内重复触发直接忽略：手机重连时会连打几次握手，不该重复启动。
  if (backgroundRefreshInFlight) return;
  if (Date.now() - backgroundRefreshLastAt < 5000) return;
  backgroundRefreshInFlight = true;
  backgroundRefreshLastAt = Date.now();
  (async () => {
    try {
      await refreshDesktopState(false);
      if (!dsh.running) {
        log("握手触发：后台启动 DSH 实例（不阻塞握手响应）");
        await dsh.start();
      }
      await publishRuntime();
    } catch (error) {
      log("后台刷新失败：" + (error && error.message ? error.message : error));
    } finally {
      backgroundRefreshInFlight = false;
    }
  })();
}

/** 为桌面端 authority 现签一个会话 Cookie（密钥持久化在凭据里）。 */
function desktopCookie() {
  const authority = `${config.desktopHost}:${config.desktopPort}`;
  const cookie = mintCookie({ homeDir: config.dshHome, authority });
  desktop.cookieReady = true;
  return cookie;
}

/**
 * 只接受回环 http 地址：桌面端会话地址里带 launch token，绝不能把桥接变成 SSRF 跳板。
 * @returns {{url:URL, authority:string, host:string, port:number}|null}
 */
function parseLoopbackSessionUrl(text) {
  let url;
  try {
    url = new URL(String(text || ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  const host = url.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { url, host, port, authority: `${host}:${port}` };
}

/** 发一个只用于"换 Cookie"的 GET：Host 必须显式写，否则桌面端的 authority 校验通不过。 */
function fetchLoopbackSession({ host, port, path: target, authority }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      method: 'GET',
      path: target,
      headers: { host: authority, accept: 'text/html' },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('换取会话超时')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 用桌面端自己下发的会话 Cookie 鉴权（权威路径）。
 *
 * 为什么需要它：自签 Cookie 依赖 `~/.dsh/.credentials.yaml` 里的浏览器会话密钥，
 * 而桌面端进程内的密钥与磁盘**并不总是同步**（实测同一份凭据、同一 authority，
 * 桌面端回 401，过一会儿又能通过）。真正可靠的做法是让 DSH 自己发牌：
 * 桌面端宿主里的 phone-bridge 插件能拿到 `connection.authenticatedUrl()` ——
 * 那个带 launch token 的地址访问一次就回 303 + Set-Cookie，桥接拿它换 Cookie 即可。
 *
 * @param {string} urlText 形如 http://127.0.0.1:<port>/?token=<launchToken>
 * @param {{force?:boolean}} [options] force=true 时忽略缓存，强制重换（401 自愈用）
 */
async function exchangeDesktopSession(urlText, options = {}) {
  const parsed = parseLoopbackSessionUrl(urlText);
  if (!parsed) return { ok: false, error: '会话地址必须是回环 http://127.0.0.1:<port>/?token=...' };

  const cached = desktop.sessionCookie;
  if (!options.force && cached && cached.authority === parsed.authority
      && Date.now() - cached.at < 10 * 60 * 1000) {
    return { ok: true, authority: parsed.authority, host: parsed.host, port: parsed.port, cached: true };
  }

  let res;
  try {
    res = await fetchLoopbackSession({
      host: parsed.host,
      port: parsed.port,
      authority: parsed.authority,
      path: `${parsed.url.pathname}${parsed.url.search}`,
    });
  } catch (error) {
    return { ok: false, error: `连接桌面端失败：${error.message}`, authority: parsed.authority };
  }

  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers['set-cookie']].flat().filter(Boolean);
  const pairs = raw
    .map((entry) => String(entry).split(';')[0].trim())
    .filter((entry) => entry.includes('='));
  if (pairs.length === 0) {
    return { ok: false, error: `桌面端没有下发会话 Cookie（HTTP ${res.status}）`, authority: parsed.authority };
  }

  desktop.sessionUrl = parsed.url.href;
  desktop.sessionCookie = { authority: parsed.authority, header: pairs.join('; '), at: Date.now() };
  // 插件报上来的端口就是事实来源：比 tasklist/netstat 猜出来的更准。
  config.desktopHost = parsed.host;
  config.desktopPort = parsed.port;
  log(`已用桌面端 token 换取会话 Cookie（${parsed.authority}，${pairs.length} 项）`);
  return { ok: true, authority: parsed.authority, host: parsed.host, port: parsed.port, cached: false };
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
    const authority = `${config.desktopHost}:${config.desktopPort}`;
    // ① 首选"桌面端自己发的牌"：插件交来 token 地址后换到的 Cookie。
    //    10 分钟内的缓存直接复用；过期就退回②，下一次 401 会再换一次。
    const session = desktop.sessionCookie;
    if (session && session.authority === authority && Date.now() - session.at < 10 * 60 * 1000) {
      desktop.authSource = 'session';
      return {
        host: config.desktopHost,
        port: config.desktopPort,
        authority,
        cookie: session.header,
      };
    }
    // ② 退而求其次：用凭据里的签名密钥自签（不依赖桌面端配合，先能用）。
    try {
      const cookie = desktopCookie();
      desktop.authSource = 'mint';
      return {
        host: config.desktopHost,
        port: config.desktopPort,
        authority,
        cookie: `${cookie.name}=${cookie.value}`,
      };
    } catch (error) {
      log(`桌面端 Cookie 生成失败，改用桥接实例：${error.message}`);
    }
  }
  if (dsh.running && dsh.cookie) {
    desktop.authSource = 'bridge';
    return {
      host: config.dshHost,
      port: config.dshPort,
      authority: `${config.dshHost}:${config.dshPort}`,
      cookie: dsh.cookie,
    };
  }
  desktop.authSource = 'none';
  return null;
}

/**
 * 让上游重新鉴权（401 时调用，**必须是异步的**）。
 *
 * 踩过的坑：旧实现只是 `refreshDesktopState(false).catch(...)` —— 既没有 await，
 * 又受 5 秒探活缓存影响。代理那边立刻 `getUpstream()` 重试，拿到的还是同一份
 * 失效凭据，于是"重试"注定再 401，手机端看到的就是 `dsh web authentication required`。
 *
 * 现在的顺序：
 *   ① 有会话地址 → 强制重换一次 Cookie（桌面端自己发牌，最可靠）；
 *   ② 清掉探活缓存并强制重探（端口可能已经变了）；
 *   ③ 都失败时返回，让代理层把 401 透传出去（不再假装重试）。
 */
async function refreshProxyUpstream() {
  if (desktop.sessionUrl) {
    try {
      const result = await exchangeDesktopSession(desktop.sessionUrl, { force: true });
      if (!result.ok) log(`上游会话重换失败：${result.error}`);
    } catch (error) {
      log(`上游会话重换异常：${error.message}`);
    }
  }
  desktop.checkedAt = 0;              // 不吃 5 秒缓存：端口/进程可能刚变过
  desktopPortCache = { at: 0, port: 0 };
  await refreshDesktopState(true).catch(() => {});
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
    // 只有**回环**请求才免令牌（USB 走 adb reverse 落在 127.0.0.1）。
    // ⚠️ 不能再拿"非 external"当免令牌条件：桥接现在始终监听 0.0.0.0，
    //    同网段任何设备都不是 external，那样等于把 DSH 界面（可执行任意代码）敞开给整个 Wi-Fi。
    if (!external && config.mode !== 'lan' && isLoopbackRequest(req)) return true;
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
  // ⚠️ 每次**现算**异地候选（配置的固定地址 + Tailscale 固定地址 + 隧道**实时**地址）。
  //    隧道域名会随隧道进程重启而变，用启动快照会让手机拿到已失效的地址 ——
  //    这正是"异地永远连不上"的根因，因此这里绝不缓存。
  const remoteBases = remote.publicBases();
  const remoteStatus = remote.status();
  const ts = remoteStatus.tailscale || {};
  const cf = (remote.tunnel && remote.tunnel.status()) || {};
  return {
    service: 'dsh-phone-bridge',
    version: BRIDGE_VERSION,
    // 出处指纹：运维/取证时据此确认这份 runtime 状态来自原始项目（见 README.md）
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
      // authenticated=false 且 alive=true ⇒ 探活带着 Cookie 仍被 401（鉴权没通过，不是"没登录"）
      authenticated: desktop.authOk === true,
      // 当前用的哪条鉴权：session=桌面端自己发牌 / mint=凭据密钥自签 / bridge=桥接实例
      authSource: desktop.authSource,
      hasDesktopSession: Boolean(desktop.sessionCookie),
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
      // —— 异地候选（跨网络）——
      // remoteBases 是手机端应当遍历的完整列表（固定配置 → Tailscale → 隧道，已去重排序）。
      // 之所以同时给出分项明细：排查时要一眼看出"到底是固定通道还是临时隧道"。
      remoteBases,
      remoteConfigured: remote.configuredBases,
      // 固定的 Tailscale 地址（100.x，跨 NAT/加密/重启不变）；未登录时为空数组，不伪造
      tailscaleBase: (ts.baseUrls || [])[0] || null,
      tailscaleBases: ts.baseUrls || [],
      tailscaleAvailable: ts.state === 'ready',
      tailscaleState: ts.state || 'unknown',
      // 实时隧道地址（每次请求现取，不用启动快照）+ 隧道复用情况
      tunnelBase: cf.publicUrl || null,
      tunnelUptimeSeconds: cf.uptimeSeconds || 0,
      tunnelPid: cf.pid || null,
      remoteStable: remote.hasStable(),
      remoteNote: remote.note(),
      // 建议超时：直接告诉手机端"这类链路该等多久"。
      // 为什么由电脑端下发：三类链路的最佳值差一个数量级（本机几十毫秒、隧道 1~2 秒），
      // 客户端写死任何一个值都必然在另一类链路上误判（写 1.2s 会让异地永远超时）。
      // 由 lib/tuner.js 按**实测健康度**给出建议值（手工权重的微型前馈网络，无需训练）。
      // 输入全部来自真实测量：隧道的 /health 往返毫秒与成败计数（见 lib/tunnel.js 的 health）。
      // 没有样本时它退回按链路类型的基线，不会瞎猜。
      timeouts: (() => {
        const th = (cf && cf.health) || {};
        const linkMode = remoteBases.length > 0 ? 'remote' : (config.mode === 'usb' ? 'usb' : 'lan');
        const tune = tuner.suggest({
          mode: linkMode,
          rttMs: th.samples > 0 ? th.rttMs : null,
          failRate: th.failRate || 0,
          reconnects: 0,
        });
        return {
          usb: 1200,
          lan: 1300,
          remote: tune.probeTimeoutMs,
          handshake: tune.handshakeTimeoutMs,
          retries: tune.retries,
          tunerNote: tune.explain,
        };
      })(),
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
/**
 * 这个请求是不是**从本机回环**来的（adb reverse 的 USB 通道、PC 本机浏览器都算）。
 *
 * 为什么单独抽出来：桥接现在始终绑 0.0.0.0（USB + 局域网双通道），
 * "非 external" 已经不再等于"本机"——同网段的任何设备都不是 external。
 * 免令牌只能给回环，否则等于把可执行代码的 DSH 界面敞开给整个 Wi-Fi。
 */
function isLoopbackRequest(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  const ip = addr.replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

/**
 * 手机 App 下载地址：直接指向发布页的 latest 资产。
 *
 * 为什么只放链接、不在本机代发 APK：面板的作用是"告诉你在哪下"，
 * 真正下载走 GitHub（国内打不开时页面底部给了加速镜像）。本机代发要多一条
 * 路由、一份 3.8MB 的随包二进制，收益抵不上复杂度，故不采用。
 */
function apkDownloadUrl() {
  return `${RELEASE_REPO}/releases/latest/download/app-release.apk`;
}

/** 电脑端插件包：走发布页（体积小，且用户下载的就是与当前版本一致的包）。 */
function pluginDownloadUrl() {
  return `${RELEASE_REPO}/releases/latest/download/${PLUGIN_ZIP_NAME}`;
}

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
  // Tailscale 的 100.64.0.0/10：
  //   它**不是**"可信本机"——tailnet 里其它设备也能到达桥接端口，所以鉴权一点都不能放宽
  //   （authorizeDshAccess 里"免令牌"只给 127.0.0.1/::1，本函数只负责分类）。
  //   归到"非外部"是因为：这类请求不可能来自公网扫描器（没有 tailnet 就路由不到），
  //   而且它在局域网模式下同样需要令牌，分类为内部不会扩大暴露面。
  if (config.trustTailscaleAsLan && isTailscaleCgnat(ip)) return false;
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
 /* 整体居中：内容无论多少都落在可视区正中，嵌在设置面板的 iframe 里同样成立。
    但**必须用 safe center**：父窗口（DSH 弹窗）把 iframe 压矮时，普通 center 会让
    内容从上下两端同时溢出并被裁掉 —— 二维码只露出中间一条，扫不出来。
    safe center 在放不下时退回 flex-start，配合 overflow:auto 变成"可滚动"而不是"被切掉"。 */
 body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;
      min-height:100%;display:flex;flex-direction:column;align-items:center;
      justify-content:safe center;
      overflow-y:auto;overscroll-behavior:contain;
      background:#0b0d12;color:#e8eaf0;padding:20px 16px;gap:14px;text-align:center}
 h1{font-size:22px;margin:0;font-weight:600}
 .sub{color:#8b93a7;font-size:14px;line-height:1.6;max-width:520px}
 .card{background:#151922;border:1px solid #232a36;border-radius:16px;padding:18px;
       display:flex;flex-direction:column;align-items:center;gap:12px}
 /* 二维码：白底 + 静区；pixelated 让整数缩放不糊，比默认双线性更利于识别 */
 img.qr{width:min(62vw,340px);height:auto;background:#fff;border-radius:12px;padding:12px;display:block;
        image-rendering:pixelated;image-rendering:crisp-edges}
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
 /* 异地通道卡片：固定通道用绿色边框，临时隧道用黄色，一眼看出"稳不稳" */
 .card.remote{width:min(92vw,560px)}
 .card.remote.stable{border-color:#1f7a4d}
 .card.remote.temporary{border-color:#7a5c1f}

 /* ---- 下载区：App 与插件是配套的两件，放在同一张卡片里 ---- */
 .card.downloads{width:min(92vw,560px);gap:10px}
 .dlrow{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap}
 .dlbtn{display:inline-flex;align-items:center;gap:7px;padding:9px 14px;border-radius:9px;
        font-size:14px;font-weight:600;text-decoration:none;background:#2563eb;color:#fff;
        border:1px solid transparent}
 .dlbtn:hover{text-decoration:none;filter:brightness(1.08)}
 .dlbtn.ghost{background:rgba(255,255,255,.08);color:#e8eaf0;border-color:rgba(255,255,255,.28)}
 .copybtn{background:transparent;color:#9fb3d1;border:1px solid #2b3446;border-radius:8px;
          padding:7px 11px;font-size:12.5px;cursor:pointer}
 .copybtn:active{background:#1b2230}
 .dlnote{color:#6f7789;font-size:11.5px;line-height:1.6;max-width:520px}
 .verrow{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;
         color:#8b93a7;font-size:12.5px}
 /* 嵌入模式：可选内容折叠，保证二维码与配对码在弹窗里完整可见 */
 .moreBox{width:min(92vw,560px);text-align:left}
 .moreBox>summary{cursor:pointer;color:#9fb3d1;font-size:12.5px;padding:8px 10px;border:1px solid #2b3446;
                   border-radius:9px;background:rgba(255,255,255,.04);list-style:none;text-align:center}
 .moreBox>summary::-webkit-details-marker{display:none}
 .moreBox[open]{display:flex;flex-direction:column;gap:10px;align-items:center}
 .moreBox[open]>summary{margin-bottom:2px}

 /* ---- 嵌入模式：只缩小尺寸，不减内容 ---- */
 body.embed{padding:12px 10px;gap:9px}
 body.embed h1{font-size:17px}
 body.embed .sub{font-size:12.5px;line-height:1.5}
 body.embed .card{padding:11px;gap:9px;border-radius:12px}
 body.embed .card.remote{width:100%}
 body.embed img.qr{width:min(56vw,240px);padding:8px;border-radius:10px}
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
${embed ? `<details class="moreBox"><summary>更多：异地通道 / 下载 / 版本</summary>` : ''}
${info.remoteHtml}
<div class="card downloads">
  <div class="sub">App 与电脑端插件是配套的两件，缺一不可</div>
  <div class="dlrow">
    <a class="dlbtn" href="${info.apkHref}">⬇ 手机 App（APK）</a>
    <button class="copybtn" type="button" data-copy="${info.apkHref}">复制链接</button>
  </div>
  <div class="dlrow">
    <a class="dlbtn ghost" href="${info.pluginHref}">⬇ 电脑端插件（ZIP）</a>
    <button class="copybtn" type="button" data-copy="${info.pluginHref}">复制链接</button>
  </div>
  <div class="dlnote">${info.apkNote}</div>
</div>
<div class="verrow">
  <span>插件 v${info.version}${info.updateNote}</span>
  ${info.updateActions}
</div>
${embed ? `</details>` : ''}
<div class="tip">二维码与配对码等同本机操作权限，请勿外发。<br>
App 里也可点「直接连接」——插着数据线或用同一 WiFi 时会自动发现；<br>
异地时会自动切换到上面的公网地址。</div>
<script>
(function(){
  // 复制按钮：navigator.clipboard 只在安全上下文可用（127.0.0.1 算安全，局域网 IP 不算），
  // 所以备一条 textarea + execCommand 的旧通道。
  document.querySelectorAll('.copybtn').forEach(function(btn){
    btn.addEventListener('click', function(){
      var text = btn.getAttribute('data-copy') || '';
      function done(){ var t = btn.textContent; btn.textContent = '已复制'; setTimeout(function(){ btn.textContent = t; }, 1200); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
      function fallback(){
        try {
          var ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta); done();
        } catch (e) { window.prompt('手动复制下面的链接：', text); }
      }
    });
  });
})();
</script>
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

/**
 * 配对页上的「异地通道」卡片。
 *
 * 为什么值得单独做一块界面：异地连不上的**根因**几乎总是"免费快速隧道的地址变了"
 * （实测一小时内变过 4 次）。用户在下结论"App 有 bug"之前，应当能一眼看到：
 *   · 当前有没有**固定**异地通道（Tailscale / 手工配置的域名）；
 *   · 若只有临时隧道，明确写出"地址会变，建议启用 Tailscale 或配置固定地址"。
 * 这是在手机上给出可操作提示的**电脑侧对应物**（两边文案一致，避免互相甩锅）。
 */
function renderRemoteCard(remote) {
  // 秒 → "x 分钟"：配对页上让人一眼看出隧道活了多久（越久越说明地址是稳定的）
  const uptimeText = (sec) => {
    const s = Math.max(0, Math.round(Number(sec || 0)));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
  };
  if (!remote || remote.bases.length === 0) {
    return `<div class="card remote temporary">
  <div class="sub"><b class="warn2">当前没有可用的异地通道</b></div>
  <div class="tip">人在外面（不同网络）时连不上属于预期：请启用 Tailscale（登录后自动获得固定地址），
或在 bridge.config.json 里填写固定的 <code>remoteBase</code>。</div>
</div>`;
  }
  if (remote.stable) {
    return `<div class="card remote stable">
  <div class="sub"><b class="ok">异地通道：固定地址</b>　人在外面也能稳定连上，重启不变</div>
  ${remote.configured.map((b) => `<code style="font-size:12px">${b}</code>`).join('')}
  ${remote.tailscale.map((b) => `<code style="font-size:12px">${b}</code>`).join('')}
  ${remote.tunnel ? `<div class="tip">备用临时隧道（桥接重启不会换地址）：<code style="font-size:11px">${remote.tunnel}</code></div>` : ''}
</div>`;
  }
  return `<div class="card remote temporary">
  <div class="sub"><b class="ok">异地通道：本项目自带的 Cloudflare 隧道</b>　无需账号、无需额外安装</div>
  <code style="font-size:12px">${remote.tunnel}</code>
  <div class="tip">隧道由项目自己的守护进程持有：<b>重启桥接不会换地址</b>${remote.uptimeSeconds
    ? `（当前已运行 ${uptimeText(remote.uptimeSeconds)}）` : ''}。<br>
只在隧道进程本身重启时地址才会变，此时在同一网络下打开一次 App 即会自动同步新地址。<br>
想要"永不变化"的地址：可配置固定的 <code>remoteBase</code>，或启用可选的 Tailscale 通道。</div>
</div>`;
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
</script><!-- ${ORIGIN_MARK} · MIT · 见 README.md --></body></html>`;

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

    // —— 版本检查：插件面板与手机 App 共用同一份判断 ——
    //    放在电脑端做，是因为判断逻辑只能有一处；手机只负责显示/跳转。
    if (route === '/version' && req.method === 'GET') {
      const info = await versionCheck.check(PLUGIN_VERSION);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ ok: true, bridge: BRIDGE_VERSION, plugin: PLUGIN_VERSION, ...info }));
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
        // 异地通道状态：手机据此判断"能不能跨网络连回来"。
        // 持久化实现下这是**实时读盘**的结果（桥接重启也会复用同一条隧道，地址不变）。
        tunnel: (() => {
          const st = remote.tunnel ? remote.tunnel.status() : { state: 'disabled' };
          return {
            state: st.state,
            publicUrl: st.publicUrl || null,
            lastError: st.lastError || null,
            uptimeSeconds: st.uptimeSeconds || 0,
            pid: st.pid || null,
            persistent: Boolean(st.persistent),
            reused: Boolean(remote.tunnel && remote.tunnel.lastStart && remote.tunnel.lastStart.reused),
          };
        })(),
        // 异地候选（含 Tailscale 固定地址/手工配置），手机端可直接遍历
        remoteBases: remote.publicBases(),
        remoteNote: remote.note(),
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
    // ⚠️ 必须同时满足三个条件：
    //   ① 非隧道来源 —— cloudflared 跑在本机，公网请求的来源同样是 127.0.0.1，
    //      只看回环会把"整个互联网"当成本机（实测：公网 /handshake 直接返回了 bridgeToken 明文）；
    //   ② 回环来源 —— 桥接始终监听 0.0.0.0，同 Wi-Fi 设备不是回环；
    //   ③ usb 模式 —— 局域网模式一律要令牌。
    const usbOnlyPublic = config.mode === 'usb'
      && !isExternalRequest(req)
      && isLoopbackRequest(req)
      && (route === '/handshake' || route === '/desktop' || route === '/pair');
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
        // ⚠️ 实时取值：隧道进程重启会换域名，快照会让配对结果当场失效。
        //    持久化隧道下这里通常是"复用中的同一地址"，但代码不能依赖这一点。
        const remoteNow = remote.publicBases();
        const remoteStableNow = remote.hasStable();
        for (const base of remoteNow) bases.push(base);
        log(`配对码匹配成功，已下发 ${bases.length} 个候选地址`
          + `（异地 ${remoteNow.length} 个：固定通道 ${remoteStableNow ? '有' : '无'}）`);
        sendJson(res, 200, {
          ok: true,
          bases: Array.from(new Set(bases)),
          token: config.bridgeToken,
          mode: config.mode,
          // 异地基址单独给出，便于 App 在局域网不可达时直接切过去
          remoteBase: remoteNow[0] || null,
          // 完整异地候选列表（App 会把它持久化为 remoteHints 供下次使用）
          remoteBases: remoteNow,
          remoteStable: remoteStableNow,
          remoteNote: remote.note(),
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
        const remoteBasesNow = remote.publicBases();
        const remoteStatusNow = remote.status();
        const tsNow = remoteStatusNow.tailscale || {};
        const cfNow = (remote.tunnel && remote.tunnel.status()) || {};
        const body = JSON.stringify({
          ok: true,
          qrDataUrl,
          payload: text,
          target: text.split('|')[1] || '',
          mode: config.mode,
          desktopAlive: desktop.alive,
          // 异地通道：手机拿到这个地址后，在任何网络下都能连回本机。
          // 持久化隧道下它**跨桥接重启保持不变**；每次请求仍现取，绝不缓存。
          tunnel: {
            state: cfNow.state || 'disabled',
            publicUrl: cfNow.publicUrl || null,
            uptimeSeconds: cfNow.uptimeSeconds || 0,
            pid: cfNow.pid || null,
            persistent: Boolean(cfNow.persistent),
            reused: Boolean(remote.tunnel && remote.tunnel.lastStart && remote.tunnel.lastStart.reused),
          },
          endpoints: {
            usbBase: `http://127.0.0.1:${config.bridgePort}`,
            lanBases: config.lanAddresses.map((e) => `http://${e.address}:${config.bridgePort}`),
            // —— 异地候选 ——
            // remoteBases：完整列表（固定配置 → Tailscale 固定地址 → 实时隧道），手机端遍历它。
            remoteBases: remoteBasesNow,
            remoteConfigured: remote.configuredBases,
            tailscaleBase: (tsNow.baseUrls || [])[0] || null,
            tailscaleBases: tsNow.baseUrls || [],
            tailscaleAvailable: tsNow.state === 'ready',
            tailscaleState: tsNow.state || 'unknown',
            tunnelBase: cfNow.publicUrl || null,
            remoteStable: remote.hasStable(),
            remoteNote: remote.note(),
            // 兼容旧字段名（App 旧版本读的是 remoteBase），语义 = "首选异地地址"
            remoteBase: remoteBasesNow[0] || null,
          },
          remoteBases: remoteBasesNow,
          remoteStable: remote.hasStable(),
          remoteNote: remote.note(),
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
        const tunnelStatus = (remote.tunnel && remote.tunnel.status()) || { state: 'disabled' };
        // 异地通道一律**实时**取值：隧道域名会变，快照等于发布一个过期地址。
        const remoteNow = remote.publicBases();
        const remoteStableNow = remote.hasStable();
        // ?embed=1 → DSH 插件弹窗内嵌用：排布更紧凑，并回报自身高度供父窗口精确适配
        const embed = url.searchParams.get('embed') === '1';
        // 版本检查走缓存（10 分钟），失败也不影响配对页本身
        let updateInfo = null;
        try { updateInfo = await versionCheck.check(PLUGIN_VERSION); } catch { updateInfo = null; }
        const page = renderPairPage(qrDataUrl, {
          mode: config.mode,
          desktopAlive: desktop.alive,
          target,
          pairCode: PAIR_CODE,
          // 下载区：只放两条发布链接（App / 插件），面板不代发文件。
          apkHref: apkDownloadUrl(),
          pluginHref: pluginDownloadUrl(),
          apkNote: '两者配套使用：手机装 App、电脑装插件。国内打不开 GitHub 时，可用发布页里的加速镜像。',
          // 版本行：面板里直接看到"当前版本 / 有没有新版"，并给出升级动作。
          version: PLUGIN_VERSION,
          updateNote: updateInfo && updateInfo.hasUpdate
            ? ` · 有新版本 v${updateInfo.latest}`
            : (updateInfo && updateInfo.reachable ? ' · 已是最新' : ' · 暂时查不到新版本'),
          updateActions: updateInfo && updateInfo.hasUpdate
            ? `<button class="copybtn" type="button" data-copy="dsh plugin add github:MengTan100/pocketpilot">复制升级命令</button>` +
              `<a class="dlbtn ghost" href="${updateInfo.pluginUrl}">下载新版插件</a>`
            : '',
          // 异地通道：让用户直观看到"人在外面也能连"，以及"这个地址稳不稳"
          tunnelState: tunnelStatus.state,
          tunnelUrl: tunnelStatus.publicUrl || '',
          remoteHtml: renderRemoteCard({
            bases: remoteNow,
            configured: remote.configuredBases,
            tailscale: (remote.status().tailscale || {}).baseUrls || [],
            tunnel: tunnelStatus.publicUrl || null,
            stable: remoteStableNow,
            note: remote.note(),
            uptimeSeconds: tunnelStatus.uptimeSeconds || 0,
          }),
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

      case '/upstream/desktop-session': {
        // 桌面端插件（跑在 DSH 宿主进程里）把 `connection.authenticatedUrl()` 交过来 ——
        // 这是**权威**的上游鉴权来源：带 launch token 的地址访问一次就回 303 + Set-Cookie。
        // 走通用鉴权（需要 bridge token），失败也不影响"自签 Cookie"的兜底路径。
        const sessionUrl = String(body.url || '');
        // force=true：插件刚发现 DSH 宿主重启/密钥轮换时可以要求立刻重换，不吃 10 分钟缓存。
        const result = await exchangeDesktopSession(sessionUrl, { force: body.force === true });
        if (result.ok) {
          desktop.alive = true;
          desktop.lastError = null;
          desktop.checkedAt = 0;
        } else {
          log(`上游会话地址不可用：${result.error}`);
        }
        sendJson(res, result.ok ? 200 : 502, result);
        return;
      }

      case '/handshake':
      case '/state': {
        // ⚠️ 不要在这里同步等待：原实现 await 了 refreshDesktopState + dsh.start()，
        // 在 DSH 未运行时实测把响应拖到 12.4 秒，而手机握手超时只有 8 秒 → 必然超时。
        // 握手的答案（入口、令牌、候选地址）都在缓存里，直接返回；拉起 DSH 交给后台。
        kickBackgroundRefresh();
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

  // 上游探活必须**主动周期性**做，而不是等某个请求顺带触发。
  // 踩过的坑：桌面端端口会变（19387 → 53274 → 53760），若只在请求路径里探，
  // 一旦那条分支没走到，desktop.alive 就永远 false → 手机端"上游不可用"。
  const tickUpstream = () => {
    refreshDesktopState(true)
      .then(() => {
        if (desktop.alive) {
          log(`上游就绪：桌面端 ${config.desktopHost}:${config.desktopPort}（status=${desktop.status}）`);
          clearIntervalProbe();
        }
      })
      .catch(() => {});
  };
  const probeTimer = setInterval(tickUpstream, 10000);
  probeTimer.unref?.();
  function clearIntervalProbe() { clearInterval(probeTimer); }
  setTimeout(tickUpstream, 1500).unref?.();
  log(`dsh CLI: ${config.dshCli}`);
  log(`adb    : ${config.adbPath}`);
  log(`异地通道 provider 顺序：${(config.remoteProviders || []).join(' → ') || '(无)'}`
    + ` · 隧道复用=${config.tunnelReuse !== false ? '开' : '关'}`);

  // 只装不改（可选增强）：--install-tailscale 时走"下载 + 校验 + （确认后）安装"，
  // 完成后照常启动桥接 —— 用户拿到的是"项目自己把异地通道准备好"，而不是一句"请自行安装"。
  if (process.argv.includes('--install-tailscale')) {
    log('开始准备 Tailscale（可选增强：固定异地地址）…');
    const r = await remote.installTailscale();
    log(`Tailscale 准备结果：${JSON.stringify({
      ok: r.ok, state: r.state, file: r.file, source: r.source, verified: r.verified,
      awaitingConfirm: r.awaitingConfirm, error: r.error, detail: r.detail,
    })}`);
    if (!r.ok && r.error) log(`未能自动完成：${r.error}`);
  }

  // 专用工作区：避免把用户主目录当工作区（ACL 沙箱临时根会落在工作区内被拒）
  try {
    fs.mkdirSync(config.workspace, { recursive: true });
    log(`工作区: ${config.workspace}`);
  } catch (error) {
    log(`创建工作区失败：${error.message}`);
  }

  // ⚠️ 始终绑 0.0.0.0：USB 与局域网**同时可用**（"双通道叠加"）。
  //
  // 以前 usb 模式只绑 127.0.0.1 —— 那时拔掉数据线，手机手里只剩 `127.0.0.1:3080`
  // 这个死地址，局域网候选再多也没用：**根本没有监听**，App 想切也切不过去。
  // 现在两条通道一直并行：USB 走 adb reverse（回环，免令牌），局域网走真实网卡
  //（必须带 bridge token，见 authorizeDshAccess）。手机择优用一条、另一条待命，
  // 拔线/换网时可以直接切换，不必等桥接重启。
  server.listen(config.bridgePort, '0.0.0.0', () => {
    const lanUrls = config.lanAddresses.map((entry) => `http://${entry.address}:${config.bridgePort}`);
    log(`桥接控制面监听 0.0.0.0:${config.bridgePort}`);
    log(`  · USB 通道（adb reverse）: http://127.0.0.1:${config.bridgePort}（免令牌）`);
    log(`  · 局域网通道: ${lanUrls.length ? lanUrls.join(' , ') : '(未发现局域网地址)'}（需要 ?k=<bridgeToken>）`);
    if (lanUrls.length > 0 && config.mode !== 'lan') {
      log('  提示：局域网通道首次使用若连不上，请允许 Node.js 通过 Windows 防火墙（专用网络）。');
    }
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

  // 隧道看门狗：与下面的 5 秒主循环共用同一节拍。
  // 隧道一旦死了就自动重建，新地址立刻写进 runtime/tunnel.json，
  // 于是 /pair.json、/handshake、状态页下一轮就发布新地址（手机经本地路径握手时就能学到）。
  setInterval(async () => {
    await syncTunnel(config);
    await refreshDesktopState(false);
    // 异地通道看门狗（只有持久化隧道提供者实现了 watch）
    try {
      await remote.watchAll();
    } catch (error) {
      log(`异地通道看门狗异常：${error.message}`);
    }
    if (!dsh.running && !dsh.pending) {
      log('检测到 DSH 未运行，尝试拉起');
      dsh.start().catch((error) => log(`拉起失败：${error.message}`));
    }
    await publishRuntime();
  }, 5000).unref();

  // 启动后把"这次到底是复用还是新建"明确写一行，便于事后诊断地址是否换过
  const cfStart = cfTunnel && cfTunnel.lastStart;
  if (cfStart && cfStart.publicUrl) {
    log(cfStart.reused
      ? `异地隧道：复用 ${cfStart.publicUrl}（${cfStart.reason}）—— 地址与上次相同`
      : `异地隧道：新建 ${cfStart.publicUrl}（地址已变化，手机下次经本地路径握手即会自动更新）`);
  }
}

async function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  // ⚠️ 默认**不**停隧道：隧道由独立守护进程持有，停掉就等于换地址，
  //    异地又得重新学一次（这正是历史上"异地连不上"的成因）。
  //    要停请显式 --tunnel-stop。
  if (config.tunnelStopOnExit) {
    try {
      remote.stopAll();
      log('已按 --tunnel-stop 停止异地通道');
    } catch (error) {
      log(`停止异地通道失败：${error.message}`);
    }
  } else {
    log('保留异地隧道（地址不变）；如需一并停止请用 --tunnel-stop');
  }
  if (!config.keepDshOnExit) await dsh.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  log(`致命错误：${error.stack || error.message}`);
  process.exit(1);
});
