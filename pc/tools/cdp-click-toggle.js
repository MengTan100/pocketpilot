// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:f267720107​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 点击 DSH 自己的侧栏折叠按钮（用 aria-label 精确匹配，避免点到消息卡片里的其它 toggle）
(function () {
  var candidates = document.querySelectorAll('[class*="_toggle"]');
  for (var i = 0; i < candidates.length; i++) {
    var label = candidates[i].getAttribute('aria-label') || '';
    if (label.indexOf('边栏') >= 0 || label.indexOf('侧栏') >= 0) {
      candidates[i].click();
      return 'clicked:' + label;
    }
  }
  return 'not-found';
})()
