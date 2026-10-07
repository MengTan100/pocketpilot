// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:92731f32cd​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
/**
 * 用 CDP 派发**真实触摸**（Input.dispatchTouchEvent）——产生 isTrusted=true 的事件，
 * 走浏览器输入管线，和手指等价；但没有 adb shell 启动进程的几秒开销，时序可控。
 *
 * 用法:
 *   node cdp-tap.mjs <wsUrl> <x> <y> [间隔毫秒]       单点或连点
 *   node cdp-tap.mjs <wsUrl> --seq "x,y;x,y;x,y" [间隔]  按序列点（每点之间间隔毫秒）
 *
 * 说明: 坐标为 CSS 像素（相对布局视口），与 getBoundingClientRect 同一坐标系。
 */
const wsUrl = process.argv[2];
const rest = process.argv.slice(3);

let points = [];
let gap = 150;

if (rest[0] === '--seq') {
  points = rest[1].split(';').map((s) => {
    const [x, y] = s.split(',').map(Number);
    return { x, y };
  });
  if (rest[2]) gap = Number(rest[2]);
} else {
  points = [{ x: Number(rest[0]), y: Number(rest[1]) }];
  if (rest[2]) gap = Number(rest[2]);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
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
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

ws.addEventListener('error', (err) => {
  console.error('WebSocket 错误:', err.message || err);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.addEventListener('open', async () => {
  try {
    // 让 CDP 把鼠标事件也变成触摸事件（真实 WebView 本就支持触摸，这里确保一致）
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    const marks = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const tp = [{ x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
      const t0 = Date.now();
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp });
      // 真实触摸会有几十毫秒的按压时长
      await sleep(45);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      marks.push({ i: i + 1, x: p.x, y: p.y, 耗时: Date.now() - t0 });
      if (i < points.length - 1) await sleep(gap);
    }
    console.log(JSON.stringify({ ok: true, 点数: points.length, 间隔: gap, 明细: marks }, null, 1));
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('执行失败:', err.message);
    process.exit(1);
  }
});
