// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:17cb76ed91​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 验证"通用遮罩关闭"方案：不依赖固定坐标，
// 而是从 listbox 向上找覆盖全屏的遮罩层，然后点它的非 listbox 区域。
(function () {
  function visibleListbox() {
    var els = document.querySelectorAll('[role="listbox"]');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 20) return els[i];
    }
    return null;
  }

  function tap(el, x, y) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      var E = (t.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(t, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y
      }));
    });
  }

  function plusBtn() {
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      if (/添加文件|调用指令/.test(all[i].getAttribute('aria-label') || '')) return all[i];
    }
    return null;
  }

  /** 从 listbox 往上找"覆盖大部分视口"的遮罩层 */
  function findOverlay(lb) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var node = lb.parentElement;
    while (node && node !== document.body) {
      var r = node.getBoundingClientRect();
      var cs = getComputedStyle(node);
      if (r.width >= vw * 0.9 && r.height >= vh * 0.5
          && (cs.position === 'fixed' || cs.position === 'absolute')) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  var log = [];
  var btn = plusBtn();
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  return (async function () {
    if (!visibleListbox()) { tap(btn, 38, 706); await wait(800); }
    var lb = visibleListbox();
    log.push('面板状态        : ' + (lb ? '已打开' : '未打开'));
    if (!lb) return log.join('\n');

    var overlay = findOverlay(lb);
    log.push('找到遮罩层      : ' + (overlay ? String(overlay.className).slice(0, 40) : '(未找到)'));

    if (overlay) {
      // 点遮罩上"避开 listbox"的位置：取遮罩左上角内侧
      var r = overlay.getBoundingClientRect();
      var px = Math.max(4, r.left + 4);
      var py = Math.max(4, r.top + 4);
      // 确认这个点上不是 listbox
      var hit = document.elementFromPoint(px, py);
      log.push('目标点 ' + Math.round(px) + ',' + Math.round(py) + ' 命中: '
        + (hit ? String(hit.className).slice(0, 30) : 'null'));
      tap(overlay, px, py);
      await wait(800);
      log.push('点遮罩后        : ' + (visibleListbox() ? '仍打开 ❌' : '已关闭 ✅'));
    }

    return log.join('\n');
  })();
})()
