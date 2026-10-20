// SPDX-License-Identifier: Apache-2.0
/**
 * cdp-drawer-dialog.mjs —— 用无头 Edge 复现「手机侧栏抽屉打开后，设置/账户点不开」。
 *
 * 做法：手机视口(394x759) + 注入与 App 相同的抽屉样式 → 打开抽屉 → 点"设置"→
 * 检查弹出面板的位置与命中测试（elementFromPoint 是不是被抽屉/遮罩盖住）。
 *
 * 用法: node cdp-drawer-dialog.mjs [页面地址]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:3080/dsh/';
const PORT = 9334;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\edge-cdp-drawer`,
  'about:blank',
], { stdio: 'ignore' });

async function versionWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Edge 调试端口未就绪');
}

const ws = new WebSocket(await versionWs());
let id = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
});
await new Promise((r) => ws.addEventListener('open', r));

// 建一个页面 target 并挂上
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params) => send(method, params, sessionId);

await S('Runtime.enable');
await S('Page.enable');
await S('Emulation.setDeviceMetricsOverride', {
  width: 394, height: 759, deviceScaleFactor: 3.25, mobile: true,
});
await S('Page.navigate', { url: URL_TARGET });
await sleep(6000);

const evalJs = async (expression) => {
  const res = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res && res.exceptionDetails) return { error: res.exceptionDetails.text };
  return res && res.result ? res.result.value : undefined;
};

// 注入与 App 相同的抽屉样式（含 compact 标记）
await evalJs(`(function(){
  var root = document.documentElement;
  root.setAttribute('data-dsh-compact','true');
  root.setAttribute('data-rail-boost','1');
  var frame = document.querySelector('[class*="_frame"]');
  var bg = frame ? getComputedStyle(frame).backgroundColor : '#fff';
  var st = document.createElement('style');
  st.id = '__testDrawer';
  st.textContent = [
    'html[data-dsh-compact="true"] [class*="_frame"]:not([data-sidebar-collapsed="true"]) [class*="_sidebarCol"] {',
    '  position: fixed !important; left:0 !important; top:0 !important; bottom:0 !important;',
    '  width: min(320px, 86vw) !important; height: 100% !important;',
    '  z-index: 1000 !important; background: ' + (bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#fff') + ' !important;',
    '  overflow: hidden !important; transform:none !important; opacity:1 !important; pointer-events:auto !important;',
    '}'
  ].join('\\n');
  document.head.appendChild(st);
  return 'injected';
})()`);

// 展开侧栏（点 DSH 自己的 toggle）
const opened = await evalJs(`(function(){
  var f = document.querySelector('[class*="_frame"]');
  if (f && f.getAttribute('data-sidebar-collapsed') === 'true') {
    var ts = document.querySelectorAll('[class*="_toggle"]');
    for (var i=0;i<ts.length;i++){ var l=ts[i].getAttribute('aria-label')||''; if(l.indexOf('打开')>=0){ ts[i].click(); return 'clicked '+l; } }
    return 'no-toggle';
  }
  return 'already-open';
})()`);
console.log('展开侧栏:', opened);
await sleep(1200);

// 先列出侧栏里所有可点元素（含文案 / aria-label），便于确认真实入口名
const btnList = await evalJs(`(function(){
  var side = document.querySelector('[class*="_sidebarCol"]');
  if (!side) return 'no-sidebar';
  var out = [];
  side.querySelectorAll('button,[role="button"],[role="menuitem"],a').forEach(function(b){
    var r = b.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return;
    out.push(((b.innerText||'').trim() + '|' + (b.getAttribute('aria-label')||'')).slice(0, 40));
  });
  return JSON.stringify(out);
})()`);
console.log('侧栏可点元素:', btnList);

// 找侧栏里的"设置 / 账户"按钮并点
const clickResult = await evalJs(`(function(){
  var side = document.querySelector('[class*="_sidebarCol"]');
  if (!side) return 'no-sidebar';
  var all = side.querySelectorAll('button,[role="button"],[role="menuitem"],a');
  for (var i=0;i<all.length;i++){
    var t = (all[i].innerText||'').trim() + ' ' + (all[i].getAttribute('aria-label')||'');
    if (t.indexOf('设置')>=0 || t.indexOf('Settings')>=0 || t.indexOf('账号')>=0 || t.indexOf('账户')>=0 || t.indexOf('Account')>=0) {
      all[i].click();
      return 'clicked: ' + t.slice(0,40);
    }
  }
  return 'no-settings-button';
})()`);
console.log('点击设置:', clickResult);
await sleep(1200);

// 若打开的是账号菜单，再点菜单里的"设置"，看设置面板的 z-index
const inMenu = await evalJs(`(function(){
  var menu = document.querySelector('[role="menu"]');
  if (!menu) return 'no-menu';
  var items = menu.querySelectorAll('[role="menuitem"],button,a,div');
  for (var i=0;i<items.length;i++){
    var t = (items[i].innerText||'').trim();
    if (t.indexOf('设置')>=0 || t.indexOf('Settings')>=0) { items[i].click(); return 'clicked-menu:' + t.slice(0,30); }
  }
  return 'no-settings-in-menu';
})()`);
console.log('菜单内点设置:', inMenu);
await sleep(1500);

// 看有没有弹层、它在哪、中心点命中谁
const state = await evalJs(`(function(){
  var out = { dialogs: [], hit: null, drawerZ: null };
  var d = document.querySelector('[class*="_sidebarCol"]');
  if (d) out.drawerZ = getComputedStyle(d).zIndex;
  var panels = document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="menu"],[class*="_mask_"]');
  Array.prototype.forEach.call(panels, function(p){
    var r = p.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    out.dialogs.push({ cls: String(p.className||'').slice(0,40), role: p.getAttribute('role')||'', rect: Math.round(r.left)+','+Math.round(r.top)+' '+Math.round(r.width)+'x'+Math.round(r.height), z: getComputedStyle(p).zIndex });
  });
  var dlg = document.querySelector('[role="menu"],[role="dialog"]');
  if (dlg) {
    var rr = dlg.getBoundingClientRect();
    var el = document.elementFromPoint(Math.round(rr.left + rr.width/2), Math.round(rr.top + rr.height/2));
    out.hit = el ? (el.tagName.toLowerCase()+'.'+String(el.className||'').slice(0,40)) : 'null';
    out.dialogCenter = Math.round(rr.left+rr.width/2)+','+Math.round(rr.top+rr.height/2);
  }
  return JSON.stringify(out, null, 1);
})()`);
console.log('弹层状态:', state);

ws.close();
edge.kill();
process.exit(0);
