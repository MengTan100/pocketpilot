// SPDX-License-Identifier: MIT
// 诊断手机端侧栏的完整结构，找出"工作区 / 会话列表"藏在哪。
(function () {
  var out = {};
  out.viewport = window.innerWidth + 'x' + window.innerHeight;
  out.compact = document.documentElement.getAttribute('data-dsh-compact');

  function cls(el) {
    return String((el && el.className) || '').slice(0, 40);
  }

  // 1) 侧栏的直接子结构
  var side = document.querySelector('[class*="_sidebarCol"]');
  if (side) {
    out.sidebar = {
      cls: cls(side),
      w: Math.round(side.getBoundingClientRect().width),
      h: Math.round(side.getBoundingClientRect().height),
      children: Array.prototype.slice.call(side.children).map(function (c) {
        var r = c.getBoundingClientRect();
        return cls(c) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
      })
    };
    // 侧栏里所有可点元素的文案 + 标签
    out.buttons = Array.prototype.slice.call(
      side.querySelectorAll('button, a, [role="button"], [role="menuitem"], [tabindex]')
    ).map(function (b) {
      var r = b.getBoundingClientRect();
      return {
        cls: cls(b),
        role: b.getAttribute('role') || b.tagName.toLowerCase(),
        label: (b.getAttribute('aria-label') || b.getAttribute('title') || '').slice(0, 24),
        text: (b.innerText || '').trim().slice(0, 24),
        pos: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
        visible: r.width > 0 && r.height > 0
      };
    }).filter(function (b) { return b.visible; });
  } else {
    out.sidebar = 'NOT FOUND';
  }

  // 2) 整个页面里带 workspace / session / history 字样的容器
  out.candidates = [];
  Array.prototype.slice.call(document.querySelectorAll('div,aside,section,nav')).forEach(function (el) {
    var c = String(el.className || '');
    if (/workspace|session|history|conversation|recent|list/i.test(c)) {
      var r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 20) {
        out.candidates.push({
          cls: c.slice(0, 46),
          size: Math.round(r.width) + 'x' + Math.round(r.height),
          pos: Math.round(r.left) + ',' + Math.round(r.top),
          text: (el.innerText || '').trim().slice(0, 40)
        });
      }
    }
  });
  out.candidates = out.candidates.slice(0, 12);

  return JSON.stringify(out, null, 1);
})()
