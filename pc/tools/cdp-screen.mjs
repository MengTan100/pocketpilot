// SPDX-License-Identifier: MIT
/**
 * cdp-screen.mjs —— 连上手机 WebView，重载页面并抓"白屏"证据。
 *
 * 抓四类东西：
 *   ① 所有网络请求的状态码（重点看 4xx/5xx 与失败）；
 *   ② console 输出与未捕获异常；
 *   ③ 页面 DOM 现状（readyState / body 文本长度 / 根节点子元素数）；
 *   ④ 启动相关全局量（__DSH_BOOT__ / __ModuleLoader__ / script 标签）。
 *
 * 用法: node cdp-screen.mjs <wsUrl> [等待毫秒]
 */
const [, , wsUrl, waitArg] = process.argv;
const waitMs = Number(waitArg || 12000);
if (!wsUrl) {
  console.error('用法: node cdp-screen.mjs ws://127.0.0.1:9333/devtools/page/XXXX [等待毫秒]');
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
const logs = [];
const errors = [];
const requests = new Map();   // requestId -> {url, status, type}
const failed = [];

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); }
    }, 15000);
  });
}

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
    return;
  }
  const m = msg.method;
  if (m === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[${msg.params.type}] ${String(text).slice(0, 300)}`);
  } else if (m === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    errors.push(String((d.exception && d.exception.description) || d.text || '').slice(0, 400));
  } else if (m === 'Log.entryAdded') {
    const e = msg.params.entry || {};
    if (e.level === 'error' || e.level === 'warning') {
      logs.push(`[log:${e.level}] ${String(e.text || '').slice(0, 300)}`);
    }
  } else if (m === 'Network.requestWillBeSent') {
    requests.set(msg.params.requestId, { url: msg.params.request.url, method: msg.params.request.method, status: 0, type: msg.params.type });
  } else if (m === 'Network.responseReceived') {
    const rec = requests.get(msg.params.requestId);
    if (rec) { rec.status = msg.params.response.status; rec.mime = msg.params.response.mimeType; }
  } else if (m === 'Network.loadingFailed') {
    const rec = requests.get(msg.params.requestId);
    failed.push(`${msg.params.errorText}${msg.params.canceled ? ' (canceled)' : ''} ${rec ? rec.url : ''}`.slice(0, 300));
  } else if (m === 'Network.webSocketCreated') {
    logs.push(`[ws] created ${msg.params.url}`);
  } else if (m === 'Network.webSocketClosed') {
    logs.push(`[ws] closed ${msg.params.url}`);
  } else if (m === 'Network.webSocketFrameError') {
    errors.push(`[ws] frame error ${msg.params.errorMessage} ${msg.params.url || ''}`);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    await send('Page.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.reload', { ignoreCache: true });
    await sleep(waitMs);

    const probe = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        href: location.href,
        readyState: document.readyState,
        title: document.title,
        baseURI: document.baseURI,
        bodyText: (document.body ? document.body.innerText : '').slice(0, 200),
        bodyLen: document.body ? document.body.innerText.length : -1,
        rootChildren: document.documentElement ? document.documentElement.children.length : -1,
        scripts: Array.from(document.scripts).map(s => s.src || '(inline)').slice(0, 12),
        boot: Array.isArray(window.__DSH_BOOT__) ? window.__DSH_BOOT__.length : -1,
        hasLoader: typeof window.__ModuleLoader__,
        htmlHead: document.documentElement ? document.documentElement.outerHTML.slice(0, 400) : ''
      })`,
      returnByValue: true,
    });
    console.log('=== 页面现状 ===');
    console.log(probe?.result?.result?.value || '(取不到)');

    const all = [...requests.values()];
    const bad = all.filter((r) => r.status >= 400 || r.status === 0);
    console.log(`\n=== 网络（共 ${all.length} 个，异常 ${bad.length} 个）===`);
    for (const r of all.slice(0, 60)) {
      console.log(`  ${String(r.status).padStart(3)}  ${r.method} ${r.url.slice(0, 160)}`);
    }

    console.log('\n=== 失败请求 ===');
    failed.slice(0, 20).forEach((f) => console.log('  ' + f));
    if (!failed.length) console.log('  （无）');

    console.log('\n=== console（后 30 条）===');
    logs.slice(-30).forEach((l) => console.log('  ' + l));
    if (!logs.length) console.log('  （无）');

    console.log('\n=== 未捕获异常 ===');
    errors.slice(0, 15).forEach((e) => console.log('  ' + e));
    if (!errors.length) console.log('  （无）');

    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('诊断失败:', err.message);
    process.exit(1);
  }
});

ws.addEventListener('error', (err) => {
  console.error('WebSocket 错误:', err.message || err);
  process.exit(1);
});
