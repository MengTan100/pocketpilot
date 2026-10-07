// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:ed57b8f116​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 证据：列出页面上所有 button[aria-label]，逐个检查我的判断逻辑会不会误命中。
(function () {
  var all = document.querySelectorAll('button[aria-label]');
  var rows = [];
  Array.prototype.forEach.call(all, function (b) {
    var lb = b.getAttribute('aria-label') || '';
    var r = b.getBoundingClientRect();
    rows.push({
      aria: lb,
      我的判断: lb === '添加文件或调用指令',
      是否可见: r.width > 0 && r.height > 0,
      位置: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
      类名: String(b.className).slice(0, 34)
    });
  });

  // 关键：输入框在不在 button 里面？（若在，closest 就会命中它，导致误判）
  var composer = document.querySelector('textarea')
    || document.querySelector('[contenteditable="true"]')
    || document.querySelector('[role="textbox"]');
  var composerInButton = composer ? !!composer.closest('button[aria-label]') : null;
  var composerButtonAria = composer && composer.closest('button[aria-label]')
    ? composer.closest('button[aria-label]').getAttribute('aria-label')
    : null;

  return JSON.stringify({
    总数: rows.length,
    会命中我判断的: rows.filter(function (x) { return x.我的判断; }).length,
    全部按钮: rows,
    输入框是否位于某个button内: composerInButton,
    若是则那个button的aria: composerButtonAria
  }, null, 2);
})()
