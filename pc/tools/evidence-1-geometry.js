// SPDX-License-Identifier: MIT
// 证据 1：量出 CSS 像素 → 屏幕物理像素的换算关系，供 adb input tap 使用。
(function () {
  var out = {};
  out.dpr = window.devicePixelRatio;
  out.innerW = window.innerWidth;
  out.innerH = window.innerHeight;
  out.outerW = window.outerWidth;
  out.outerH = window.outerHeight;
  out.docClientW = document.documentElement.clientWidth;
  out.docClientH = document.documentElement.clientHeight;
  out.screenW = window.screen.width;
  out.screenH = window.screen.height;
  out.availW = window.screen.availWidth;
  out.availH = window.screen.availHeight;
  if (window.visualViewport) {
    out.vv = {
      width: window.visualViewport.width,
      height: window.visualViewport.height,
      scale: window.visualViewport.scale,
      offsetLeft: window.visualViewport.offsetLeft,
      offsetTop: window.visualViewport.offsetTop,
      pageLeft: window.visualViewport.pageLeft,
      pageTop: window.visualViewport.pageTop
    };
  }
  var meta = document.querySelector('meta[name="viewport"]');
  out.viewportMeta = meta ? meta.getAttribute('content') : '(无)';

  // 「+」按钮的 CSS 坐标
  var btns = document.querySelectorAll('button[aria-label]');
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].getAttribute('aria-label') === '添加文件或调用指令') {
      var r = btns[i].getBoundingClientRect();
      out.plusRect = {
        left: +r.left.toFixed(2), top: +r.top.toFixed(2),
        width: +r.width.toFixed(2), height: +r.height.toFixed(2),
        cx: +(r.left + r.width / 2).toFixed(2), cy: +(r.top + r.height / 2).toFixed(2)
      };
      break;
    }
  }
  // 输入框的 CSS 坐标（用来测误判）
  var ta = document.querySelector('textarea');
  if (ta) {
    var t = ta.getBoundingClientRect();
    out.composerRect = {
      left: +t.left.toFixed(2), top: +t.top.toFixed(2),
      width: +t.width.toFixed(2), height: +t.height.toFixed(2),
      cx: +(t.left + t.width / 2).toFixed(2), cy: +(t.top + t.height / 2).toFixed(2)
    };
  }
  return JSON.stringify(out, null, 1);
})()
