// SPDX-License-Identifier: MIT
'use strict';
/**
 * desktop-cookie.js —— 为 DSH **桌面端实例**（默认 127.0.0.1:19387）自签一个合法的
 * 浏览器会话 Cookie，从而在不重启桌面端、不需要 launch token 的情况下直连它。
 *
 * 原理（来自 @deepseek-ai/dsh-client-connection 的实现）：
 *   - 签名密钥不是纯内存的：initializeSecret() 把 {version:1, secret:<32 字节>}
 *     持久化在 ~/.dsh/.credentials.yaml 的 browser-session 记录里；
 *   - Cookie 名 = "dsh-auth-" + base64url(sha256(authority))；
 *   - Cookie 值 = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, body))；
 *   - payload = {version:1, authority, issuedAt, expiresAt}（毫秒时间戳）。
 *
 * ⚠️ 该密钥是本机浏览器会话凭据，脚本只在本地读取、绝不出网，也不打印密钥明文。
 *
 * 用法:
 *   node desktop-cookie.js --probe            # 只探测：能否用自签 Cookie 通过鉴权
 *   node desktop-cookie.js --show             # 打印 Cookie 名与值（供手工调试）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const HOST = process.env.DSH_DESKTOP_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_DESKTOP_PORT || 19387);
const AUTHORITY = `${HOST}:${PORT}`;
const SECRET_BYTES = 32;
const COOKIE_PAYLOAD_VERSION = 1;
const COOKIE_PREFIX = 'dsh-auth-';
const MAX_AGE_DAYS = 30;

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

/** 从凭据文件里取出 browser-session 的签名密钥（32 字节，base64url 编码）。 */
function loadSecret(homeDir) {
  const file = path.join(homeDir, '.credentials.yaml');
  if (!fs.existsSync(file)) throw new Error(`找不到凭据文件：${file}`);

  let yaml;
  try {
    yaml = require(path.join(homeDir, '..', 'node_modules', 'js-yaml'));
  } catch {
    yaml = require('js-yaml');
  }
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));

  const seen = [];
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    // browser-session 记录形状：{ kind: "grant", payload: { version: 1, secret: <43 字符> } }
    if (node.kind === 'grant' && node.payload && node.payload.version === COOKIE_PAYLOAD_VERSION) {
      const secret = node.payload.secret;
      if (typeof secret === 'string') {
        const decoded = decodeBase64url(secret);
        seen.push({ trail, chars: secret.length, bytes: decoded ? decoded.byteLength : -1 });
        if (decoded && decoded.byteLength === SECRET_BYTES) {
          return { secret, trail };
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      const found = walk(value, trail ? `${trail}.${key}` : key);
      if (found) return found;
    }
    return undefined;
  };

  const found = walk(doc, '');
  if (!found) {
    console.error('候选记录：', JSON.stringify(seen));
    throw new Error('凭据文件里没有找到 32 字节的 browser-session 密钥');
  }
  console.error(`[i] 已定位签名密钥：${found.trail}（长度 ${found.secret.length} 字符，${SECRET_BYTES} 字节）`);
  return found.secret;
}

function cookieName(authority) {
  return COOKIE_PREFIX + base64url(crypto.createHash('sha256').update(authority).digest());
}

function encodeCookie(payload, secretText) {
  const secret = decodeBase64url(secretText);
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  return `v1.${body}.${base64url(sig)}`;
}

function mint(homeDir, authority) {
  const secret = loadSecret(homeDir);
  const now = Date.now();
  const payload = {
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt: now,
    expiresAt: now + MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  };
  return { name: cookieName(authority), value: encodeCookie(payload, secret), payload };
}

/** 本地回环的 HTTP 请求（显式带 Host，避免依赖 fetch 的默认行为）。 */
function rawRequest(urlString, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const http = require('node:http');
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function probe() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const cookie = mint(home, AUTHORITY);
  console.log(`authority   : ${AUTHORITY}`);
  console.log(`cookie name : ${cookie.name}`);

  const base = `http://${HOST}:${PORT}`;
  const withCookie = await rawRequest(`${base}/`, {
    Host: AUTHORITY,
    Cookie: `${cookie.name}=${cookie.value}`,
    Accept: 'text/html',
  });
  const without = await rawRequest(`${base}/`, { Host: AUTHORITY, Accept: 'text/html' });

  const ok = withCookie.status === 200 && withCookie.body.includes('<html');
  console.log(`无 Cookie : HTTP ${without.status}  ${JSON.stringify(without.body.slice(0, 60))}`);
  console.log(`带 Cookie : HTTP ${withCookie.status}  ${JSON.stringify(withCookie.body.slice(0, 60))}`);
  console.log(ok ? '\n✅ 自签 Cookie 通过鉴权，可直连桌面端实例' : '\n❌ 自签 Cookie 未通过鉴权');

  if (ok) {
    const rpc = await rawRequest(`${base}/api/session.list`, {
      Host: AUTHORITY,
      Cookie: `${cookie.name}=${cookie.value}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    console.log(`RPC 探测  : HTTP ${rpc.status}  ${JSON.stringify(rpc.body.slice(0, 80))}`);
  }
  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  if (args.includes('--show')) {
    const cookie = mint(home, AUTHORITY);
    console.log(`${cookie.name}=${cookie.value}`);
    console.log(`\npayload: ${JSON.stringify(cookie.payload)}`);
    return;
  }
  const ok = await probe();
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[error]', error.message);
  process.exit(2);
});
