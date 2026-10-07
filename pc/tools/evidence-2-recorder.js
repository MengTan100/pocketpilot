// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:a6cb8c021c​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 证据 2：纯只读记录器。只监听、只记录，绝不 dispatch / preventDefault / blur。
// 记录：每一次 click（以及我那条判定会不会命中）、每一次 pointerdown、
//       面板(listbox)出现与消失、焦点变化、aria-expanded 变化。
// 以「变化才记」的时间序列存在 window.__REC，便于按时间轴复盘。
(function () {
  if (window.__REC) { window.__REC.length = 0; return 'reset'; }
  var rec = [];
  window.__REC = rec;

  function now() { return Math.round(performance.now()); }

  function findPlus() {
    var all = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('aria-label') === '添加文件或调用指令') return all[i];
    }
    return null;
  }

  // —— 与 App 内注入的判定函数逐字一致，用来复现"命中/不命中"这个决定
  function isPlusButton(node) {
    if (!node || !node.closest) return false;
    var btn = node.closest('button[aria-label]');
    if (!btn) return false;
    var lb = btn.getAttribute('aria-label') || '';
    return lb === '添加文件或调用指令';
  }

  function describe(el) {
    if (!el) return '(null)';
    var tag = el.tagName || '?';
    var role = el.getAttribute && el.getAttribute('role');
    var lb = el.getAttribute && el.getAttribute('aria-label');
    var ce = el.getAttribute && el.getAttribute('contenteditable');
    var cls = (typeof el.className === 'string' ? el.className : '').slice(0, 24);
    return tag + (role ? '[role=' + role + ']' : '') + (ce ? '[ce=' + ce + ']' : '') +
      (lb ? '[aria=' + lb + ']' : '') + (cls ? '.' + cls : '');
  }

  // —— 面板状态快照
  function lbState() {
    var nodes = document.querySelectorAll('[role="listbox"]');
    var vis = 0, geo = '';
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 20) {
        vis++;
        if (!geo) geo = Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
          Math.round(r.width) + 'x' + Math.round(r.height);
      }
    }
    var p = findPlus();
    return {
      n: nodes.length, vis: vis, geo: geo,
      exp: p ? p.getAttribute('aria-expanded') : '(无+按钮)',
      ae: describe(document.activeElement),
      imeH: window.visualViewport ? Math.round(window.innerHeight - window.visualViewport.height) : -1
    };
  }

  // —— 轮询快照，变化才记
  var last = JSON.stringify(lbState());
  rec.push({ t: now(), k: '快照', v: JSON.parse(last) });
  setInterval(function () {
    var s = JSON.stringify(lbState());
    if (s !== last) {
      last = s;
      rec.push({ t: now(), k: '快照', v: JSON.parse(s) });
    }
  }, 40);

  // —— 指针按下（捕获阶段，页面最先知道）
  document.addEventListener('pointerdown', function (e) {
    rec.push({
      t: now(), k: 'pointerdown',
      目标: describe(e.target),
      判定命中加号: isPlusButton(e.target)
    });
  }, true);

  // —— 点击（捕获阶段）
  document.addEventListener('click', function (e) {
    rec.push({
      t: now(), k: 'click',
      目标: describe(e.target),
      判定命中加号: isPlusButton(e.target)
    });
  }, true);

  // —— 焦点
  document.addEventListener('focusin', function (e) {
    rec.push({ t: now(), k: 'focusin', 目标: describe(e.target) });
  }, true);
  document.addEventListener('focusout', function (e) {
    rec.push({ t: now(), k: 'focusout', 目标: describe(e.target) });
  }, true);

  return 'installed';
})()
