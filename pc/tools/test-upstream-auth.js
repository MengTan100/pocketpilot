// SPDX-License-Identifier: MIT
'use strict';
/**
 * test-upstream-auth.js —— 上游鉴权链路的结构化回归测试（不需要真实桌面端）。
 *
 * 覆盖四件事：
 *   A. 桥接能接受桌面端插件交来的「带 token 的会话地址」，并换成 Cookie；
 *   B. 代理用这条 Cookie 访问上游（HTTP + WebSocket）都通；
 *   C. 上游 401（密钥轮换/会话过期）时，代理会**等**重新鉴权完成再重试，而不是直接透传 401；
 *   D. 鉴权入口本身受 bridge token 保护（错误令牌必须 401）。
 *
 * 用法：node pc/tools/test-upstream-auth.js
 * 前置：桥接已在 3080 运行（用它的 bridge.config.json 里的令牌）。
 */

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE = { host: '127.0.0.1', port: 3080 };
const FAKE_PORT = 53999;
const LAUNCH_TOKEN = 'test-launch-token';

const pcDir = path.resolve(__dirname, '..');
const bridgeConfig = JSON.parse(fs.readFileSync(path.join(pcDir, 'bridge.config.json'), 'utf8'));
const BRIDGE_TOKEN = String(bridgeConfig.bridgeToken || '');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---------------------------------------------------------------- 假桌面端
// 行为对齐真实 DSH：不带/带错 Cookie → 401 + "dsh web authentication required"；
// 带对了 → 200；带 token 访问 / → 303 + Set-Cookie。
let acceptedCookie = null;
let exchanges = 0;

const fake = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${FAKE_PORT}`);
  if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === LAUNCH_TOKEN) {
    exchanges += 1;
    acceptedCookie = `dsh-auth-test${exchanges}`;
    res.writeHead(303, {
      location: './',
      'cache-control': 'no-store',
      'set-cookie': `${acceptedCookie}=v1.fake-signature; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
    });
    res.end();
    return;
  }
  const cookieOk = Boolean(acceptedCookie) && String(req.headers.cookie || '').includes(`${acceptedCookie}=`);
  if (!cookieOk) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><base href="/"></head><body>fake desktop</body></html>');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, path: url.pathname }));
});

fake.on('upgrade', (req, socket) => {
  const cookieOk = Boolean(acceptedCookie) && String(req.headers.cookie || '').includes(`${acceptedCookie}=`);
  if (!cookieOk) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'] || '';
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on('error', () => {});
});

// ---------------------------------------------------------------- 请求工具
function bridgeRequest(method, pathname, { body, token } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length; }
    if (token) headers['x-bridge-token'] = token;
    const req = http.request({ host: BRIDGE.host, port: BRIDGE.port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (error) => resolve({ status: 0, body: error.message }));
    if (payload) req.end(payload); else req.end();
  });
}

function bridgeWs(pathname) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(BRIDGE.port, BRIDGE.host, () => {
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        `Host: ${BRIDGE.host}:${BRIDGE.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Origin: http://${BRIDGE.host}:${BRIDGE.port}`,
        '', '',
      ].join('\r\n'));
    });
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); resolve({ status: 0, line: 'timeout' }); }, 6000);
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      const idx = data.indexOf('\r\n');
      if (idx === -1) return;
      clearTimeout(timer);
      const line = data.slice(0, idx);
      socket.destroy();
      resolve({ status: Number((line.match(/HTTP\/1\.[01] (\d{3})/) || [])[1] || 0), line });
    });
    socket.on('error', (error) => { clearTimeout(timer); resolve({ status: 0, line: error.message }); });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 用例
async function main() {
  await new Promise((resolve) => fake.listen(FAKE_PORT, '127.0.0.1', resolve));
  console.log(`假桌面端已监听 127.0.0.1:${FAKE_PORT}\n`);

  console.log('A. 会话地址交接');
  const badToken = await bridgeRequest('POST', '/upstream/desktop-session', {
    body: { url: `http://127.0.0.1:${FAKE_PORT}/?token=${LAUNCH_TOKEN}` },
    token: 'wrong-token',
  });
  check('错误 bridge token 被拒绝（401）', badToken.status === 401, `HTTP ${badToken.status}`);

  const noToken = await bridgeRequest('POST', '/upstream/desktop-session', {
    body: { url: `http://127.0.0.1:${FAKE_PORT}/?token=${LAUNCH_TOKEN}` },
  });
  check('无 token 被拒绝（401）', noToken.status === 401, `HTTP ${noToken.status}`);

  const badUrl = await bridgeRequest('POST', '/upstream/desktop-session', {
    body: { url: 'http://example.com/?token=x' },
    token: BRIDGE_TOKEN,
  });
  check('非回环地址被拒绝（502）', badUrl.status === 502, `HTTP ${badUrl.status}`);

  const accepted = await bridgeRequest('POST', '/upstream/desktop-session', {
    // force=true：桥接对同一 authority 会缓存 10 分钟，测试必须强制重换一次
    body: { url: `http://127.0.0.1:${FAKE_PORT}/?token=${LAUNCH_TOKEN}`, force: true },
    token: BRIDGE_TOKEN,
  });
  check('合法会话地址被接受（200）', accepted.status === 200 && exchanges === 1, `HTTP ${accepted.status}, 换牌 ${exchanges} 次`);

  console.log('\nB. 代理走这条会话');
  const page = await bridgeRequest('GET', '/dsh/');
  check('GET /dsh/ → 200', page.status === 200, `HTTP ${page.status}`);
  check('上游是假桌面端', page.body.includes('fake desktop'), page.body.slice(0, 60).replace(/\s+/g, ' '));
  check('<base> 被改写到 /dsh/', page.body.includes('<base href="/dsh/">'));

  const api = await bridgeRequest('GET', '/dsh/api/ping');
  check('GET /dsh/api/ping → 200', api.status === 200 && api.body.includes('"ok":true'), `HTTP ${api.status}`);

  const ws = await bridgeWs('/dsh/api/remote.mux');
  check('WS /dsh/api/remote.mux → 101', ws.status === 101, ws.line);

  console.log('\nC. 上游 401 自愈（模拟密钥轮换）');
  acceptedCookie = 'dsh-auth-expired';    // 旧 Cookie 立刻失效
  const before = exchanges;
  const healed = await bridgeRequest('GET', '/dsh/api/ping');
  check('401 后自动重新鉴权并重试成功', healed.status === 200, `HTTP ${healed.status}`);
  check('确实重新换了一次会话', exchanges === before + 1, `换牌 ${before} → ${exchanges}`);

  acceptedCookie = 'dsh-auth-expired-2';
  const wsBefore = exchanges;
  const wsHealed = await bridgeWs('/dsh/api/remote.mux');
  check('WS 401 后自动重新鉴权并重试成功', wsHealed.status === 101, wsHealed.line);
  check('WS 也重新换了一次会话', exchanges === wsBefore + 1, `换牌 ${wsBefore} → ${exchanges}`);

  console.log('\nD. 收尾：把上游切回真实桌面端');
  // 先停掉假桌面端：桥接会优先信任"已持有会话的端口"，假上游还活着就不会切回去
  // （这正是想要的行为 —— 拿到权威会话就别再被端口启发式打断）。
  // 注意不能 await close()：桥接的 WS 管道会一直占着连接，close 永远不回调。
  fake.close();
  fake.closeAllConnections?.();
  await bridgeRequest('GET', '/desktop', { token: BRIDGE_TOKEN });
  await sleep(1500);
  const state = await bridgeRequest('GET', `/state?token=${encodeURIComponent(BRIDGE_TOKEN)}`);
  let parsed = {};
  try { parsed = JSON.parse(state.body); } catch { /* 忽略 */ }
  const port = parsed && parsed.desktop ? parsed.desktop.port : 0;
  check('假上游已停掉后端口自动切回真实桌面端', port !== FAKE_PORT && port > 0, `port=${port}`);
  // 说明：真实桌面端的自签 Cookie 偶发被拒（DSH 进程内密钥与磁盘短时不一致，
  // 正是本次要绕开的根因），所以这里不把"能否 200"当作断言，只报告现状。
  const realPage = await bridgeRequest('GET', '/dsh/');
  console.log(`  ℹ️  真实桌面端当前返回 HTTP ${realPage.status}` + (realPage.status === 200 ? '（自签 Cookie 可用）' : '（自签被拒，等插件交会话地址后走权威路径）'));

  fake.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常：', error);
  fake.close();
  process.exit(2);
});

// 兜底：任何一步卡住都不让测试进程挂死（WS/长连接最容易出这种事）。
setTimeout(() => {
  console.error(`\n测试超时（已通过 ${pass}，失败 ${fail}）`);
  process.exit(3);
}, 60000).unref();
