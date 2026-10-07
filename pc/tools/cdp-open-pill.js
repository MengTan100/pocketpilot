// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:9568253b9a​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 点开底部"轮 N 步"按钮，分析弹出的面板结构，
// 重点看它有没有关闭入口（用户反馈：打开后没有原生的退出界面）。
(function () {
  var btns = document.querySelectorAll('button[aria-label]');
  var target = null;
  for (var i = 0; i < btns.length; i++) {
    var l = btns[i].getAttribute('aria-label') || '';
    if (/轮.*步/.test(l)) { target = btns[i]; break; }
  }
  if (!target) return JSON.stringify({ ok: false, note: '未找到"轮/步"按钮' });

  target.click();

  return new Promise(function (resolve) {
    setTimeout(function () {
      var out = { ok: true, 弹出的面板: [], 视口: window.innerWidth + 'x' + window.innerHeight };

      var sels = '[role="dialog"], [role="menu"], [role="tooltip"], [class*="popover"], [class*="Popover"], [class*="sheet"], [class*="Sheet"], [class*="drawer"]';
      var found = document.querySelectorAll(sels);

      Array.prototype.forEach.call(found, function (el) {
        var r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) return;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;

        var buttons = [];
        Array.prototype.forEach.call(el.querySelectorAll('button, [role="button"]'), function (b) {
          var br = b.getBoundingClientRect();
          buttons.push({
            aria: b.getAttribute('aria-label') || '',
            文本: (b.innerText || '').trim().slice(0, 24),
            类名: String(b.className).slice(0, 34),
            位置: Math.round(br.left) + ',' + Math.round(br.top) + ' ' + Math.round(br.width) + 'x' + Math.round(br.height)
          });
        });

        out.弹出的面板.push({
          类名: String(el.className).slice(0, 46),
          role: el.getAttribute('role') || '',
          位置: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
          文本: (el.innerText || '').trim().slice(0, 260),
          按钮: buttons.slice(0, 12)
        });
      });

      resolve(JSON.stringify(out, null, 1));
    }, 1000);
  });
})()
