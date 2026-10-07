// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:c1f02d7b18​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 逐种方式测试能否关闭「+」弹出的 listbox 面板。
// 依次尝试：ESC → 点击面板外部 → 再次点击触发按钮。
(function () {
  function visibleListbox() {
    var els = document.querySelectorAll('[role="listbox"]');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 20) return els[i];
    }
    return null;
  }

  function plusBtn() {
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      if (/添加文件|调用指令/.test(all[i].getAttribute('aria-label') || '')) return all[i];
    }
    return null;
  }

  function tap(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      var E = (t.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(t, { bubbles: true, cancelable: true, view: window }));
    });
  }

  function esc() {
    ['keydown', 'keyup'].forEach(function (t) {
      [document, window].forEach(function (target) {
        target.dispatchEvent(new KeyboardEvent(t, {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
          bubbles: true, cancelable: true
        }));
      });
    });
  }

  var log = [];
  var btn = plusBtn();
  if (!btn) return '未找到「+」';

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  return (async function () {
    // 先确保是打开的
    if (!visibleListbox()) { tap(btn); await wait(800); }
    log.push('起始状态         : ' + (visibleListbox() ? '已打开' : '未打开'));

    // 方式 1：ESC
    esc(); await wait(700);
    log.push('① 发 ESC 之后     : ' + (visibleListbox() ? '仍打开 ❌' : '已关闭 ✅'));

    // 方式 2：点面板外部（页面空白处）
    if (visibleListbox()) {
      var blank = document.elementFromPoint(200, 300) || document.body;
      tap(blank); await wait(700);
      log.push('② 点面板外空白处  : ' + (visibleListbox() ? '仍打开 ❌' : '已关闭 ✅'));
    }

    // 方式 3：点页面根/遮罩
    if (visibleListbox()) {
      var overlay = document.elementFromPoint(6, 400) || document.body;
      tap(overlay); await wait(700);
      log.push('③ 点左边缘遮罩    : ' + (visibleListbox() ? '仍打开 ❌' : '已关闭 ✅'));
    }

    // 方式 4：再点触发按钮（用原生事件序列）
    if (visibleListbox()) {
      tap(btn); await wait(700);
      log.push('④ 再点「+」       : ' + (visibleListbox() ? '仍打开 ❌' : '已关闭 ✅'));
    }

    return log.join('\n');
  })();
})()
