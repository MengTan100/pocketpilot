// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:4d2177f256​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 读取 DSH 侧栏折叠机制的完整证据（不猜测，只回报实际属性与计算样式）。
(function () {
  var out = {};

  // 1) 找到侧栏折叠按钮
  var btns = document.querySelectorAll('button, [role="button"]');
  var toggle = null;
  for (var i = 0; i < btns.length; i++) {
    var l = btns[i].getAttribute('aria-label') || '';
    if (l.indexOf('边栏') >= 0 || l.indexOf('侧栏') >= 0) { toggle = btns[i]; break; }
  }
  if (toggle) {
    out.toggle = {
      cls: toggle.className,
      label: toggle.getAttribute('aria-label'),
      html: toggle.outerHTML.slice(0, 240),
      parentCls: toggle.parentElement ? toggle.parentElement.className : null
    };
  } else {
    out.toggle = 'NOT FOUND';
  }

  // 2) 侧栏容器
  var side = document.querySelector('[class*="_sidebarCol"]');
  if (side) {
    out.sidebar = {
      cls: side.className,
      attrs: Array.prototype.slice.call(side.attributes).map(function (a) { return a.name + '=' + a.value; }),
      w: Math.round(side.getBoundingClientRect().width),
      styleAttr: side.getAttribute('style') || '(none)'
    };

    // 3) 它的父级（布局容器）—— DSH 自己的 grid/flex 定义
    var frame = side.parentElement;
    if (frame) {
      var cs = getComputedStyle(frame);
      out.frame = {
        cls: frame.className,
        display: cs.display,
        gridTemplateColumns: cs.gridTemplateColumns,
        gridAutoColumns: cs.gridAutoColumns,
        attrs: Array.prototype.slice.call(frame.attributes).map(function (a) { return a.name + '=' + a.value; }),
        children: Array.prototype.slice.call(frame.children).map(function (c) {
          return c.className + '(' + Math.round(c.getBoundingClientRect().width) + ')';
        })
      };
    }
  } else {
    out.sidebar = 'NOT FOUND';
  }

  // 4) 与侧栏/布局相关的 localStorage 键（DSH 自己的持久化状态）
  out.storageKeys = [];
  try {
    Object.keys(localStorage).forEach(function (k) {
      if (/sidebar|rail|layout|panel|view|window/i.test(k)) {
        out.storageKeys.push(k + ' = ' + String(localStorage.getItem(k)).slice(0, 90));
      }
    });
  } catch (e) {}

  // 5) 页面上有几个根级布局容器（确认结构）
  out.rootChildren = Array.prototype.slice.call(document.body.children).map(function (c) {
    var r = c.getBoundingClientRect();
    return c.tagName.toLowerCase() + '.' + String(c.className).slice(0, 30)
      + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
  });

  return JSON.stringify(out, null, 1);
})()
