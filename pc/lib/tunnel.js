// SPDX-License-Identifier: Apache-2.0
/**
 * Cloudflare Tunnel 集成：把本机桥接暴露到公网，供手机在异地访问。
 *
 * 为什么是这条路：
 *   1. PC 在 NAT 后没有公网入口，手机无法直连；
 *   2. 手机端要求「不装额外 App」——Tailscale 之类都需要手机装客户端，只能作为可选增强；
 *   3. 只有「PC 侧主动出站建立隧道、由云端回程」这一条路满足上述约束，
 *      而且 cloudflared 由**本项目自带**（tools/bin/cloudflared.exe），不需要账号、不需要用户安装。
 *
 * 采用 Quick Tunnel（trycloudflare.com）：无需 Cloudflare 账号、无需域名、
 * 无需备案即可拿到一个临时 HTTPS 地址。
 *
 * ⚠️ 本文件现在有**两代实现**，共存是刻意的：
 *   · createTunnel()            —— 第一代：桥接直接持有 cloudflared 子进程。
 *                                  退出/重启桥接就把隧道一起带走，地址随之改变
 *                                  （实测一小时内变过 4 次 → App 缓存的异地地址必然过期）。
 *   · createPersistentTunnel()  —— 第二代（**默认使用**）：把 cloudflared 交给一个
 *                                  **脱离桥接进程**的守护进程持有，并落盘 pid/地址/启动时间，
 *                                  于是桥接重启时能复用同一条隧道，**地址不再变化**。
 *                                  另外带看门狗：隧道死了自动重建并更新地址。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

/** 从 cloudflared 的输出里提取公网地址。 */
function extractPublicUrl(text) {
  const m = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

function createTunnel(options) {
  const {
    binary,
    target = 'http://127.0.0.1:3080',
    log = () => {},
  } = options;

  let proc = null;
  let publicUrl = null;
  let state = 'stopped';   // stopped | starting | running | failed
  let lastError = null;
  let startedAt = 0;

  function handleOutput(chunk) {
    const text = chunk.toString();
    // cloudflared 把地址打在 stderr 上，且带 ANSI 颜色码
    const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
    const found = extractPublicUrl(clean);
    if (found && found !== publicUrl) {
      publicUrl = found;
      state = 'running';
      log(`隧道已就绪: ${publicUrl}`);
    }
    // 记录明显的错误行，便于排查
    const errLine = clean.split('\n').find((l) => /ERR|error|failed/i.test(l));
    if (errLine && !publicUrl) lastError = errLine.trim().slice(0, 200);
  }

  function start() {
    if (proc) return { ok: true, state, publicUrl };
    if (!binary) {
      state = 'failed';
      lastError = '未找到 cloudflared 可执行文件';
      return { ok: false, error: lastError };
    }
    state = 'starting';
    startedAt = Date.now();
    lastError = null;
    try {
      proc = spawn(binary, [
        'tunnel',
        '--no-autoupdate',
        '--url', target,
      ], { windowsHide: true });

      proc.stdout.on('data', handleOutput);
      proc.stderr.on('data', handleOutput);

      proc.on('error', (err) => {
        state = 'failed';
        lastError = err.message;
        proc = null;
        log(`隧道启动失败: ${err.message}`);
      });

      proc.on('exit', (code) => {
        log(`隧道进程退出，code=${code}`);
        proc = null;
        publicUrl = null;
        state = code === 0 ? 'stopped' : 'failed';
      });

      log(`正在建立隧道 → ${target}`);
      return { ok: true, state, publicUrl };
    } catch (err) {
      state = 'failed';
      lastError = err.message;
      log(`隧道异常: ${err.message}`);
      return { ok: false, error: lastError };
    }
  }

  function stop() {
    if (!proc) {
      state = 'stopped';
      publicUrl = null;
      return { ok: true };
    }
    try { proc.kill(); } catch (e) { /* 忽略 */ }
    proc = null;
    publicUrl = null;
    state = 'stopped';
    log('隧道已停止');
    return { ok: true };
  }

  function status() {
    return {
      state,
      publicUrl,
      lastError,
      uptimeSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    };
  }

  return { start, stop, status, extractPublicUrl };
}

// ================================================================ 第二代：持久化隧道
//
// 设计要点（每一条都对应一个真实故障）：
//   ① 隧道归**独立的守护进程**所有（pc/lib/cloudflared-supervisor.js），它 `detached` 启动、
//      与桥接没有父子关系。桥接重启不会连带杀死它 —— 这是"地址不变"的前提。
//      为什么不能让桥接自己持有并只是"退出时不杀"：Windows 上子进程会随父进程控制台一起死，
//      孤儿 cloudflared 也无人解析/落盘新地址。守护进程把这件事变确定。
//   ② 一切状态都落盘到 pc/runtime/tunnel.json（pid / publicUrl / startedAt / logFile / specFile），
//      于是**新启动的桥接能读到旧隧道的地址**并直接复用。
//   ③ 复用前必须双重校验：进程活着（pid 存在且进程名匹配）+ 地址真的可用（GET /health 200）。
//      只看 pid 会踩 "pid 被系统复用" 的坑；只看地址会踩 "地址被 Cloudflare 回收" 的坑。
//   ④ 看门狗：隧道进程死了自动重建，新地址立刻写回记录，桥接下一轮就读到新地址
//      （桥接侧会把它发布到 /pair.json、/handshake、状态页）。

/** 守护进程脚本路径。 */
const SUPERVISOR_SCRIPT = path.join(__dirname, 'cloudflared-supervisor.js');

/**
 * 判断进程是否活着，并（Windows 上）确认它的映像名是不是 cloudflared。
 *
 * 为什么要看名字：pid 会被系统复用。若只判断"pid 存在"，一个碰巧复用了该 pid 的
 * 无关进程会让桥接误以为隧道还活着，于是复用一条早已不存在的地址 —— 用户表现为
 * "异地连不上，而且电脑上看起来一切正常"。
 */
function isProcessAlive(pid, expectName = 'cloudflared') {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    process.kill(id, 0);            // 信号 0 = 只探测存在性，不真发信号
  } catch (error) {
    // EPERM = 进程存在但没权限发信号（极少见）→ 也算活着
    return error && error.code === 'EPERM';
  }
  if (process.platform !== 'win32' || !expectName) return true;
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${id}`, '/FO', 'CSV', '/NH'], {
      timeout: 4000,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (r.error || r.status !== 0) return true;     // 查不到就按"活着"处理（保守）
    const text = String(r.stdout || '');
    if (/no tasks are running|没有运行的任务/i.test(text)) return false;
    return new RegExp(expectName, 'i').test(text);
  } catch {
    return true;
  }
}

/** 读 JSON（失败返回 null，不抛）。 */
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 写 JSON（临时文件 + rename，避免桥接读到写了一半的内容）。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** GET 一个地址并返回状态码（用于校验隧道确实可用）。失败返回 null。 */
function httpStatus(url, timeoutMs = 5000, https = null) {
  const mod = https || require('node:https');
  return new Promise((resolve) => {
    try {
      const req = mod.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      });
      req.on('timeout', () => { req.destroy(new Error('超时')); });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * 创建持久化隧道管理器。
 *
 * @param {object} options
 *   binary         cloudflared 可执行文件
 *   target         隧道指向（http://127.0.0.1:<bridgePort>）
 *   runtimeDir     记录文件目录（pc/runtime）
 *   logFile        守护进程/cloudflared 的日志文件
 *   reuse          是否复用已有隧道（对应 --tunnel-reuse，默认 true）
 *   log            日志函数
 *   deps           注入项（测试用）：isAlive / httpStatus / spawnSupervisor / readRecord / now / sleep
 */
function createPersistentTunnel(options = {}) {
  const {
    binary,
    target = 'http://127.0.0.1:3080',
    runtimeDir,
    log = () => {},
    reuse = true,
    deps = {},
  } = options;

  const recordFile = path.join(runtimeDir, 'tunnel.json');
  const specFile = path.join(runtimeDir, 'tunnel-supervisor.json');
  const logFile = options.logFile || path.join(runtimeDir, 'cloudflared.log');
  const pidFile = path.join(runtimeDir, 'cloudflared.pid');

  const isAlive = deps.isAlive || isProcessAlive;
  // 健康检查的实测统计：给"参数打分器"（lib/tuner.js）当输入。
  // 只统计**真实发生**的检查，不做任何推测；样本不足时 tuner 会退回到按链路的基线值。
  let healthOk = 0;
  let healthFail = 0;
  let lastRttMs = null;
  let lastHealthAt = 0;

  const checkUrl = deps.httpStatus || ((url) => httpStatus(url, 5000, require('node:https')));
  const readRecord = deps.readRecord || (() => readJsonSafe(recordFile));
  const writeRecord = deps.writeRecord || ((value) => writeJsonAtomic(recordFile, value));
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const spawnSupervisor = deps.spawnSupervisor || defaultSpawnSupervisor;

  /** 本进程内已确认的隧道信息（避免每 5 秒轮询都读盘）。 */
  let cached = null;
  let lastAnnouncedUrl = null;
  // 重建冷却：Cloudflare 对快速隧道限流（HTTP 429 / error 1015）时，
  // 每 5 秒重建一次只会让限流持续更久（实测踩过：越重试越久建不起来）。
  let retryAt = 0;
  let retryDelayMs = 30000;
  const RETRY_MAX_MS = 300000;

  /** 当前记录（磁盘为准）。 */
  function record() {
    return readRecord();
  }

  /** 记录里的隧道是否"确实还在服务"（进程活着 + 地址可用）。 */
  async function recordHealthy(rec) {
    if (!rec || !rec.pid || !rec.publicUrl) return { ok: false, reason: '记录不完整' };
    if (!isAlive(rec.pid, 'cloudflared')) return { ok: false, reason: `进程 ${rec.pid} 已不存在` };
    const t0 = now();
    const code = await checkUrl(`${rec.publicUrl}/health`);
    // 记录实测往返与成败：这是 tuner 唯一可信的输入来源。
    lastRttMs = now() - t0;
    lastHealthAt = now();
    if (code === 200) healthOk += 1; else healthFail += 1;
    if (code !== 200) return { ok: false, reason: `地址不可用（HTTP ${code === null ? '不可达' : code}）` };
    return { ok: true };
  }

  /** 秒 → "x 分 y 秒"（日志里让人一眼看出隧道活了多久）。 */
  function humanUptime(startedAt) {
    const sec = Math.max(0, Math.round((now() - Number(startedAt || 0)) / 1000));
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟`;
    const hour = Math.floor(min / 60);
    return `${hour} 小时 ${min % 60} 分钟`;
  }

  /** 拉起守护进程（detached：与桥接无父子关系，桥接退出不会带走它）。 */
  function startSupervisor(extra = {}) {
    const spec = {
      binary,
      target,
      runtimeDir,
      recordFile,
      logFile,
      pidFile,
      createdAt: now(),
      ...extra,
    };
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
    } catch { /* 目录问题下面会暴露 */ }
    writeJsonAtomic(specFile, spec);
    return spawnSupervisor({ script: SUPERVISOR_SCRIPT, specFile, logFile, log });
  }

  /** 默认的守护进程启动方式：node supervisor.js，stdio 直接落文件（不用管道，跨沙箱更稳）。 */
  function defaultSpawnSupervisor({ script, specFile, logFile, log: logFn }) {
    try {
      let out = 'ignore';
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        out = fs.openSync(logFile, 'a');
      } catch { /* 打不开就丢弃输出 */ }
      const child = spawn(process.execPath, [script, specFile], {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', out, out],
      });
      child.unref();
      logFn(`已拉起隧道守护进程 pid=${child.pid}（与桥接进程解耦，桥接重启不会换地址）`);
      return { ok: true, pid: child.pid };
    } catch (error) {
      logFn(`拉起隧道守护进程失败：${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  /**
   * 确保有一条可用隧道：
   *   ① reuse=true 且记录健康 → **复用**（日志写明"复用已存在的隧道 … 已运行 x 分钟"）；
   *   ② 否则拉起守护进程新建（守护进程自己也会再校验一次，避免两个桥接同时起两条隧道）。
   * 返回 {ok, reused, publicUrl, reason, uptimeSeconds}
   */
  /**
   * 单飞闸门：桥接的启动流程、/health、5 秒轮询都会调用 start()，
   * 并发进来时必须共用同一次启动 —— 否则每处都会拉一个守护进程，
   * 结果就是多条隧道、多个地址（实测出现过 3 个）。
   */
  let startInFlight = null;
  function start() {
    if (startInFlight) return startInFlight;
    startInFlight = doStart().finally(() => { startInFlight = null; });
    return startInFlight;
  }

  async function doStart() {
    // ① 先看有没有可以复用的
    if (reuse) {
      const rec = record();
      const health = await recordHealthy(rec);
      if (health.ok) {
        cached = rec;
        const mins = humanUptime(rec.startedAt);
        if (lastAnnouncedUrl !== rec.publicUrl) {
          log(`复用已存在的隧道 ${rec.publicUrl}（已运行 ${mins}，pid=${rec.pid}）`);
          lastAnnouncedUrl = rec.publicUrl;
        } else {
          log(`隧道仍在服务：${rec.publicUrl}（已运行 ${mins}）`);
        }
        return {
          ok: true,
          reused: true,
          publicUrl: rec.publicUrl,
          pid: rec.pid,
          uptimeSeconds: Math.round((now() - Number(rec.startedAt || 0)) / 1000),
          reason: `复用（${mins}）`,
        };
      }
      if (rec) log(`未复用已有隧道记录：${health.reason} → 将新建隧道`);
      else log('没有隧道记录 → 将新建隧道');
    } else {
      log('--tunnel-restart：忽略已有隧道，强制新建');
    }

    // ② 新建：交给守护进程
    const spawned = startSupervisor();
    if (!spawned.ok) return { ok: false, error: spawned.error };

    // ③ 等守护进程把地址写出来（cloudflared 首次握手一般 1~5 秒）
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      const rec = record();
      if (rec && rec.publicUrl && rec.pid) {
        cached = rec;
        if (lastAnnouncedUrl !== rec.publicUrl) {
          log(`新建隧道完成：${rec.publicUrl}（pid=${rec.pid}）`);
          lastAnnouncedUrl = rec.publicUrl;
        }
        return { ok: true, reused: false, publicUrl: rec.publicUrl, pid: rec.pid, reason: '新建' };
      }
    }
    const rec = record();
    return {
      ok: false,
      error: `等待隧道地址超时（20 秒）；守护进程日志：${logFile}`,
      lastRecord: rec || null,
    };
  }

  /**
   * 看门狗：每次调用检查一次「记录是否还健康 + 地址是否变化」。
   * 桥接的 5 秒轮询会调用它，于是隧道一死就会被重建，新地址立刻被发布出去。
   */
  async function watch() {
    if (now() < retryAt) {
      return { ok: false, coolingDown: true, retryInMs: retryAt - now() };
    }
    const rec = record();
      // ⚠️ 必须**先**判空：record() 在记录文件刚被删/尚未建立时返回 null，
      // 而下面第一句就读 rec.publicUrl —— 以前这里每轮抛
      // "Cannot read properties of null (reading 'publicUrl')"，看门狗等于没在跑。
      if (!rec) {
        retryAt = now() + retryDelayMs;
        retryDelayMs = Math.min(RETRY_MAX_MS, retryDelayMs * 2);
        log('看门狗：没有隧道记录，重新建立');
        return start();
      }
      // ⚠️ 关键：记录里"有 pid 但还没有地址"= 隧道**正在建立**，必须等它，绝不能重建。
      // 踩过的坑：此前这一状态被判成"记录不完整 → 重建"，而新隧道要几秒才拿到地址，
      // 于是每 5 秒重建一次 —— cloudflared 越堆越多、地址永远对不上，
      // 用户看到的就是"异地连不上 / 时好时坏"（HTTP 530）。
      if (!rec.publicUrl) {
        const age = now() - Number(rec.startedAt || 0);
        const aliveNow = isAlive(rec.pid, "cloudflared");
        if (aliveNow && age < 45000) {
          return { ok: true, starting: true, pid: rec.pid, publicUrl: null };
        }
        // 冷却 + 指数退避：限流期间继续重试毫无意义
        retryAt = now() + retryDelayMs;
        retryDelayMs = Math.min(RETRY_MAX_MS, retryDelayMs * 2);
        log("看门狗：隧道记录无地址且进程不健康（alive=" + aliveNow + " age=" + Math.round(age / 1000) + "s），重建");
        try { fs.unlinkSync(recordFile); } catch { /* 忽略 */ }
        return start();
      }
    if (!rec || !rec.pid) {
      // 冷却 + 指数退避：限流期间继续重试毫无意义
      retryAt = now() + retryDelayMs;
      retryDelayMs = Math.min(RETRY_MAX_MS, retryDelayMs * 2);
      log('看门狗：没有隧道记录，重新建立');
      return start();
    }
    const health = await recordHealthy(rec);
    if (!health.ok) {
      // 冷却 + 指数退避：限流期间继续重试毫无意义
      retryAt = now() + retryDelayMs;
      retryDelayMs = Math.min(RETRY_MAX_MS, retryDelayMs * 2);
      log(`看门狗：隧道不可用（${health.reason}），自动重建`);
      // 清理掉失效记录，避免下次又拿它去复用（守护进程也会自己重建）
      try { fs.unlinkSync(recordFile); } catch { /* 删不掉也无妨 */ }
      lastAnnouncedUrl = null;
      return start();
    }
    if (cached && rec.publicUrl !== cached.publicUrl) {
      // 地址变了：**高亮**一行日志，这是排查"异地连不上"最关键的一条线索
      log(`⚠️ 隧道地址已变化：${cached.publicUrl} → ${rec.publicUrl}（重启/回收后 Cloudflare 会换域名）`);
      lastAnnouncedUrl = rec.publicUrl;
    }
    cached = rec;
    return { ok: true, publicUrl: rec.publicUrl, pid: rec.pid, reused: true };
    retryDelayMs = 30000;   // 成功 → 冷却复位
  }

  /** 状态（发布给手机/状态页用；地址**实时**读盘，绝不用启动快照）。 */
  function status() {
    const rec = record();
    if (!rec || !rec.pid || !rec.publicUrl) {
      return {
        // 供 tuner 使用的实测健康度（样本为 0 时不伪造）
        health: {
          rttMs: lastRttMs,
          samples: healthOk + healthFail,
          failRate: (healthOk + healthFail) > 0 ? healthFail / (healthOk + healthFail) : 0,
          lastAt: lastHealthAt,
        },
        state: 'starting',
        publicUrl: null,
        lastError: rec && rec.lastError ? rec.lastError : null,
        uptimeSeconds: 0,
        pid: null,
        logFile,
        recordFile,
      };
    }
    return {
      state: 'running',
      publicUrl: rec.publicUrl,
      lastError: rec.lastError || null,
      startedAt: rec.startedAt,
      uptimeSeconds: Math.round((now() - Number(rec.startedAt || 0)) / 1000),
      pid: rec.pid,
      logFile,
      recordFile,
    };
  }

  /** 停止隧道（只在显式要求时调用，例如 --tunnel-stop）。 */
  function stop() {
    const rec = record();
    if (!rec || !rec.pid) {
      return { ok: true, note: '没有正在运行的隧道' };
    }
    try {
      process.kill(rec.pid);
      log(`已停止隧道进程 pid=${rec.pid}（地址 ${rec.publicUrl} 随之失效）`);
    } catch (error) {
      log(`停止隧道进程失败：${error.message}`);
    }
    try { fs.unlinkSync(recordFile); } catch { /* 忽略 */ }
    cached = null;
    return { ok: true };
  }

  return {
    start,
    watch,
    stop,
    status,
    record,
    recordHealthy,
    isAlive,
    recordFile,
    logFile,
    specFile,
    /** 显式读取"是否复用"的开关，便于状态页显示策略。 */
    reuse,
  };
}

module.exports = {
  createTunnel,
  extractPublicUrl,
  createPersistentTunnel,
  isProcessAlive,
  humanUptime: (startedAt, nowMs = Date.now()) => {
    const sec = Math.max(0, Math.round((nowMs - Number(startedAt || 0)) / 1000));
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟`;
    return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
  },
  SUPERVISOR_SCRIPT,
};
