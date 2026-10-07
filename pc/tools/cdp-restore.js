// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:388a4ea660​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 清除 App 注入到 DSH 页面里的一切内容，让页面回到 DSH 原生状态。
(function () {
  var root = document.documentElement;

  // 1) 解除侧栏隐藏
  root.classList.remove('dsh-rail-hidden');

  // 2) 清掉残留的注入节点
  var removed = [];
  ['__dshRailStyle', '__dshMobileOptimize', '__dshRailToggle'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
      removed.push(id);
    }
  });

  // 3) 把"记住的收起状态"也重置为展开
  try {
    localStorage.setItem('dshRailUserHiddenV2', '0');
    localStorage.setItem('dshRailUserHidden', '0');
    localStorage.setItem('dshRailHidden', '0');
  } catch (e) {}

  // 4) 复核实际宽度
  function widthOf(fragment) {
    var nodes = document.querySelectorAll('div');
    for (var i = 0; i < nodes.length; i++) {
      var cn = String(nodes[i].className || '');
      if (cn.indexOf(fragment) >= 0) {
        return Math.round(nodes[i].getBoundingClientRect().width);
      }
    }
    return -1;
  }

  return JSON.stringify({
    removed: removed,
    htmlClass: root.className,
    sidebarWidth: widthOf('_sidebarCol'),
    centerWidth: widthOf('_centerCol'),
    firstText: String(document.body.innerText || '').slice(0, 80)
  });
})()
