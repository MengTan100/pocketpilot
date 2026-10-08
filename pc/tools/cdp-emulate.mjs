// SPDX-License-Identifier: MIT
/**
 * CDP 设备模拟：把 WebView 的视口临时改成指定尺寸，用来验证
 * DSH 的响应式行为（例如"宽屏下侧栏是否会出现会话列表"）。
 *
 * 用法: node cdp-emulate.mjs <wsUrl> <width> <height> [queryJsFile]
 *
 * 之所以用 Emulation.setDeviceMetricsOverride 而不是改 meta viewport：
 * DSH 的 HTML 自带 viewport 声明，重载后会把我们的修改重置掉；
 * 而 CDP 的设备指标覆盖作用在渲染层，页面无法重置。
 */
import { readFileSync } from 'node:fs';

const [wsUrl, widthArg, heightArg, queryFile] = process.argv.slice(2);
if (!wsUrl || !widthArg || !heightArg) {
  console.error('用法: node cdp-emulate.mjs <wsUrl> <width> <height> [queryJsFile]');
  process.exit(2);
}

const width = Number(widthArg);
const height = Number(heightArg);

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 15000);
  });
}

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

ws.addEventListener('error', () => { console.error('WebSocket 错误'); process.exit(1); });

ws.addEventListener('open', async () => {
  try {
    // 关键：覆盖设备指标，让页面以为自己是宽屏
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 1500));

    const probe = `
      (function () {
        var side = document.querySelector('[class*="_sidebarCol"]');
        var items = [];
        if (side) {
          Array.prototype.slice.call(side.querySelectorAll('*')).forEach(function (e) {
            if (e.children.length === 0) {
              var t = (e.innerText || '').trim();
              if (t && t.length < 30 && items.indexOf(t) < 0) items.push(t);
            }
          });
        }
        return JSON.stringify({
          视口宽: window.innerWidth,
          侧栏宽: side ? Math.round(side.getBoundingClientRect().width) : -1,
          侧栏条目: items.slice(0, 30)
        });
      })()
    `;
    const expr = queryFile ? readFileSync(queryFile, 'utf8') : probe;

    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const v = res.result && res.result.result ? res.result.result.value : undefined;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));

    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('执行失败:', err.message);
    process.exit(1);
  }
});
