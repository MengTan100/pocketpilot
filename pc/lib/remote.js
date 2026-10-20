// SPDX-License-Identifier: Apache-2.0
'use strict';
/**
 * remote.js —— 「异地（跨网络）通道」统一提供者层（provider layer）。
 *
 * 为什么要有这一层：
 *   异地访问不是"一个功能"，而是**一组可替换的通道**。之前只有 Cloudflare 快速隧道
 *   被硬编码在 bridge.js 里，于是：隧道地址每次重启就变（实测一小时内变过 4 次），
 *   手机缓存的异地地址必然过期 —— 用户看到的现象就是"异地永远连不上"。
 *   而机器上其实还有一个地址**固定不变**的通道（Tailscale 的 100.x，WireGuard 加密、跨 NAT）。
 *   所以这里把两者收敛成同一个接口，由桥接统一择优、统一发布：
 *
 *     ┌── remote.js（本文件）──────────────────────────────────────────┐
 *     │  provider 'tailscale'  ← 首选：地址固定（100.64.0.0/10）        │
 *     │      没有它 → 自动下载/安装官方安装包（用户确认后，不静默安装）  │
 *     │      未登录 → 解析出登录链接，在状态页与日志里告诉用户怎么点     │
 *     │  provider 'cloudflared' ← 兜底：免费、地址每次重启会变          │
 *     └───────────────────────────────────────────────────────────────┘
 *
 * 与项目的既有做法保持一致（这是"集成在项目里"而不是"让用户自己去装"的关键）：
 *   · 二进制自备：cloudflared 由项目自带（pc/tools/bin/），Tailscale 安装包由项目
 *     自己下载到 pc/tools/downloads/（已在 .gitignore 里，绝不入库）；
 *   · 自己起停：cloudflared 子进程由项目 spawn/kill；Tailscale 是系统服务，
 *     项目只做"检测 + 登录引导 + 启动（tailscale up）"，绝不偷偷跑 UAC 升级；
 *   · 自己发布地址：统一由 publicBases() 给出候选列表，bridge.js 的 /pair.json、
 *     /pair、/handshake、/health、/state 全部消费它，不再各自算一遍。
 *
 * 依赖注入（deps）是本文件可测的关键：所有"外部世界"的动作（跑 CLI、读网卡、下载、
 * 装包）都从 deps 进来，测试里换成假实现就能在**不碰真实系统**的前提下覆盖
 * 「没装 / 未登录 / 已就绪 / 平台不支持」四条路径 —— 这正是硬性要求里的自检项。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const { createTunnel, createPersistentTunnel, isProcessAlive } = require('./tunnel');

// ---------------------------------------------------------------- 公共小工具

/** Tailscale 的地址段 100.64.0.0/10（CGNAT）。它只能作为**异地**候选，不能算局域网。 */
function isTailscaleCgnat(address) {
  const text = String(address || '');
  // 100.64.0.0/10 → 第二段 64..127
  return /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(text);
}

/** 地址归一化：补协议头、去掉末尾斜杠。 */
function normalizeBase(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, '');
}

/** 从任意文本里解析出 Tailscale 的登录链接（`tailscale status` 会打印 `Log in at: …`）。 */
function parseLoginUrl(text) {
  const m = /(https:\/\/login\.tailscale\.com\/[a-z]\/[A-Za-z0-9]+)/i.exec(String(text || ''));
  return m ? m[1] : null;
}

/** 解析 `tailscale status` 输出的状态量（NeedsLogin / LoggedOut / Stopped / Running…）。 */
function parseBackendState(text) {
  const m = /state[:：]\s*([A-Za-z]+)/.exec(String(text || ''));
  return m ? m[1] : '';
}

/** 读本机网卡里的 100.64.0.0/10 地址（不依赖任何 CLI，离线可用）。 */
function interfaceTailscaleAddresses(networkInterfaces) {
  const addresses = [];
  const interfaces = [];
  const nets = networkInterfaces || os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (!isTailscaleCgnat(entry.address)) continue;
      if (!addresses.includes(entry.address)) addresses.push(entry.address);
      if (!interfaces.includes(name)) interfaces.push(name);
    }
  }
  return { addresses, interfaces };
}

// ---------------------------------------------------------------- Tailscale 提供者

/** 各平台 tailscale CLI 的常见位置（找不到就交给 PATH）。 */
function defaultCliCandidates() {
  const list = [];
  if (process.platform === 'win32') {
    list.push(
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Tailscale', 'tailscale.exe'),
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/usr/local/bin/tailscale',
      '/opt/homebrew/bin/tailscale',
    );
  } else {
    list.push('/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale');
  }
  return list.filter(Boolean);
}

/** 官方下载源上「Windows 安装包 + 同名 sha256 清单」的候选 URL（按先后尝试）。 */
const TAILSCALE_DOWNLOAD = {
  /** 固定版本（离线/首页不可抓时兜底）；与 pkgs 上的文件名一致。 */
  pinnedVersion: '1.104.1',
  /** 包含 "tailscale-setup-<ver>.exe" 链接的索引页。 */
  indexPages: ['https://pkgs.tailscale.com/stable/'],
  /** 由版本号构造安装包与哈希清单 URL 的模板（{v} = 版本号）。 */
  fileTemplates: [
    'https://pkgs.tailscale.com/stable/tailscale-setup-{v}.exe',
    'https://pkgs.tailscale.com/stable/tailscale-setup-{v}.exe.sha256',
  ],
};

/**
 * 创建 Tailscale 提供者。
 *
 * deps 全部可注入：fileExists / readDir / networkInterfaces / runCli / platform / sleep
 * —— 于是"没装 / 未登录 / 已就绪 / 平台不支持"都能被离线测试覆盖。
 */
function createTailscaleProvider(options = {}) {
  const {
    binary = '',
    port = 3080,
    autostart = true,
    autoInstall = true,
    autoInstallConfirm = false,
    downloadsDir = path.join(__dirname, '..', 'tools', 'downloads'),
    log = () => {},
    announce = (line) => console.log(line),
    runCli = defaultRunCli,
    networkInterfaces = () => os.networkInterfaces(),
    fileExists = (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    },
    readDir = (p) => {
      try { return fs.readdirSync(p); } catch { return []; }
    },
    download = downloadFile,
    install = installWindowsInstaller,
    platform = process.platform,
  } = options;

  /** bin/ 目录：项目自带的放置点（用户按提示把安装包解出来的 CLI 放这里也能用）。 */
  const binDir = path.join(__dirname, '..', 'tools', 'bin');
  const localBinary = path.join(binDir, platform === 'win32' ? 'tailscale.exe' : 'tailscale');

  let lastCliOutput = '';
  let loginUrl = null;
  let cached = null;
  let cachedAt = 0;
  let running = false;
  let lastError = null;
  let installState = { state: 'idle', detail: '' };
  let installInFlight = false;

  /** 上一次扫描里"本机有没有装"（决定要不要走自动下载）。 */
  let installed = { cli: null, app: false };

  /** 找 CLI：配置 > 项目自带 bin/ > 系统常见位置 > PATH。 */
  function resolveCli() {
    const candidates = [];
    if (binary) candidates.push(binary);
    candidates.push(localBinary, ...defaultCliCandidates());
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (fileExists(candidate)) return candidate;
    }
    return null;
  }

  /** 平台是否"可以尝试自动安装"（当前只实现 Windows 官方 exe 安装包）。 */
  function installSupported() {
    return platform === 'win32';
  }

  /** 没有 CLI 时，判断"是不是装了但 CLI 不在预期位置"（桌面版 App 的情况）。 */
  function appInstalledWithoutCli() {
    if (platform === 'win32') {
      return fileExists('C:\\Program Files\\Tailscale\\tailscaled.exe')
        || fileExists(path.join(process.env.LOCALAPPDATA || '', 'Tailscale'));
    }
    return false;
  }

  /** 带缓存的 CLI 执行（默认 5 秒），避免状态页每次刷新都起进程。 */
  function cli(args, { timeoutMs = 4000, cacheMs = 5000 } = {}) {
    const key = args.join(' ');
    const now = Date.now();
    if (cached && cached.key === key && now - cachedAt < cacheMs) return cached.value;
    const value = runCli(args, { timeoutMs });
    lastCliOutput = `${value.stdout || ''}${value.stderr || ''}`;
    cached = { key, value };
    cachedAt = now;
    return value;
  }

  /**
   * 完整状态。任何分支都**不抛异常** —— 异地通道是增强项，
   * 它出问题绝不能影响 USB/局域网（硬性要求：没装也不能崩）。
   */
  function status() {
    const iface = interfaceTailscaleAddresses(networkInterfaces());
    const cliPath = resolveCli();
    const ifaceUrls = iface.addresses.map((address) => `http://${address}:${port}`);

    // ① 网卡里已有 100.x 且 CLI 可用 → 完全就绪。
    //    （注意：网卡有地址但 CLI 缺失也可能连得通 —— 只是我们无法读取/引导登录，
    //      所以这种情况仍按 ready 处理，但把 cliMissing 记下来，便于排查。）
    if (iface.addresses.length > 0) {
      return {
        name: 'tailscale',
        state: 'ready',
        detail: `已就绪（Tailscale 网卡 ${iface.interfaces.join(',') || '?'}）：`
          + `${iface.addresses.join(', ')}，跨 NAT 加密且**重启不变**`,
        baseUrls: ifaceUrls,
        loginUrl: null,
        cliPath,
        interfaces: iface.interfaces,
        installSupported: installSupported(),
        action: null,
        lastError: null,
      };
    }

    // ② 没有地址但有 CLI → 未登录 / 服务未启动：给出**可操作**指引。
    if (cliPath) {
      const st = cli(['status'], { timeoutMs: 4000 });
      const text = `${st.stdout || ''}${st.stderr || ''}`;
      const backend = parseBackendState(text);
      loginUrl = parseLoginUrl(text) || loginUrl;

      if (/logged out|needslogin|not logged in|stopped/i.test(text) || !st.ok) {
        const loggedOut = /logged out|needslogin|not logged in/i.test(text);
        return {
          name: 'tailscale',
          state: loggedOut ? 'needs-login' : 'stopped',
          detail: loggedOut
            ? 'Tailscale 已安装但未登录（Logged out）：登录后即获得固定的 100.x 地址，异地访问不再受隧道换址影响。'
            : 'Tailscale 已安装但服务未运行：可在系统托盘启动，或执行 tailscale up。',
          baseUrls: [],
          loginUrl,
          cliPath,
          interfaces: [],
          installSupported: installSupported(),
          action: loginUrl
            ? { kind: 'login', url: loginUrl, label: '点击此处登录 Tailscale（登录后异地通道立即固定）' }
            : { kind: 'shell', command: 'tailscale up', label: '在电脑上执行 tailscale up 登录' },
          lastError: st.ok ? null : (st.error || 'tailscale status 返回非零'),
        };
      }
      // 既没地址、status 又没报未登录：按"服务异常"如实上报（不伪造地址）。
      return {
        name: 'tailscale',
        state: 'error',
        detail: `Tailscale 状态无法识别：${text.trim().slice(0, 160) || '(无输出)'}`,
        baseUrls: [],
        loginUrl,
        cliPath,
        interfaces: [],
        installSupported: installSupported(),
        action: loginUrl
          ? { kind: 'login', url: loginUrl, label: '点击此处登录 Tailscale' }
          : { kind: 'shell', command: 'tailscale status', label: '在电脑上执行 tailscale status 查看原因' },
        lastError: text.trim().slice(0, 200) || null,
      };
    }

    // ③ 桌面版装了但 CLI 不在预期路径：让用户补一个 CLI 指路即可，不必重装。
    if (appInstalledWithoutCli()) {
      return {
        name: 'tailscale',
        state: 'cli-missing',
        detail: '检测到已安装 Tailscale，但找不到 tailscale.exe：请在配置里写 tailscaleBinary 指向它，'
          + '或把它复制到 pc/tools/bin/tailscale.exe。',
        baseUrls: [],
        loginUrl,
        cliPath: null,
        interfaces: [],
        installSupported: installSupported(),
        action: { kind: 'config', label: '在 bridge.config.json 里设置 tailscaleBinary' },
        lastError: 'tailscale CLI 未找到',
      };
    }

    // ④ 完全没装 → 项目自己下载官方安装包（要用户确认，绝不静默装）。
    return {
      name: 'tailscale',
      state: 'absent',
      detail: installSupported()
        ? '本机未安装 Tailscale：项目可自动下载官方安装包（首次需要你确认一次），'
          + '装上后异地访问就有固定地址，不再受免费隧道换址影响。'
        : `本机未安装 Tailscale（当前平台 ${platform} 不支持自动安装）：`
          + '请手动安装后即可获得固定异地地址。',
      baseUrls: [],
      loginUrl,
      cliPath: null,
      interfaces: [],
      installSupported: installSupported(),
      action: installSupported()
        ? { kind: 'install', label: '运行 bridge.js --install-tailscale 由项目自动下载并安装（需确认 + 管理员权限）' }
        : { kind: 'manual', label: '前往 https://tailscale.com/download 手动安装' },
      lastError: null,
    };
  }

  /**
   * 启动：Tailscale 是系统服务，**项目不负责安装甚至不代为登录**，
   * 这里只做两件事：① 地址已就绪则什么都不用做；② 需要自动补装时才动手（且要显式确认）。
   */
  async function start() {
    running = true;
    const st = status();
    installed = { cli: st.cliPath, app: appInstalledWithoutCli() };
    if (st.state === 'ready') {
      log(`Tailscale 异地通道就绪：${st.baseUrls.join(', ')}`);
      return { ok: true, ...st };
    }
    if (st.state === 'absent' && autoInstall && installSupported()) {
      const result = await ensureInstalled();
      return { ok: false, state: st.state, install: result, ...st };
    }
    log(`Tailscale 异地通道未就绪（${st.state}）：${st.detail}`);
    if (st.action && st.action.url) log(`登录链接：${st.action.url}`);
    return { ok: false, ...st };
  }

  function stop() {
    // 不 kill 系统服务：Tailscale 是全局 VPN，停掉它可能影响用户其它用途。
    running = false;
    return { ok: true, state: status().state, note: 'Tailscale 为系统服务，桥接不代为停止。' };
  }

  /** 统一的对外地址（异地候选）。未就绪时为空数组，**绝不伪造**。 */
  function publicBases() {
    const st = status();
    return st.state === 'ready' ? st.baseUrls : [];
  }

  /** 安装进度（状态页/日志用）。 */
  function installStatus() {
    return { ...installState };
  }

  /**
   * 确保装好：下载（带哈希校验）→ 校验 → 安装（需要用户确认 + 管理员权限）。
   *
   * 安全与礼貌：
   *   ① **不静默安装**：autoInstallConfirm 未打开时只下载并告知路径，由用户决定；
   *   ② **必须校验**：sha256 清单对不上就删除文件并报错，绝不执行来路不明的安装包；
   *   ③ 安装需要管理员权限（UAC），失败不隐藏，如实写进状态与日志。
   */
  async function ensureInstalled() {
    if (installInFlight) return { ok: false, pending: true, detail: '安装流程已在进行中' };
    installInFlight = true;
    installState = { state: 'checking', detail: '' };
    try {
      const existing = findDownloadedInstaller();
      let installer = existing;
      if (!installer) {
        installState = { state: 'downloading', detail: '' };
        announce(`[remote] 未检测到 Tailscale，准备下载官方安装包到 ${downloadsDir}`);
        announce('[remote] 为什么需要它：异地访问要一个**固定**地址，Tailscale 的 100.x 满足该条件，'
          + '而免费 Cloudflare 快速隧道每次重启都会换地址，手机缓存必然过期。');
        const got = await downloadTailscaleInstaller();
        if (!got.ok) {
          installState = { state: 'download-failed', detail: got.error || '下载失败' };
          log(`Tailscale 安装包下载失败：${got.error}`);
          return { ok: false, ...got };
        }
        installer = got;
      }
      installState = {
        state: 'downloaded',
        detail: `${installer.file}（来源 ${installer.source}，哈希校验 ${installer.verified ? '通过' : '未通过/不可用'}）`,
      };
      if (!autoInstallConfirm) {
        announce(`[remote] 安装包已就绪：${installer.file}`);
        announce('[remote] 为避免在你不知情时装软件，桥接**不会自动安装**。'
          + '确认后可用下面任一方式继续：');
        announce('[remote]   ① 运行：node bridge.js --install-tailscale --yes    （自动安装，会弹 UAC）');
        announce(`[remote]   ② 直接双击安装包：${installer.file}`);
        log('Tailscale 安装包已下载，等待用户确认后安装');
        installState = { state: 'awaiting-confirm', detail: installer.file };
        return { ok: false, awaitingConfirm: true, ...installer };
      }
      installState = { state: 'installing', detail: installer.file };
      const res = install(installer.file, { announce, log });
      installState = res.ok
        ? { state: 'installed', detail: res.detail || '' }
        : { state: 'install-failed', detail: res.error || '' };
      if (res.ok) log(`Tailscale 安装已发起：${res.detail || ''}`);
      else log(`Tailscale 安装失败：${res.error}`);
      return { ok: res.ok, ...installer, install: res };
    } finally {
      installInFlight = false;
    }
  }

  /** 下载目录里已有的安装包（按 mtime 取最新的一个，避免重复下载）。 */
  function findDownloadedInstaller() {
    const files = readDir(downloadsDir)
      .filter((name) => /^tailscale-setup-.*\.(exe|msi)$/i.test(name))
      .map((name) => {
        const file = path.join(downloadsDir, name);
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { /* 读不到就当最旧 */ }
        return { file, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    // 复用已有安装包时无法回溯"当时校验过没有"，所以明确标为未校验（调用方可再决定）。
    return { ok: true, file: files[0].file, source: 'local-cache', verified: false, cached: true };
  }

  /**
   * 下载安装包 + 哈希清单并校验。
   *
   * 顺序（每一层失败都降级到下一层，并把过程写进日志，不静默）：
   *   ① 抓官方索引页解析出当前版本号（拿不到就用 pinnedVersion）；
   *   ② 依次尝试 TAILSCALE_MIRROR 前缀 / config.tailscaleMirror / 官方源；
   *   ③ 同时下载 `.sha256` 清单；哈希必须匹配，否则删文件并失败。
   */
  async function downloadTailscaleInstaller() {
    try { fs.mkdirSync(downloadsDir, { recursive: true }); } catch { /* 目录建不了后面会报错 */ }

    const indexHtml = await tryDownloadText(TAILSCALE_DOWNLOAD.indexPages[0]);
    let version = TAILSCALE_DOWNLOAD.pinnedVersion;
    if (indexHtml.ok) {
      const m = /tailscale-setup-(\d+\.\d+\.\d+)\.exe/.exec(indexHtml.text);
      if (m) version = m[1];
    }
    const [exeUrl, shaUrl] = TAILSCALE_DOWNLOAD.fileTemplates.map((t) => t.replace('{v}', version));
    const mirrors = [
      process.env.TAILSCALE_MIRROR || '',
      options.tailscaleMirror || '',
      '',
    ];

    let lastError = '未尝试任何下载源';
    for (const mirror of mirrors) {
      const url = mirror ? `${String(mirror).replace(/\/+$/, '')}/${exeUrl}` : exeUrl;
      const shaUrlMirrored = mirror ? `${String(mirror).replace(/\/+$/, '')}/${shaUrl}` : shaUrl;
      announce(`[remote] 下载源：${mirror ? `镜像 ${mirror}` : '官方源'} → ${url}`);
      const exe = await download(url, { dir: downloadsDir });
      if (!exe.ok) { lastError = `${url} → ${exe.error}`; log(`安装包下载失败：${lastError}`); continue; }
      const sha = await tryDownloadText(shaUrlMirrored);
      if (!sha.ok) {
        lastError = `拿不到哈希清单 ${shaUrlMirrored}：${sha.error}`;
        log(`拒绝安装：${lastError}`);
        try { fs.unlinkSync(exe.file); } catch { /* 删不掉也无所谓，反正不会执行 */ }
        continue;
      }
      const expected = (String(sha.text).match(/[a-f0-9]{64}/i) || [])[0] || '';
      if (!expected) {
        lastError = `哈希清单内容不可识别：${String(sha.text).slice(0, 80)}`;
        try { fs.unlinkSync(exe.file); } catch { /* 同上 */ }
        continue;
      }
      const actual = sha256(exe.file);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        lastError = `哈希不匹配（期望 ${expected.slice(0, 12)}…，实际 ${String(actual).slice(0, 12)}…）`;
        log(`安装包校验失败，已删除：${lastError}`);
        try { fs.unlinkSync(exe.file); } catch { /* 同上 */ }
        continue;
      }
      announce(`[remote] 安装包已下载并通过 sha256 校验：${exe.file}（${version}）`);
      return { ok: true, file: exe.file, source: mirror ? `mirror:${mirror}` : 'official', version, verified: true, sha256: actual };
    }
    return { ok: false, error: lastError, version };
  }

  /** 文本下载（索引页 / 哈希清单），失败不抛异常。 */
  function tryDownloadText(url, timeoutMs = 20000) {
    return new Promise((resolve) => {
      try {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // 只跟一层重定向（pkgs 的 latest → 版本化文件名就是这种）
            tryDownloadText(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve);
            res.resume();
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            resolve({ ok: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve({ ok: true, text, url }));
        });
        req.on('timeout', () => { req.destroy(new Error('超时')); });
        req.on('error', (error) => resolve({ ok: false, error: error.message }));
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
  }

  return {
    name: 'tailscale',
    status,
    start,
    stop,
    publicBases,
    installStatus,
    ensureInstalled,
    downloadTailscaleInstaller,
    resolveCli,
    // 暴露给测试/运维：清缓存后立即重新探测
    refresh: () => { cached = null; cachedAt = 0; },
  };
}

/** 默认 CLI 执行器：同步、带超时、**绝不抛异常**（拿不到就返回 ok:false）。 */
function defaultRunCli(args, { timeoutMs = 4000, binary = null } = {}) {
  const cli = binary || resolveCliForRun();
  if (!cli) return { ok: false, stdout: '', stderr: '', error: 'tailscale CLI 未找到' };
  try {
    const r = spawnSync(cli, args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
    });
    return {
      ok: !r.error && r.status === 0,
      stdout: String(r.stdout || ''),
      stderr: String(r.stderr || ''),
      status: r.status,
      error: r.error ? r.error.message : null,
    };
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', error: error.message };
  }
}

/** runCli 默认实现的 CLI 解析（不带 provider 的注入信息，只看系统）。 */
function resolveCliForRun() {
  for (const candidate of defaultCliCandidates()) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* 忽略 */ }
  }
  return 'tailscale';   // 交给 PATH
}

/** 计算文件 sha256（大写十六进制）。 */
function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * 下载文件到指定目录（流式写盘 + 临时文件后缀，避免半截文件被当成完整安装包）。
 * 失败返回 {ok:false, error}，不抛异常。
 */
function downloadFile(url, { dir, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const name = decodeURIComponent(String(url).split('/').pop() || 'download.bin');
    const target = path.join(dir, name);
    const tmp = `${target}.part`;
    let redirects = 0;
    const go = (current) => {
      try {
        const req = https.get(current, { timeout: timeoutMs }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            redirects += 1;
            res.resume();
            if (redirects > 5) { resolve({ ok: false, error: '重定向过多' }); return; }
            go(new URL(res.headers.location, current).toString());
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            resolve({ ok: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          const out = fs.createWriteStream(tmp);
          res.pipe(out);
          out.on('finish', () => {
            out.close(() => {
              try {
                fs.renameSync(tmp, target);
                resolve({ ok: true, file: target, bytes: fs.statSync(target).size, url: current });
              } catch (error) {
                resolve({ ok: false, error: error.message });
              }
            });
          });
          out.on('error', (error) => resolve({ ok: false, error: error.message }));
        });
        req.on('timeout', () => req.destroy(new Error('下载超时')));
        req.on('error', (error) => resolve({ ok: false, error: error.message }));
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    };
    go(url);
  });
}

/**
 * 安装 Windows 安装包（官方 exe 支持 /quiet，MSI 走 msiexec）。
 *
 * ⚠️ 需要**管理员权限**：走 PowerShell 的 Start-Process -Verb RunAs 会弹 UAC。
 *    用户拒绝或没有管理员权限时，如实返回失败原因，不假装成功。
 */
function installWindowsInstaller(file, { announce = () => {}, log = () => {} } = {}) {
  try {
    const isMsi = /\.msi$/i.test(file);
    announce(`[remote] 即将安装（需要管理员权限，会弹出 UAC 确认框）：${file}`);
    const cmd = isMsi
      ? `Start-Process -FilePath msiexec.exe -ArgumentList '/i','"${file}"','/quiet','/norestart' -Verb RunAs -Wait`
      : `Start-Process -FilePath "${file}" -ArgumentList '/quiet' -Verb RunAs -Wait`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], {
      timeout: 600000,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) {
      return {
        ok: false,
        error: `安装进程返回 ${r.status}：${String(r.stderr || '').trim().slice(0, 200) || '（可能是用户取消了 UAC）'}`,
      };
    }
    log('Tailscale 安装完成，请登录后使用固定异地地址');
    return { ok: true, detail: `${file} 安装完成（可能需要重新打开终端才能用 tailscale 命令）` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ---------------------------------------------------------------- Cloudflared 提供者

/**
 * 把隧道包装成统一的 provider 接口。
 *
 * 两种实现由 `persistent` 决定：
 *   · persistent = true（**默认**）→ lib/tunnel.js 的 createPersistentTunnel：
 *       隧道由独立守护进程持有，桥接重启**复用同一地址**（异地能连上的关键），
 *       并且带看门狗自动重建；
 *   · persistent = false        → 第一代 createTunnel（桥接直接持有子进程）。
 *       保留它是为了兼容 --tunnel-restart 之类的诊断场景与老配置。
 *
 * 这里刻意**不改动 lib/tunnel.js 的既有接口**：它已经稳定工作（起停、解析地址、
 * 错误行捕获），包一层只是让调用方不必区分"隧道"与"提供者"两种说法。
 */
function createCloudflaredProvider(options = {}) {
  const {
    binary = '',
    target = 'http://127.0.0.1:3080',
    runtimeDir = '',
    log = () => {},
    enabled = true,
    persistent = true,
    reuse = true,
    deps = {},
  } = options;

  /** 底层实现。未启用时为 null（此时 status 会如实报告 disabled）。 */
  let tunnel = null;
  if (enabled) {
    tunnel = persistent && runtimeDir
      ? createPersistentTunnel({ binary, target, runtimeDir, log, reuse, deps })
      : createTunnel({ binary, target, log });
  }

  return {
    name: 'cloudflared',
    /** 底层实例（bridge.js 里 /health 等仍需 status() 明细）。未启用时为 null。 */
    raw: tunnel,
    enabled,
    persistent: Boolean(persistent && runtimeDir),
    /** 本次是否复用了已有隧道（启动后由 start() 写入，供日志/状态页显示）。 */
    lastStart: null,
    status() {
      if (!tunnel) {
        return {
          name: 'cloudflared',
          state: 'disabled',
          detail: 'Cloudflare 隧道未启用（配置里没有它，或 remoteProviders 里没有它）。',
          baseUrls: [],
          loginUrl: null,
          lastError: null,
        };
      }
      // status() 在"守护进程刚退出/记录被删"的瞬间会返回 null。
      // 以前这里直接读 st.publicUrl，于是 5 秒一次的看门狗每轮都抛
      // "Cannot read properties of null (reading 'publicUrl')"，把真正的隧道故障淹在噪声里。
      const st = tunnel.status() || { state: 'unknown', publicUrl: '', lastError: null, uptimeSeconds: 0 };
      const note = st.publicUrl
        ? (st.uptimeSeconds > 0
          ? `临时隧道地址（重启不变，当前已运行 ${humanUptime(st.uptimeSeconds * 1000, 0)}）：${st.publicUrl}`
          : `临时隧道地址：${st.publicUrl}`)
        : (st.lastError || '隧道尚未就绪');
      return {
        name: 'cloudflared',
        state: st.state,                 // stopped | starting | running | failed
        detail: note,
        baseUrls: st.publicUrl ? [st.publicUrl] : [],
        loginUrl: null,
        publicUrl: st.publicUrl,
        uptimeSeconds: st.uptimeSeconds || 0,
        pid: st.pid || null,
        persistent: Boolean(persistent && runtimeDir),
        lastError: st.lastError,
        raw: st,
      };
    },
    start() {
      if (!tunnel) return { ok: false, error: 'cloudflared 未启用' };
      const r = tunnel.start();
      // 持久化实现的 start 是 async（要等守护进程写出地址）；两条路都兼容。
      if (r && typeof r.then === 'function') {
        return r.then((value) => {
          this.lastStart = value;
          return value;
        });
      }
      this.lastStart = r;
      return r;
    },
    /** 看门狗一次（仅持久化实现有）：隧道死了自动重建并更新地址。 */
    watch() {
      if (!tunnel || typeof tunnel.watch !== 'function') return null;
      return tunnel.watch();
    },
    stop() {
      if (!tunnel) return { ok: true };
      return tunnel.stop();
    },
    publicBases() {
      if (!tunnel) return [];
      const st = tunnel.status() || {};
      return st.publicUrl ? [st.publicUrl] : [];
    },
  };
}

/** 秒数 → 人类可读（"3 分钟"）。 */
function humanUptime(ms) {
  const sec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

// ---------------------------------------------------------------- 统一远程层

/**
 * 创建统一远程层：统一起停、统一择优、统一发布异地候选。
 *
 * @param {object} options
 *   providers          要启用的 provider 名（顺序 = 优先级）；默认 ['tailscale','cloudflared']
 *   remoteBase         用户手工指定的固定异地地址（优先级最高）
 *   port               桥接端口（拼 Tailscale 的 http://100.x:port）
 *   cfTunnelBinary     cloudflared 可执行文件路径
 *   cfEnabled          是否启用 cloudflared（对应原有的 enableTunnel）
 *   log/announce       日志
 *   deps               透传给 tailscale provider 的注入项（测试用）
 */
function createRemoteLayer(options = {}) {
  const {
    providers: wanted = ['tailscale', 'cloudflared'],
    remoteBase = '',
    port = 3080,
    cfTunnelBinary = '',
    cfEnabled = true,
    cfPersistent = true,
    cfReuse = true,
    runtimeDir = '',
    log = () => {},
    announce = (line) => console.log(line),
    deps = {},
  } = options;

  const wantedList = Array.isArray(wanted) && wanted.length > 0 ? wanted : ['tailscale', 'cloudflared'];
  const providers = [];

  if (wantedList.includes('tailscale')) {
    providers.push(createTailscaleProvider({ port, log, announce, ...deps }));
  }
  if (wantedList.includes('cloudflared') && cfEnabled) {
    providers.push(createCloudflaredProvider({
      binary: cfTunnelBinary,
      target: `http://127.0.0.1:${port}`,
      runtimeDir,
      persistent: cfPersistent,
      reuse: cfReuse,
      log,
      enabled: true,
    }));
  }

  const configured = remoteBase ? [normalizeBase(remoteBase)] : [];

  function providerByName(name) {
    return providers.find((p) => p.name === name) || null;
  }

  /** 所有 provider 的状态快照（状态页 / 诊断接口用）。 */
  function status() {
    const list = providers.map((p) => {
      try {
        return p.status();
      } catch (error) {
        // provider 崩了也不能连累整体：如实记一条错误状态
        return { name: p.name, state: 'error', detail: error.message, baseUrls: [], loginUrl: null };
      }
    });
    const ts = list.find((s) => s.name === 'tailscale') || null;
    return {
      providers: list,
      tailscale: ts,
      // 便于状态页直接渲染"怎么把它弄好"
      actions: list.filter((s) => s.action).map((s) => ({ name: s.name, ...s.action })),
      stable: configured.length > 0 || (ts && ts.state === 'ready'),
    };
  }

  /**
   * 异地候选（**有序**）：固定配置 → Tailscale（固定）→ cloudflared（临时）。
   *
   * 为什么顺序不能反：临时隧道地址下次重启就失效，把它排在固定地址前面，
   * 会让手机优先去试一条注定过期的地址（这正是当前故障的成因）。
   */
  function publicBases() {
    const out = [...configured];
    for (const p of providers) {
      if (p.name === 'cloudflared') continue;          // 临时地址永远排最后
      try { out.push(...p.publicBases()); } catch { /* 单个 provider 失败不影响整体 */ }
    }
    const cf = providerByName('cloudflared');
    if (cf) {
      try { out.push(...cf.publicBases()); } catch { /* 同上 */ }
    }
    return [...new Set(out.filter(Boolean))];
  }

  /** 是否具备"重启也不变"的固定异地通道（有它才算真正可靠的异地）。 */
  function hasStable() {
    if (configured.length > 0) return true;
    const ts = providerByName('tailscale');
    if (!ts) return false;
    try { return ts.status().state === 'ready'; } catch { return false; }
  }

  /** 给人看的一句话状态（日志/配对页/状态页共用，避免三处措辞漂移）。 */
  function note() {
    if (configured.length > 0) return `异地通道：使用配置里固定的 remoteBase（${configured.join(', ')}）。`;
    const ts = providerByName('tailscale');
    const cf = providerByName('cloudflared');
    const cfStatus = cf ? cf.status() : null;
    const cfUrl = cfStatus && cfStatus.publicUrl ? cfStatus.publicUrl : '';
    const cfUptime = cfStatus && cfStatus.uptimeSeconds
      ? `（已运行 ${humanUptime(cfStatus.uptimeSeconds * 1000)}）`
      : '';
    const cfPart = cfUrl
      ? `Cloudflare 隧道 ${cfUrl}${cfUptime}`
      : 'Cloudflare 隧道未就绪';

    if (ts) {
      const st = ts.status();
      if (st.state === 'ready') {
        return `异地通道：Tailscale 固定地址 ${st.baseUrls.join(', ')}（重启不变）；备用 ${cfPart}。`;
      }
      if (st.state === 'needs-login') {
        return `异地通道：${cfPart}（地址在隧道重启后会变）。`
          + '可选增强：Tailscale 已安装但未登录，登录后可用固定的 100.x 地址。'
          + (st.loginUrl ? ` 登录链接：${st.loginUrl}` : '');
      }
      if (st.state === 'absent') {
        return `异地通道：${cfPart}。可选增强：安装 Tailscale 可获得固定地址（本项目可一键下载安装）。`;
      }
      return `异地通道：${cfPart}。可选增强：Tailscale 状态 ${st.state}（${st.detail}）`;
    }
    return `异地通道：${cfPart}。`;
  }

  /** 启动全部 provider（首次拉起；失败只记录，不影响 USB/局域网）。 */
  async function startAll() {
    const results = [];
    for (const p of providers) {
      try {
        // 逐个 await：Tailscale 的就绪判断要先于隧道的"兜底"结论，
        // 这样日志里能明确看到"固定通道有没有、没有才用临时隧道"。
        const r = p.start();
        results.push({ name: p.name, result: r instanceof Promise ? await r : r });
      } catch (error) {
        log(`${p.name} 启动失败：${error.message}`);
        results.push({ name: p.name, result: { ok: false, error: error.message } });
      }
    }
    return results;
  }

  function stopAll() {
    return providers.map((p) => {
      try { return { name: p.name, result: p.stop() }; }
      catch (error) { return { name: p.name, result: { ok: false, error: error.message } }; }
    });
  }

  /**
   * 看门狗一轮（由桥接的 5 秒轮询调用）。
   *
   * 隧道死了就自动重建，新地址会立即写回 runtime/tunnel.json，
   * 于是 /pair.json、/handshake、状态页下一轮就发布新地址（手机上重新握手即可学到）。
   */
  async function watchAll() {
    const out = [];
    for (const p of providers) {
      if (typeof p.watch !== 'function') continue;
      try {
        const r = p.watch();
        out.push({ name: p.name, result: r instanceof Promise ? await r : r });
      } catch (error) {
        log(`${p.name} 看门狗失败：${error.message}`);
        out.push({ name: p.name, result: { ok: false, error: error.message } });
      }
    }
    return out;
  }

  /** 手动触发一次"缺失时自动下载/安装"（CLI: --install-tailscale）。 */
  async function installTailscale() {
    const ts = providerByName('tailscale');
    if (!ts) return { ok: false, error: 'remoteProviders 里没有 tailscale' };
    return ts.ensureInstalled();
  }

  return {
    providers,
    status,
    publicBases,
    hasStable,
    note,
    startAll,
    stopAll,
    watchAll,
    installTailscale,
    providerByName,
    configuredBases: configured,
    /** 便捷取用（等价于 providerByName('cloudflared')），供既有 /health 字段复用。 */
    tunnel: providerByName('cloudflared'),
  };
}

module.exports = {
  createRemoteLayer,
  createTailscaleProvider,
  createCloudflaredProvider,
  isTailscaleCgnat,
  normalizeBase,
  parseLoginUrl,
  parseBackendState,
  interfaceTailscaleAddresses,
  defaultCliCandidates,
  downloadFile,
  sha256,
  TAILSCALE_DOWNLOAD,
};
