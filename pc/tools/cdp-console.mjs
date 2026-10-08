// SPDX-License-Identifier: MIT
/**
 * 抓取页面控制台错误：连接 CDP，开启 Runtime/Log 域，重载页面，
 * 收集期间的 console 错误与未捕获异常。
 *
 * 用法: node cdp-console.mjs <wsUrl> [等待毫秒]
 *
 * 用途：会话列表"数据有、界面没有"这种情况，八成是前端 JS 报错，
 * 而报错只在控制台里。
 */
const wsUrl = process.argv[2];
const waitMs = Number(process.argv[3] || 18000);

if (!wsUrl) {
  console.error('用法: node cdp-console.mjs <wsUrl> [等待毫秒]');
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
const logs = [];

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

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
    return;
  }

  // 控制台消息
  if (msg.method === 'Runtime.consoleAPICalled') {
    const p = msg.params;
    const text = (p.args || []).map((a) => {
      if (a.value !== undefined) return String(a.value);
      if (a.description) return a.description;
      return a.type;
    }).join(' ');
    if (p.type === 'error' || p.type === 'warning') {
      logs.push('[' + p.type + '] ' + text.slice(0, 400));
    }
  }

  // 未捕获异常
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    const desc = (d.exception && d.exception.description) || d.text || '';
    logs.push('[exception] ' + String(desc).slice(0, 400));
  }

  // 网络失败
  if (msg.method === 'Network.loadingFailed') {
    const p = msg.params || {};
    logs.push('[net-fail] ' + (p.errorText || '') + ' ' + (p.type || ''));
  }
});

ws.addEventListener('error', () => { console.error('WebSocket 错误'); process.exit(1); });

ws.addEventListener('open', async () => {
  await send('Runtime.enable', {});
  await send('Log.enable', {}).catch(() => {});
  await send('Network.enable', {}).catch(() => {});

  // 重载，让错误重新发生
  await send('Page.enable', {}).catch(() => {});
  await send('Page.reload', { ignoreCache: false }).catch(async () => {
    await send('Runtime.evaluate', { expression: 'location.reload()' });
  });

  await new Promise((r) => setTimeout(r, waitMs));

  // 顺带看看侧栏渲染后的条目
  const probe = await send('Runtime.evaluate', {
    expression: `(function(){
      var s=document.querySelector('[class*="_sidebarCol"]');
      var items=[];
      if(s){Array.prototype.slice.call(s.querySelectorAll('*')).forEach(function(e){
        if(e.children.length===0){var t=(e.innerText||'').trim(); if(t&&t.length<30&&items.indexOf(t)<0)items.push(t);}});}
      return JSON.stringify({sidebarW:s?Math.round(s.getBoundingClientRect().width):-1,items:items.slice(0,25)});
    })()`,
    returnByValue: true,
  });
  const v = probe.result && probe.result.result ? probe.result.result.value : '';

  console.log('=== 侧栏现状 ===');
  console.log(typeof v === 'string' ? v : JSON.stringify(v));
  console.log('\n=== 控制台错误/警告 (' + logs.length + ' 条) ===');
  const uniq = [];
  logs.forEach((l) => { if (uniq.indexOf(l) < 0) uniq.push(l); });
  uniq.slice(0, 30).forEach((l) => console.log('  ' + l));

  ws.close();
  process.exit(0);
});
