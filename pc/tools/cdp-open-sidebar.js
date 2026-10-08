// SPDX-License-Identifier: MIT
// 点击 DSH 自己的「打开侧边栏」按钮，把真正的侧栏（工作区 + 会话列表）展开，
// 然后回报侧栏里出现了哪些条目。用来验证会话列表究竟能不能显示。
(function () {
  var result = { clicked: [], sidebarBefore: 0 };

  function findByLabel(text) {
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var label = (el.getAttribute('aria-label') || el.getAttribute('title') || '');
      if (label.indexOf(text) >= 0) return el;
    }
    return null;
  }

  function sidebarWidth() {
    var s = document.querySelector('[class*="_sidebarCol"]');
    return s ? Math.round(s.getBoundingClientRect().width) : -1;
  }

  function sidebarTexts() {
    var s = document.querySelector('[class*="_sidebarCol"]');
    if (!s) return [];
    var seen = [];
    Array.prototype.slice.call(s.querySelectorAll('*')).forEach(function (e) {
      if (e.children.length === 0) {
        var t = (e.innerText || '').trim();
        if (t && t.length < 30 && seen.indexOf(t) < 0) seen.push(t);
      }
    });
    return seen.slice(0, 30);
  }

  result.sidebarBefore = sidebarWidth();

  var btn = findByLabel('打开侧边栏') || findByLabel('打开侧栏') || findByLabel('展开');
  if (btn) {
    btn.click();
    result.clicked.push('打开侧边栏');
  } else {
    result.clicked.push('未找到按钮');
  }

  return JSON.stringify({
    clicked: result.clicked,
    widthBefore: result.sidebarBefore,
    widthAfter: sidebarWidth(),
    itemsAfter: sidebarTexts()
  }, null, 1);
})()
