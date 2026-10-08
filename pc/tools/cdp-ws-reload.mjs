// SPDX-License-Identifier: MIT
/**
 * 定论工具：先开 Network 域，再重载页面让 WebSocket 重新建立，然后抓帧。
 *
 * 为什么必须重载：CDP 的 Network 域对"监听开始之前就已建立"的 WebSocket
 * 不会补报事件，直接监听会得到"0 帧"的假阴性。重载后新建的 WS 才会被完整上报，
 * 包括握手响应码（101 才是成功，401/502 就是被卡住）与每一帧。
 *
 * 用法: node cdp-ws-reload.mjs <wsUrl> [监听秒数]
 */
const wsUrl = process.argv[2];
const seconds = Number(process.argv[3] || 40);

if (!wsUrl) {
  console.error('用法: node cdp-ws-reload.mjs <wsUrl> [秒数]');
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
const stats = {
  created: 0, closed: 0, errors: 0, framesReceived: 0, framesSent: 0,
  handshakes: [], samples: [], urls: {},
};

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 15000);
  });
}

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); return; }
  const p = msg.params || {};

  if (msg.method === 'Network.webSocketCreated') {
    stats.created++;
    const k = String(p.url || '').replace(/^https?:\/\/[^/]+/, '');
    stats.urls[k] = (stats.urls[k] || 0) + 1;
  }
  if (msg.method === 'Network.webSocketHandshakeResponseReceived') {
    const r = p.response || {};
    stats.handshakes.push({ url: String(p.url || '').replace(/^https?:\/\/[^/]+/, ''), status: r.status, text: r.statusText });
  }
  if (msg.method === 'Network.webSocketClosed') stats.closed++;
  if (msg.method === 'Network.webSocketFrameError') stats.errors++;
  if (msg.method === 'Network.webSocketFrameReceived') {
    stats.framesReceived++;
    stats.lastReceivedAt = Date.now();
    if (stats.samples.length < 10) stats.samples.push('RECV ' + String((p.response || {}).payloadData || '').slice(0, 140));
  }
  if (msg.method === 'Network.webSocketFrameSent') {
    stats.framesSent++;
    stats.lastSentAt = Date.now();
    if (stats.samples.length < 16) stats.samples.push('SENT ' + String((p.request || {}).payloadData || '').slice(0, 140));
  }
});

ws.addEventListener('error', () => { console.error('CDP WebSocket 错误'); process.exit(1); });

ws.addEventListener('open', async () => {
  await send('Network.enable', {});
  await send('Page.enable', {});
  console.log('已开启 Network 域，正在重载页面…');
  await send('Page.reload', { ignoreCache: false });
  console.log(`重载完成，开始抓帧 ${seconds} 秒（此时我这边会持续产出，应能看到 RECV 帧）…`);
  await new Promise((r) => setTimeout(r, seconds * 1000));

  const now = Date.now();
  console.log('\n=== WebSocket 统计（重载后）===');
  console.log('  新建连接 :', stats.created, JSON.stringify(stats.urls));
  console.log('  握手结果 :', JSON.stringify(stats.handshakes));
  console.log('  收到帧   :', stats.framesReceived);
  console.log('  发出帧   :', stats.framesSent);
  console.log('  已关闭   :', stats.closed, ' 错误:', stats.errors);
  console.log('  最后收帧 :', stats.lastReceivedAt ? ((now - stats.lastReceivedAt) / 1000).toFixed(1) + ' 秒前' : '(监听期间无收帧)');
  console.log('\n=== 帧样例 ===');
  stats.samples.forEach((s) => console.log('  ' + s));

  const verdict = stats.framesReceived > 0
    ? '✅ 实时通道正常：服务端在推、桥接在转、页面在收'
    : (stats.created === 0 ? '⚠️ 重载后根本没建立 WS（可能被鉴权挡住或脚本没跑到）'
       : '❌ WS 建立了但一帧都没收到 → 卡在桥接转发或上游不推');
  console.log('\n判定:', verdict);
  ws.close();
  process.exit(0);
});
