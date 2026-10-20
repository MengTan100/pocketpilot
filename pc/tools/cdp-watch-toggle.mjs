// SPDX-License-Identifier: MIT
/**
 * cdp-watch-toggle.mjs —— 高频采样 + 真实点按，抓"点一次不开、点两次闪一下又关"。
 *
 * 判据：
 *   · collapsed 变化 = 侧栏状态真的翻转了；
 *   · timeOrigin 变化 = 页面发生了**重载**（这就能解释"展开又瞬间关闭"）；
 *   · 每次点按都打上时间标记，便于对齐 logcat。
 *
 * 用法: node cdp-watch-toggle.mjs <wsUrl> [点按次数=2] [x=42] [y=1385]
 */
import { execFileSync } from 'node:child_process';

const [, , wsUrl, tapsArg, xArg, yArg] = process.argv;
const taps = Number(tapsArg || 2);
const tapX = Number(xArg || 42);
const tapY = Number(yArg || 1385);
const ADB = process.env.ADB_PATH || 'C:\\AndroidSDK\\platform-tools\\adb.exe';

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
});

const PROBE = `JSON.stringify({
  c: (function(){var f=document.querySelector('[class*="_frame"]');return f?f.getAttribute('data-sidebar-collapsed'):'?';})(),
  w: Math.round((document.querySelector('[class*="_sidebarCol"]')||{getBoundingClientRect:()=>({width:-1})}).getBoundingClientRect().width),
  t: Math.round(performance.timeOrigin),
  rs: document.readyState
})`;

async function sample() {
  const res = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  try { return JSON.parse(res.result.value); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.addEventListener('open', async () => {
  await send('Runtime.enable');
  const t0 = Date.now();
  const first = await sample();
  console.log(`起始: collapsed=${first.c} sideW=${first.w} timeOrigin=${first.t} (基准)`);

  let last = first;
  const marks = [];
  for (let i = 0; i < taps; i++) marks.push(t0 + 1000 + i * 1500);

  const log = [];
  let tapIndex = 0;
  for (let step = 0; step < 120; step++) {
    const now = Date.now();
    if (tapIndex < taps && now >= marks[tapIndex]) {
      const at = now - t0;
      log.push(`--- ${at}ms  👆 第 ${tapIndex + 1} 次点按 (${tapX},${tapY}) ---`);
      try { execFileSync(ADB, ['shell', 'input', 'tap', String(tapX), String(tapY)], { timeout: 8000 }); }
      catch (e) { log.push('  点按失败: ' + e.message); }
      tapIndex++;
    }
    const s = await sample();
    if (s) {
      const changed = s.c !== last.c || s.w !== last.w || s.t !== last.t || s.rs !== last.rs;
      if (changed) {
        const reload = s.t !== last.t ? '  ⚠️页面重载(timeOrigin 变了)' : '';
        log.push(`  +${now - t0}ms  collapsed=${s.c}  sideW=${s.w}  readyState=${s.rs}${reload}`);
        last = s;
      }
    }
    await sleep(50);
  }

  console.log(log.join('\n'));
  ws.close();
  process.exit(0);
});

ws.addEventListener('error', (e) => { console.error('WS 错误:', e.message); process.exit(1); });
