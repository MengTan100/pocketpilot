// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:1aacae05d1​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
/**
 * cdp-probe.mjs —— 用 Edge 的 DevTools 协议加载 DSH 前端，抓取控制台报错与插件执行情况。
 *
 * 为什么要这么绕：客户端插件的执行发生在浏览器里，服务端日志看不到。
 * 只有接上 CDP 才能拿到 console 错误、网络失败，以及 __ModuleLoader__ 的真实状态。
 *
 * 用法: node cdp-probe.mjs <url> <cookie>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const [, , targetUrl, cookie] = process.argv;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;

const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\edge-cdp-profile',
  'about:blank',
], { stdio: 'ignore', detached: false });

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Edge 调试端口未就绪');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const logs = [];
const errors = [];
const requests = [];

function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve) => {
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  const m = msg.method;
  if (m === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[${msg.params.type}] ${text}`);
  } else if (m === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(d.exception?.description || d.text);
  } else if (m === 'Network.responseReceived') {
    const u = msg.params.response.url;
    if (/plugins\/|pair\.json/.test(u)) requests.push(`${msg.params.response.status} ${u.slice(0, 120)}`);
  } else if (m === 'Network.loadingFailed') {
    errors.push(`LOADING FAILED: ${msg.params.errorText}`);
  }
});

await new Promise((r) => ws.addEventListener('open', r));

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');

// 带上鉴权 cookie
if (cookie) {
  const eq = cookie.indexOf('=');
  await send('Network.setCookie', {
    name: cookie.slice(0, eq),
    value: cookie.slice(eq + 1),
    domain: '127.0.0.1',
    path: '/',
  });
}

await send('Page.navigate', { url: targetUrl });
await sleep(15000);

// 问一下模块加载器的状态
const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    hasLoader: typeof window.__ModuleLoader__,
    bootIds: (window.__DSH_BOOT__ || []).length,
    hasMine: JSON.stringify(window.__DSH_BOOT__ || []).includes('dsh-plugin-phone-bridge'),
    bodyText: (document.body && document.body.innerText || '').slice(0, 300)
  })`,
  returnByValue: true,
});

console.log('=== 模块加载器状态 ===');
console.log(probe?.result?.value || '(取不到)');
console.log('\n=== 插件相关网络请求 ===');
requests.slice(0, 20).forEach((r) => console.log('  ' + r));
if (!requests.length) console.log('  （没有任何插件请求）');
console.log('\n=== 控制台输出（后 25 条） ===');
logs.slice(-25).forEach((l) => console.log('  ' + l));
if (!logs.length) console.log('  （无）');
console.log('\n=== 未捕获异常 ===');
errors.slice(0, 15).forEach((e) => console.log('  ' + String(e).slice(0, 300)));
if (!errors.length) console.log('  （无）');

ws.close();
edge.kill();
process.exit(0);
