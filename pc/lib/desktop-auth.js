// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:6b8210588c​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
'use strict';
/**
 * desktop-auth.js —— 为 DSH 桌面端实例自签浏览器会话 Cookie。
 *
 * 背景：桌面端实例（默认 127.0.0.1:19387）的 Web 入口用"进程内随机 launch token"
 * 鉴权，token 不落盘、重启即变，因此外部进程无法通过 ?token= 进入。
 * 但它的 Cookie 签名密钥是**持久化**在 ~/.dsh/.credentials.yaml 的
 * records["client-connection/browser-session"] 里的（{version:1, secret:<32B>}），
 * 于是我们可以按同样算法自签一个合法 Cookie，直接进入桌面端实例——
 * 从而在手机上看到"当前正在进行的对话与任务"（那是桌面端实例独有的实时状态）。
 *
 * 算法（来自 @deepseek-ai/dsh-client-connection）：
 *   Cookie 名 = "dsh-auth-" + base64url(sha256(authority))
 *   Cookie 值 = "v1." + base64url(payloadJson) + "." + base64url(HMAC-SHA256(secret, body))
 *   payload   = {version:1, authority, issuedAt, expiresAt}（毫秒）
 *
 * 安全：密钥只在本机读取，绝不出网、不写日志明文。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const SECRET_BYTES = 32;
const COOKIE_PAYLOAD_VERSION = 1;
const COOKIE_PREFIX = 'dsh-auth-';
const DEFAULT_MAX_AGE_DAYS = 30;

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(text) {
  try {
    return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return undefined;
  }
}

/** js-yaml 可能不在当前模块的解析路径上，按几个常见位置找。 */
function loadYaml(homeDir) {
  const candidates = [
    'js-yaml',
    path.join(os.homedir(), 'node_modules', 'js-yaml'),
    path.join(homeDir, '..', 'node_modules', 'js-yaml'),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('找不到 js-yaml，无法解析凭据文件');
}

function credentialsPath(homeDir) {
  return path.join(homeDir, '.credentials.yaml');
}

/**
 * 读取 browser-session 签名密钥（32 字节，base64url 文本）。
 * @returns {string} base64url 编码的密钥
 */
function loadBrowserSessionSecret(homeDir) {
  const file = credentialsPath(homeDir);
  if (!fs.existsSync(file)) throw new Error(`找不到凭据文件：${file}`);
  const yaml = loadYaml(homeDir);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return undefined;
    }
    if (!node || typeof node !== 'object') return undefined;
    if (node.kind === 'grant' && node.payload && node.payload.version === COOKIE_PAYLOAD_VERSION) {
      const secret = node.payload.secret;
      if (typeof secret === 'string') {
        const decoded = decodeBase64url(secret);
        if (decoded && decoded.byteLength === SECRET_BYTES) return secret;
      }
    }
    for (const value of Object.values(node)) {
      const found = walk(value);
      if (found) return found;
    }
    return undefined;
  };

  const secret = walk(doc);
  if (!secret) throw new Error('凭据里没有 32 字节的 browser-session 密钥');
  return secret;
}

function cookieNameFor(authority) {
  return COOKIE_PREFIX + base64url(crypto.createHash('sha256').update(authority).digest());
}

/**
 * 自签一个属于该 authority 的会话 Cookie。
 * @returns {{name:string, value:string, payload:object, header:string}}
 */
function mintCookie({ homeDir, authority, maxAgeDays = DEFAULT_MAX_AGE_DAYS }) {
  const secretText = loadBrowserSessionSecret(homeDir);
  const secret = decodeBase64url(secretText);
  const now = Date.now();
  const expiresAt = now + maxAgeDays * 24 * 60 * 60 * 1000;
  const payload = { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt: now, expiresAt };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = crypto.createHmac('sha256', secret).update(body).digest();
  const value = `v1.${body}.${base64url(signature)}`;
  const name = cookieNameFor(authority);
  const maxAgeSeconds = Math.floor((expiresAt - now) / 1000);
  return {
    name,
    value,
    payload,
    header: `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax`,
  };
}

/** 探测某个实例是否在监听。 */
function probeInstance(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/', method: 'GET', timeout: timeoutMs, headers: { Host: `${host}:${port}` } },
      (res) => {
        res.resume();
        resolve({ alive: true, status: res.statusCode, requiresAuth: res.statusCode === 401 });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ alive: false, status: 0, requiresAuth: false }); });
    req.on('error', () => resolve({ alive: false, status: 0, requiresAuth: false }));
    req.end();
  });
}

module.exports = { mintCookie, cookieNameFor, loadBrowserSessionSecret, probeInstance, credentialsPath };
