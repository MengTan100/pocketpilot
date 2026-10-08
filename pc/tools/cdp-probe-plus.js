// SPDX-License-Identifier: MIT
// 点开「+」，把它面板里的每一项都列出来（文案 + 标签 + 是否 file input），
// 用来判断"上传文件"到底走的是哪条路径，而不是靠猜。
(function () {
  function findPlus() {
    var b = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < b.length; i++) {
      var lb = b[i].getAttribute('aria-label') || '';
      if (/添加文件|调用指令/.test(lb)) return b[i];
    }
    return null;
  }

  var plus = findPlus();
  if (!plus) return JSON.stringify({ ok: false, note: '未找到「+」按钮' });

  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
    var Ev = t.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
    plus.dispatchEvent(new Ev(t, { bubbles: true, cancelable: true, view: window }));
  });

  return new Promise(function (resolve) {
    setTimeout(function () {
      var out = { 按钮aria: plus.getAttribute('aria-label'), 面板: [], fileInputs: [] };

      // 1) 页面上所有 file input（含隐藏的）
      Array.prototype.forEach.call(document.querySelectorAll('input[type=file]'), function (f) {
        var r = f.getBoundingClientRect();
        out.fileInputs.push({
          accept: f.getAttribute('accept') || '(无)',
          multiple: !!f.multiple,
          hidden: r.width === 0 && r.height === 0,
          在面板内: !!(f.closest('[role="dialog"],[role="menu"],[class*="popover"]'))
        });
      });

      // 2) 面板内的可见项
      var sels = ['[role="dialog"]', '[role="menu"]', '[class*="popover"]', '[class*="Popover"]', '[class*="sheet"]'];
      var seen = new Set();
      sels.forEach(function (s) {
        Array.prototype.forEach.call(document.querySelectorAll(s), function (el) {
          var r = el.getBoundingClientRect();
          if (r.width < 60 || r.height < 30) return;
          if (seen.has(el)) return;
          seen.add(el);

          var items = [];
          Array.prototype.forEach.call(el.querySelectorAll('button, [role="menuitem"], [role="option"], label, a'), function (it) {
            var ir = it.getBoundingClientRect();
            if (ir.width < 20 || ir.height < 10) return;
            items.push({
              标签: it.tagName.toLowerCase(),
              aria: it.getAttribute('aria-label') || '',
              文本: (it.innerText || '').trim().slice(0, 26),
              类名: String(it.className).slice(0, 30)
            });
          });

          out.面板.push({
            类名: String(el.className).slice(0, 44),
            role: el.getAttribute('role') || '',
            尺寸: Math.round(r.width) + 'x' + Math.round(r.height),
            位置: Math.round(r.left) + ',' + Math.round(r.top),
            文本: (el.innerText || '').trim().slice(0, 300),
            项: items.slice(0, 14)
          });
        });
      });

      resolve(JSON.stringify(out, null, 1));
    }, 900);
  });
})()
