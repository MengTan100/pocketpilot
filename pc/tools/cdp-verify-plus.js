// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:4f8a392fd0​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 验证「+」按钮在**不受任何注入干预**时的原生开合行为。
// 判据用它自己的 aria-expanded，以及页面里 role=listbox 的数量。
(function () {
  var btn = null;
  var all = document.querySelectorAll('button');
  for (var i = 0; i < all.length; i++) {
    if (/添加文件|调用指令/.test(all[i].getAttribute('aria-label') || '')) { btn = all[i]; break; }
  }
  if (!btn) return '未找到「+」按钮';

  function state() {
    return {
      expanded: btn.getAttribute('aria-expanded'),
      listbox数: document.querySelectorAll('[role="listbox"]').length,
      可见listbox: Array.prototype.filter.call(
        document.querySelectorAll('[role="listbox"]'),
        function (el) { var r = el.getBoundingClientRect(); return r.width > 40 && r.height > 20; }
      ).length
    };
  }

  function tap(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      var E = (t.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(t, { bubbles: true, cancelable: true, view: window }));
    });
  }

  var log = [];
  log.push('初始   : ' + JSON.stringify(state()));

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  return (async function () {
    // 用真实坐标点击（比合成事件更接近用户操作）
    var r = btn.getBoundingClientRect();
    tap(btn);
    await wait(900);
    log.push('点第1次: ' + JSON.stringify(state()));

    tap(btn);
    await wait(900);
    log.push('点第2次: ' + JSON.stringify(state()));

    tap(btn);
    await wait(900);
    log.push('点第3次: ' + JSON.stringify(state()));

    return log.join('\n');
  })();
})()
