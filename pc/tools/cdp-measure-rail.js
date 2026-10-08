// SPDX-License-Identifier: MIT
// 测量侧栏折叠状态与各列实际宽度（用于验证开合是否真的生效）
(function () {
  var f = document.querySelector('[class*="_frame"]');
  var s = document.querySelector('[class*="_sidebarCol"]');
  var c = document.querySelector('[class*="_centerCol"]');
  return JSON.stringify({
    收起状态: f ? f.getAttribute('data-sidebar-collapsed') : null,
    grid列: f ? window.getComputedStyle(f).gridTemplateColumns : null,
    侧栏宽: s ? Math.round(s.getBoundingClientRect().width) : -1,
    对话宽: c ? Math.round(c.getBoundingClientRect().width) : -1,
    对话左边界: c ? Math.round(c.getBoundingClientRect().left) : null,
    视口宽: window.innerWidth
  });
})()
