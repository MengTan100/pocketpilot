// SPDX-License-Identifier: MIT
/**
 * Cloudflare Tunnel 集成：把本机桥接暴露到公网，供手机在异地访问。
 *
 * 为什么是这条路：
 *   1. PC 在 NAT 后没有公网入口，手机无法直连；
 *   2. 手机端要求「不装额外 App」——Tailscale 之类都需要手机装客户端，被排除；
 *   3. 只有「PC 侧主动出站建立隧道、由云端回程」这一条路满足上述约束。
 *
 * 采用 Quick Tunnel（trycloudflare.com）：无需 Cloudflare 账号、无需域名、
 * 无需备案即可拿到一个临时 HTTPS 地址。代价是地址每次重启会变，
 * 因此这里把地址交给桥接的配对接口分发，App 每次配对都会拿到最新地址。
 *
 * 安全提醒：隧道会把桥接端口暴露到公网，因此
 *   · 只暴露桥接（3080），不暴露 DSH 本身；
 *   · 桥接的鉴权（bridge token）保持不变，隧道不绕过它。
 */
const { spawn } = require('node:child_process');

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

module.exports = { createTunnel, extractPublicUrl };
