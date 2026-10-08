// SPDX-License-Identifier: MIT
// 返回底部关键元素的屏幕坐标（供 adb input tap 使用）。
(function () {
  var DPR = window.devicePixelRatio, OFF_Y = 152;
  function scr(el) {
    var r = el.getBoundingClientRect();
    return { cssX: +(r.left + r.width / 2).toFixed(1), cssY: +(r.top + r.height / 2).toFixed(1),
             sx: Math.round((r.left + r.width / 2) * DPR),
             sy: Math.round(OFF_Y + (r.top + r.height / 2) * DPR),
             矩形: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) };
  }
  var out = { innerH: window.innerHeight };
  var btns = document.querySelectorAll('button[aria-label]');
  for (var i = 0; i < btns.length; i++) {
    var lb = btns[i].getAttribute('aria-label') || '';
    if (lb === '添加文件或调用指令') out.加号 = scr(btns[i]);
    if (lb.indexOf('选择模型') === 0) out.模型选择器 = scr(btns[i]);
  }
  var ta = document.querySelector('[role="textbox"]');
  if (ta) out.输入框 = scr(ta);
  return JSON.stringify(out, null, 1);
})()
