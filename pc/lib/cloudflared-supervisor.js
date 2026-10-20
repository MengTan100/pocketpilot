// SPDX-License-Identifier: MIT
'use strict';
/**
 * cloudflared-supervisor.js —— 隧道守护进程（**独立于桥接进程**）。
 *
 * 存在意义（对应真实故障）：
 *   第一代实现里 cloudflared 是桥接的**子进程**，桥接一重启隧道就跟着重启，
 *   而 Cloudflare 快速隧道的域名**只在隧道进程重启时变化** —— 于是每次重启桥接
 *   都会拿到一个新地址（实测一小时内变过 4 次），手机缓存的异地地址必然过期，
 *   "异地永远连不上"就是这么来的。
 *
 * 本守护进程的做法：
 *   1) 由桥接以 detached 方式拉起，**与桥接没有父子关系** → 桥接退出/重启它照常活着；
 *   2) cloudflared 的输出**直接写日志文件**（不用管道），跨沙箱/无控制台环境更稳；
 *   3) 解析出公网地址后落盘到 runtime/tunnel.json（pid + publicUrl + startedAt），
 *      桥接重启时读它即可**复用同一条隧道**，地址保持不变；
 *   4) 自己也是看门狗：cloudflared 退出就重建，并把新地址写回记录。
 *
 * 用法：node cloudflared-supervisor.js <spec.json>
 *   spec.json = { binary, target, runtimeDir, recordFile, logFile, pidFile, createdAt }
 *
 * 退出：收到 SIGTERM/SIGINT 时结束 cloudflared 并删除记录（桥接的 --tunnel-stop 走这条路）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const specFile = process.argv[2];
if (!specFile) {
  console.error('[supervisor] 缺少 spec 文件参数');
  process.exit(2);
}

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
} catch (error) {
  console.error(`[supervisor] 读取 spec 失败：${error.message}`);
  process.exit(2);
}

const {
  binary,
  target = 'http://127.0.0.1:3080',
  recordFile = path.join(spec.runtimeDir || '.', 'tunnel.json'),
  logFile = path.join(spec.runtimeDir || '.', 'cloudflared.log'),
} = spec;

function appendLog(line) {
  const text = `[${new Date().toISOString()}] [supervisor] ${line}\n`;
  try { fs.appendFileSync(logFile, text, 'utf8'); } catch { /* 日志失败不影响隧道 */ }
}

function writeRecord(value) {
  try {
    const tmp = `${recordFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, recordFile);
  } catch (error) {
    appendLog(`写记录失败：${error.message}`);
  }
}

function readRecord() {
  try { return JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { return null; }
}

/** 从日志文件里提取公网地址（cloudflared 把地址打印在 stderr 上）。 */
function extractUrl(text) {
  const m = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

function alive(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

let child = null;
let publicUrl = null;
let startedAt = Date.now();
let logFd = null;
let stopping = false;

/**
 * 启动 cloudflared。
 *
 * 关键点：stdio 用**文件描述符**而不是 'pipe'。
 *   ① 桥接可能在没有控制台/受限沙箱下运行，管道捕获会失败（EPERM）；
 *   ② 守护进程重启时，我们希望 cloudflared 的日志与地址解析都在**同一个文件**里，
 *      新守护进程读旧日志也能立刻知道地址（多一层保险）。
 */
function launch() {
  if (!binary || !fs.existsSync(binary)) {
    appendLog(`找不到 cloudflared：${binary}`);
    writeRecord({ pid: null, publicUrl: null, startedAt, lastError: `缺少 cloudflared 可执行文件：${binary}`, logFile, target });
    return false;
  }
  try {
    logFd = fs.openSync(logFile, 'a');
  } catch {
    logFd = null;
  }
  const stdio = logFd === null ? 'ignore' : ['ignore', logFd, logFd];
  try {
    child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', target], {
      stdio,
      windowsHide: true,
      detached: false,
    });
  } catch (error) {
    appendLog(`spawn 失败：${error.message}`);
    writeRecord({ pid: null, publicUrl: null, startedAt, lastError: error.message, logFile, target });
    return false;
  }

  startedAt = Date.now();
  // 先落一条"已启动、地址待定"的记录：桥接据此知道隧道正在建立，而不是"没有隧道"。
  writeRecord({
    pid: child.pid,
    publicUrl: null,
    startedAt,
    state: 'starting',
    target,
    binary,
    logFile,
    managedBy: 'dsh-phone-bridge/supervisor',
  });
  appendLog(`已启动 cloudflared pid=${child.pid} → ${target}`);

  child.on('error', (error) => {
    appendLog(`cloudflared 错误：${error.message}`);
    writeRecord({ pid: child ? child.pid : null, publicUrl, startedAt, state: 'failed', lastError: error.message, target, logFile });
  });

  child.on('exit', (code, signal) => {
    appendLog(`cloudflared 退出 code=${code} signal=${signal}`);
    child = null;
    publicUrl = null;
    if (stopping) {
      // 我们主动停的：删掉记录，避免桥接下次误以为还有隧道可复用
      try { fs.unlinkSync(recordFile); } catch { /* 忽略 */ }
      writeRecord({ pid: null, publicUrl: null, startedAt, state: 'stopped', target, logFile });
      return;
    }
    // 意外退出：记录标记为失败，桥接的看门狗会看到并重建
    writeRecord({ pid: null, publicUrl: null, startedAt, state: 'failed', lastError: `cloudflared 退出 code=${code}`, target, logFile });
    // 自己重试一次（守护进程也可能被 Cloudflare 回收连接）
    setTimeout(() => { if (!stopping) launch(); }, 3000).unref();
  });

  return true;
}

/** 轮询日志文件，解析地址（cloudflared 首次拿到域名约 1~5 秒）。 */
function pollUrl() {
  const timer = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(logFile, 'utf8').slice(-65536); } catch { /* 忽略 */ }
    const found = extractUrl(text);
    if (found && found !== publicUrl) {
      publicUrl = found;
      appendLog(`隧道地址就绪：${publicUrl}`);
      writeRecord({
        pid: child ? child.pid : readRecord()?.pid || null,
        publicUrl,
        startedAt,
        state: 'running',
        target,
        binary,
        logFile,
        managedBy: 'dsh-phone-bridge/supervisor',
      });
    }
  }, 700);
  timer.unref?.();
  return timer;
}

/**
 * 启动前先确认"没有别的守护进程已经在提供服务"，避免两条隧道同时存在
 * （两条隧道 = 两个地址 = 又回到"地址飘忽"的老问题）。
 */
(function main() {
  const rec = readRecord();
  if (rec && rec.pid && rec.publicUrl && alive(rec.pid) && Number(rec.pid) !== process.pid) {
    // 已有活着的 cloudflared 且记录里有地址：本进程只做"看门"，不起新隧道。
    appendLog(`检测到已有隧道 pid=${rec.pid} ${rec.publicUrl}，本守护进程只接管看护`);
    publicUrl = rec.publicUrl;
    startedAt = Number(rec.startedAt || Date.now());
    // 立刻从旧日志里再确认一次地址还在（防止记录是陈旧的）
    pollUrl();
    // 只做存活检查：不健康则由桥接的 watch() 走重建流程（避免两个守护互相抢）
    setInterval(() => {
      if (!alive(rec.pid)) {
        appendLog(`已存在的隧道进程 ${rec.pid} 已消失，本守护进程接管并新建`);
        try { fs.unlinkSync(recordFile); } catch { /* 忽略 */ }
        launch();
      }
    }, 5000).unref();
    return;
  }
  launch();
  pollUrl();
})();

function shutdown(signal) {
  stopping = true;
  appendLog(`收到 ${signal}，停止隧道`);
  if (child) {
    try { child.kill(); } catch { /* 忽略 */ }
  }
  try { if (logFd !== null) fs.closeSync(logFd); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => appendLog(`未捕获异常：${error.message}`));
