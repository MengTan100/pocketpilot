// SPDX-License-Identifier: MIT
// 证据 7：完整 dump 加号面板的结构与样式，判断"只剩一排指令"是内容缺失还是被 CSS 隐藏。
(function () {
  var out = { innerH: window.innerHeight };
  var nodes = document.querySelectorAll('[role="listbox"]');
  out.listbox总数 = nodes.length;
  out.面板 = [];
  for (var i = 0; i < nodes.length; i++) {
    var lb = nodes[i];
    var r = lb.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;
    var cs = getComputedStyle(lb);
    var panel = {
      矩形: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
      scrollH: lb.scrollHeight,
      clientH: lb.clientHeight,
      overflow: cs.overflow,
      overflowY: cs.overflowY,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      // 直接子元素结构
      子元素: Array.prototype.map.call(lb.children, function (ch) {
        var c = getComputedStyle(ch);
        var cr = ch.getBoundingClientRect();
        return {
          标签: ch.tagName,
          role: ch.getAttribute('role'),
          cls: (typeof ch.className === 'string' ? ch.className : '').slice(0, 30),
          文本: (ch.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
          display: c.display,
          可见性: c.display !== 'none' && c.visibility !== 'hidden' && cr.height > 0,
          矩形: Math.round(cr.left) + ',' + Math.round(cr.top) + ' ' + Math.round(cr.width) + 'x' + Math.round(cr.height)
        };
      }),
      // 面板内所有可见文本（递归 innerText 已含，这里给结构化版本）
      全文: (lb.innerText || '').replace(/\s+/g, ' ').slice(0, 600)
    };
    out.面板.push(panel);
  }
  return JSON.stringify(out, null, 1);
})()
