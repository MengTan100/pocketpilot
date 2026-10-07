// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:26d23977a3​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 验证「收起时把 56px 图标条也藏掉」的效果。
//
// 依据（来自上一步的实测证据）：
//   DSH 的布局容器是 [class*="_frame"]，状态属性 data-sidebar-collapsed，
//   它自己写的内联样式是 grid-template-columns: 56px minmax(0,1fr) minmax(0,0px)。
// 所以这里只覆盖"已收起"这一种情况下的第 1 列宽度，
// 第 3 列仍保持 DSH 的 minmax(0,0px)，不破坏它原有的折叠逻辑。
(function () {
  var STYLE_ID = '__dshRailBoost';
  var old = document.getElementById(STYLE_ID);
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    // 仅在收起态 + 我方开关打开时生效
    'html[data-rail-boost="1"] [class*="_frame"][data-sidebar-collapsed="true"] {',
    '  grid-template-columns: 0 minmax(0, 1fr) minmax(0, 0px) !important;',
    '}',
    // 图标条整体移出可视区，避免留下可点击的残影
    'html[data-rail-boost="1"] [class*="_frame"][data-sidebar-collapsed="true"] [class*="_sidebarCol"] {',
    '  transform: translateX(-100%) !important;',
    '  opacity: 0 !important;',
    '  pointer-events: none !important;',
    '}',
    // 对话列原本为图标条留的左内边距一并收掉，内容才真正顶到左边
    'html[data-rail-boost="1"] [class*="_frame"][data-sidebar-collapsed="true"] [class*="_centerCol"] {',
    '  padding-left: 0 !important;',
    '}',
  ].join('\n');
  document.head.appendChild(style);
  document.documentElement.setAttribute('data-rail-boost', '1');

  // 确保处于收起态：若当前是展开的，就点 DSH 自己的折叠按钮（用它的逻辑，不自己造状态）
  var frame = document.querySelector('[class*="_frame"]');
  var wasCollapsed = frame && frame.getAttribute('data-sidebar-collapsed') === 'true';
  if (!wasCollapsed) {
    var toggle = document.querySelector('[class*="_toggle"]');
    if (toggle) toggle.click();
  }

  return new Promise(function (resolve) {
    setTimeout(function () {
      var f = document.querySelector('[class*="_frame"]');
      var s = document.querySelector('[class*="_sidebarCol"]');
      var c = document.querySelector('[class*="_centerCol"]');
      var r = s ? s.getBoundingClientRect() : null;
      resolve(JSON.stringify({
        样式已注入: !!document.getElementById(STYLE_ID),
        开关: document.documentElement.getAttribute('data-rail-boost'),
        DSH收起状态: f ? f.getAttribute('data-sidebar-collapsed') : null,
        grid列: f ? window.getComputedStyle(f).gridTemplateColumns : null,
        侧栏布局宽: s ? Math.round(s.getBoundingClientRect().width) : -1,
        侧栏左边界: r ? Math.round(r.left) : null,
        对话列宽: c ? Math.round(c.getBoundingClientRect().width) : -1,
        对话列左边界: c ? Math.round(c.getBoundingClientRect().left) : null,
        视口宽: window.innerWidth
      }, null, 1));
    }, 1200);
  });
})()
