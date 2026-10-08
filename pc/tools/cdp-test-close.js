// SPDX-License-Identifier: MIT
// 测试关闭"会话统计"这类 dialog 面板的可行方式。
// 依次尝试：ESC 键 → 点击遮罩 → 点击面板外部，看哪种能真正关掉。
(function () {
  function panel() {
    return document.querySelector('[role="dialog"][class*="_panel"]');
  }
  if (!panel()) return JSON.stringify({ ok: false, note: '当前没有打开的面板' });

  var results = {};

  // 方式 1：ESC
  ['keydown', 'keyup'].forEach(function (type) {
    document.dispatchEvent(new KeyboardEvent(type, {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
    }));
  });
  results.尝试了ESC = true;

  return new Promise(function (resolve) {
    setTimeout(function () {
      results.ESC后仍在 = !!panel();

      if (!panel()) {
        results.结论 = 'ESC 可关闭 ✅';
        resolve(JSON.stringify(results, null, 1));
        return;
      }

      // 方式 2：点击遮罩（面板的父容器）
      var p = panel();
      var overlay = p.parentElement;
      results.遮罩类名 = overlay ? String(overlay.className).slice(0, 50) : '(无)';
      if (overlay) {
        var r = overlay.getBoundingClientRect();
        results.遮罩位置 = Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
        // 点遮罩左上角（面板外）
        var ev = new MouseEvent('click', {
          bubbles: true, cancelable: true,
          clientX: Math.max(2, r.left + 2), clientY: Math.max(2, r.top + 2)
        });
        overlay.dispatchEvent(ev);
      }

      setTimeout(function () {
        results.点遮罩后仍在 = !!panel();
        results.结论 = panel() ? 'ESC 与点遮罩都无效，需要自行加关闭按钮' : '点遮罩可关闭 ✅';
        resolve(JSON.stringify(results, null, 1));
      }, 600);
    }, 600);
  });
})()
