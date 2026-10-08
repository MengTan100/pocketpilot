// SPDX-License-Identifier: MIT
// 彻底清除 App 注入进 DSH 页面的一切痕迹，并让页面重新渲染。
//
// 重点清理对象：
//   1. html[data-dsh-compact]  —— 我注入过这个标记，配套的 mobile_optimize.css
//      会把桌面侧栏改成"顶部横排导航"，直接导致侧栏里的会话列表消失。
//   2. 三个注入节点（样式表 / 旧按钮）
//   3. localStorage 里我写过的收起状态
//   4. dsh-rail-hidden 这个隐藏侧栏的 class
(function () {
  var root = document.documentElement;
  var report = { removed: [], attrs: [], keys: [] };

  // 1) 摘掉 compact 标记与隐藏标记
  ['data-dsh-compact', 'data-dsh-compact-mode'].forEach(function (attr) {
    if (root.hasAttribute(attr)) {
      report.attrs.push(attr + '=' + root.getAttribute(attr));
      root.removeAttribute(attr);
    }
  });
  root.classList.remove('dsh-rail-hidden');

  // 2) 移除注入节点
  ['__dshMobileOptimize', '__dshRailStyle', '__dshRailToggle'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
      report.removed.push(id);
    }
  });

  // 3) 清掉我写过的 localStorage 键
  try {
    Object.keys(localStorage).forEach(function (k) {
      if (/dshRail|dshCompact/i.test(k)) {
        localStorage.removeItem(k);
        report.keys.push(k);
      }
    });
  } catch (e) {}

  // 4) 复核：侧栏里的条目
  var side = document.querySelector('[class*="_sidebarCol"]');
  var items = [];
  if (side) {
    Array.prototype.slice.call(side.querySelectorAll('*')).forEach(function (e) {
      if (e.children.length === 0) {
        var t = (e.innerText || '').trim();
        if (t && t.length < 24) items.push(t);
      }
    });
  }

  return JSON.stringify({
    removed: report.removed,
    attrs: report.attrs,
    keys: report.keys,
    htmlClass: root.className,
    compactAttr: root.getAttribute('data-dsh-compact'),
    sidebarWidth: side ? Math.round(side.getBoundingClientRect().width) : -1,
    sidebarItems: items.slice(0, 20)
  });
})()
