// SPDX-License-Identifier: MIT
// 证据 5：键盘弹起时，量清楚视口、输入框、面板三者的真实几何，判断面板是否被遮挡。
(function () {
  var out = {};
  out.innerH = window.innerHeight;
  out.innerW = window.innerWidth;
  out.vvH = window.visualViewport ? +window.visualViewport.height.toFixed(1) : -1;
  out.vvTop = window.visualViewport ? +window.visualViewport.offsetTop.toFixed(1) : -1;
  out.文档高 = document.documentElement.clientHeight;

  var ta = document.querySelector('[role="textbox"]');
  if (ta) {
    var r = ta.getBoundingClientRect();
    out.输入框 = Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
      Math.round(r.width) + 'x' + Math.round(r.height);
    out.输入框底 = Math.round(r.bottom);
  } else { out.输入框 = '(无)'; }

  var nodes = document.querySelectorAll('[role="listbox"]');
  out.面板 = [];
  for (var i = 0; i < nodes.length; i++) {
    var b = nodes[i].getBoundingClientRect();
    if (b.width < 40 || b.height < 20) continue;
    out.面板.push({
      矩形: Math.round(b.left) + ',' + Math.round(b.top) + ' ' +
        Math.round(b.width) + 'x' + Math.round(b.height),
      上边: Math.round(b.top),
      下边: Math.round(b.bottom),
      是否完整在视口内: b.top >= 0 && b.bottom <= window.innerHeight,
      // 面板内部有多少条目（用来判断内容是否完整）
      条目数: nodes[i].querySelectorAll('[role="option"], li, [role="menuitem"]').length,
      文本前120字: (nodes[i].innerText || '').replace(/\s+/g, ' ').slice(0, 120)
    });
  }
  // 键盘从底部顶起来的高度（CSS px）
  out.推断键盘高度 = Math.round(759 - window.innerHeight);
  return JSON.stringify(out, null, 1);
})()
