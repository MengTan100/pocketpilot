// SPDX-License-Identifier: MIT
// 聚焦 DSH 的输入框（模拟用户点进去），并回报输入框与视口的位置关系，
// 用来判断软键盘弹起后输入区是否会被遮住。
(function () {
  var el = document.querySelector('textarea')
    || document.querySelector('[contenteditable="true"]')
    || document.querySelector('[role="textbox"]');

  if (!el) {
    return JSON.stringify({ found: false, note: '页面里没找到输入框' });
  }

  el.focus();
  // 有些实现需要真实点击才会唤起键盘
  try { el.click(); } catch (e) {}

  var r = el.getBoundingClientRect();
  var vv = window.visualViewport;
  return JSON.stringify({
    found: true,
    tag: el.tagName.toLowerCase(),
    输入框: {
      上边: Math.round(r.top),
      下边: Math.round(r.bottom),
      高度: Math.round(r.height)
    },
    窗口: {
      innerHeight: window.innerHeight,
      可视高度: vv ? Math.round(vv.height) : null,
      可视偏移: vv ? Math.round(vv.offsetTop) : null
    },
    被遮挡: vv ? (r.bottom > vv.height + vv.offsetTop) : null
  }, null, 1);
})()
