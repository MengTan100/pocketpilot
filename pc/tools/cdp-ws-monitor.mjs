// SPDX-License-Identifier: MIT
/**
 * 监听页面 WebSocket 的真实帧收发。
 *
 * 用法: node cdp-ws-monitor.mjs <wsUrl> [监听秒数]
 *
 * 为什么用它：DSH 的对话状态（流式输出、任务进度）靠 WebSocket 推送。
 * "手机上不实时"这件事，必须看真实帧才知道是
 *   a) 服务端没推、b) 桥接代理没转、c) 转到了但页面没渲染。
 * 靠猜没用，所以直接抓帧。
 */
const wsUrl = process.argv[2];
const seconds = Number(process.argv[3] || 15);

if (!wsUrl) {
  console.error('用法: node cdp-ws-monitor.mjs <wsUrl> [秒数]');
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();

const stats = {
  created: 0,
  closed: 0,
  errors: 0,
  framesReceived: 0,
  framesSent: 0,
  byUrl: {},
  samples: [],
};

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); }
    }, 10000);
  });
}

function shortUrl(u) {
  try {
    const p = new URL(u);
    return p.pathname;
  } catch { return String(u).slice(0, 60); }
}

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
    return;
  }

  const p = msg.params || {};

  if (msg.method === 'Network.webSocketCreated') {
    stats.created++;
    const key = shortUrl(p.url || '');
    stats.byUrl[key] = (stats.byUrl[key] || 0) + 1;
  }
  if (msg.method === 'Network.webSocketClosed') stats.closed++;
  if (msg.method === 'Network.webSocketFrameError') stats.errors++;

  if (msg.method === 'Network.webSocketFrameReceived') {
    stats.framesReceived++;
    stats.lastReceivedAt = Date.now();
    if (stats.samples.length < 12) {
      const data = (p.response && p.response.payloadData) || '';
      stats.samples.push('RECV ' + String(data).slice(0, 150));
    }
  }
  if (msg.method === 'Network.webSocketFrameSent') {
    stats.framesSent++;
    stats.lastSentAt = Date.now();
    if (stats.samples.length < 20) {
      const data = (p.request && p.request.payloadData) || '';
      stats.samples.push('SENT ' + String(data).slice(0, 150));
    }
  }
});

ws.addEventListener('error', () => { console.error('CDP WebSocket 错误'); process.exit(1); });

ws.addEventListener('open', async () => {
  await send('Network.enable', {});
  console.log(`监听 ${seconds} 秒（请此时在电脑端让对话产生输出，例如发一条消息）…`);
  await new Promise((r) => setTimeout(r, seconds * 1000));

  const now = Date.now();
  console.log('\n=== WebSocket 统计 ===');
  console.log('  建立的连接数   :', stats.created);
  console.log('  已关闭        :', stats.closed);
  console.log('  错误          :', stats.errors);
  console.log('  收到帧        :', stats.framesReceived);
  console.log('  发出帧        :', stats.framesSent);
  console.log('  按地址        :', JSON.stringify(stats.byUrl));
  if (stats.lastReceivedAt) {
    console.log('  最后收帧于    :', ((now - stats.lastReceivedAt) / 1000).toFixed(1), '秒前');
  } else {
    console.log('  最后收帧于    : (本次监听期间没有收到任何帧)');
  }
  console.log('\n=== 帧样例 ===');
  stats.samples.forEach((s) => console.log('  ' + s));

  ws.close();
  process.exit(0);
});
