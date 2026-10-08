// SPDX-License-Identifier: MIT
// 证据 6：返回「+」按钮此刻应该在**屏幕**上点哪里（动态坐标，随键盘引起的布局位移自适应）。
// 换算：屏幕x = cssX * dpr；屏幕y = 152 + cssY * dpr（152 为 WebView 在屏幕上的顶部偏移，已实测验证）
(function () {
  var dpr = window.devicePixelRatio;
  var OFF_Y = 152;
  function centerOf(el) {
    var r = el.getBoundingClientRect();
    return {
      cssX: +(r.left + r.width / 2).toFixed(1),
      cssY: +(r.top + r.height / 2).toFixed(1),
      sx: Math.round((r.left + r.width / 2) * dpr),
      sy: Math.round(OFF_Y + (r.top + r.height / 2) * dpr),
      矩形: Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
        Math.round(r.width) + 'x' + Math.round(r.height)
    };
  }
  var out = { innerH: window.innerHeight, dpr: dpr };

  var all = document.querySelectorAll('button[aria-label]');
  for (var i = 0; i < all.length; i++) {
    if (all[i].getAttribute('aria-label') === '添加文件或调用指令') {
      out.加号 = centerOf(all[i]);
      break;
    }
  }
  // 会话正文区域（面板外）中心，用来测"点外面能否关闭"
  var main = document.querySelector('main') || document.querySelector('[role="main"]');
  if (main) {
    var mr = main.getBoundingClientRect();
    out.会话区 = {
      cssX: +(mr.left + mr.width / 2).toFixed(1),
      cssY: +(mr.top + Math.min(120, mr.height / 3)).toFixed(1)
    };
    out.会话区.sx = Math.round(out.会话区.cssX * dpr);
    out.会话区.sy = Math.round(OFF_Y + out.会话区.cssY * dpr);
  }
  // 面板
  var nodes = document.querySelectorAll('[role="listbox"]');
  out.面板开 = false;
  for (var j = 0; j < nodes.length; j++) {
    var b = nodes[j].getBoundingClientRect();
    if (b.width > 40 && b.height > 20) { out.面板开 = true; break; }
  }
  return JSON.stringify(out);
})()
