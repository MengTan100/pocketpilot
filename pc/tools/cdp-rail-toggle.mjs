// SPDX-License-Identifier: MIT
/**
 * cdp-rail-toggle.mjs —— 复现「点侧栏开关没反应 / 只闪一下」。
 *
 * 做三件事：
 *   ① 打印当前侧栏相关 DOM 状态（frame 状态属性、sidebarCol 的 rect/transform/opacity、
 *      所有 aria-label 含"边栏/侧栏"的按钮及其坐标）；
 *   ② 用 Input.dispatchMouseEvent 在页面上**真实点击**那个按钮（不是 el.click()）；
 *   ③ 每 100ms 采样 2 秒，把 data-sidebar-collapsed / sidebar 状态 / 遮罩数量串成时间线。
 *
 * 用法: node cdp-rail-toggle.mjs <wsUrl> [点按的 x,y（可选，缺省点按钮中心）]
 */
const [, , wsUrl, pointArg] = process.argv;
if (!wsUrl) {
  console.error('用法: node cdp-rail-toggle.mjs ws://127.0.0.1:9333/devtools/page/XXXX [x,y]');
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
const errors = [];

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); }
    }, 10000);
  });
}

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    errors.push(String((d.exception && d.exception.description) || d.text || '').slice(0, 200));
  }
});

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res && res.exceptionDetails) return { error: String(res.exceptionDetails.text || 'eval error') };
  return res && res.result ? res.result.value : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_JS = `(function(){
  var root = document.documentElement;
  var frame = document.querySelector('[class*="_frame"]');
  var side = document.querySelector('[class*="_sidebarCol"]');
  var cs = side ? getComputedStyle(side) : null;
  var r = side ? side.getBoundingClientRect() : null;
  function label(el){ return (el.getAttribute('aria-label')||el.getAttribute('title')||'').slice(0,20); }
  var toggles = Array.prototype.map.call(document.querySelectorAll('[class*="_toggle"]'), function(el){
    var b = el.getBoundingClientRect();
    return label(el) + '@' + Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height);
  });
  var masks = Array.prototype.filter.call(document.querySelectorAll('div,aside,section'), function(el){
    var c = String(el.className||'');
    if (!/mask|overlay|backdrop|drawer|scrim/i.test(c)) return false;
    var b = el.getBoundingClientRect();
    return b.width > 60 && b.height > 60;
  }).map(function(el){
    var b = el.getBoundingClientRect();
    return String(el.className).slice(0,24) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height);
  }).slice(0,5);
  return JSON.stringify({
    collapsed: frame ? frame.getAttribute('data-sidebar-collapsed') : '(no-frame)',
    frameCls: frame ? String(frame.className).slice(0,30) : '',
    grid: frame ? getComputedStyle(frame).gridTemplateColumns : '',
    sideRect: r ? Math.round(r.left)+','+Math.round(r.top)+' '+Math.round(r.width)+'x'+Math.round(r.height) : 'none',
    sideTransform: cs ? cs.transform : '',
    sideOpacity: cs ? cs.opacity : '',
    sidePointer: cs ? cs.pointerEvents : '',
    toggles: toggles,
    masks: masks,
    compact: root.getAttribute('data-dsh-compact'),
    railBoost: root.getAttribute('data-rail-boost')
  }, null, 0);
})()`;

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');
    console.log('=== 点击前 ===');
    const before = await evaluate(STATE_JS);
    console.log(typeof before === 'string' ? before : JSON.stringify(before));

    let point = null;
    if (pointArg) {
      const [x, y] = pointArg.split(',').map(Number);
      point = { x, y, why: '命令行指定' };
    } else {
      const center = await evaluate(`(function(){
        var els = document.querySelectorAll('[class*="_toggle"]');
        for (var i=0;i<els.length;i++){
          var l = els[i].getAttribute('aria-label')||'';
          if (l.indexOf('边栏')>=0 || l.indexOf('侧栏')>=0){
            var b = els[i].getBoundingClientRect();
            return JSON.stringify({x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2), label:l});
          }
        }
        return JSON.stringify({});
      })()`);
      const parsed = typeof center === 'string' ? JSON.parse(center) : {};
      if (!parsed.x) { console.error('页面上找不到侧栏开关按钮'); process.exit(3); }
      point = { x: parsed.x, y: parsed.y, why: '按钮中心 ' + parsed.label };
    }
    console.log(`\n=== 在此点按: (${point.x},${point.y})  ${point.why} ===`);

    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
    }

    console.log('\n=== 点击后时间线（每 150ms） ===');
    for (let i = 0; i < 16; i++) {
      await sleep(150);
      const s = await evaluate(STATE_JS);
      let parsed = {};
      try { parsed = typeof s === 'string' ? JSON.parse(s) : (s || {}); } catch { /* 忽略 */ }
      console.log(`  +${String((i + 1) * 150).padStart(4)}ms  collapsed=${parsed.collapsed}  grid=[${parsed.grid}]  side=${parsed.sideRect}  tf=${parsed.sideTransform}  op=${parsed.sideOpacity}  masks=${(parsed.masks || []).length}`);
    }

    const after = await evaluate(STATE_JS);
    console.log('\n=== 点击后 ===');
    console.log(typeof after === 'string' ? after : JSON.stringify(after));
    if (errors.length) {
      console.log('\n=== 页面异常 ===');
      errors.slice(0, 5).forEach((e) => console.log('  ' + e));
    }
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('失败:', err.message);
    process.exit(1);
  }
});

ws.addEventListener('error', (err) => {
  console.error('WebSocket 错误:', err.message || err);
  process.exit(1);
});
