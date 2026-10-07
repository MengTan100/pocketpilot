// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:8cd0075dda​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 基线检查
JSON.stringify({
  面板开: (function () {
    var n = document.querySelectorAll('[role="listbox"]');
    for (var i = 0; i < n.length; i++) {
      var r = n[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 20) return true;
    }
    return false;
  })(),
  innerH: window.innerHeight,
  焦点: (document.activeElement && document.activeElement.tagName) || '?'
})
