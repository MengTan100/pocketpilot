// SPDX-License-Identifier: MIT
// 证据 3：找出真正的输入框（不是 textarea），并给出它的 CSS 坐标。
(function () {
  var out = {};
  out.已注入加号修复 = !!window.__dshPlusFix;
  out.记录器 = !!window.__REC;

  var cands = [];
  var sel = 'textarea, input[type=text], [contenteditable=""], [contenteditable=true], [role="textbox"]';
  var nodes = document.querySelectorAll(sel);
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) continue;
    cands.push({
      标签: el.tagName,
      role: el.getAttribute('role'),
      ce: el.getAttribute('contenteditable'),
      aria: el.getAttribute('aria-label'),
      ph: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 30),
      矩形: Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
        Math.round(r.width) + 'x' + Math.round(r.height),
      中心: [+(r.left + r.width / 2).toFixed(1), +(r.top + r.height / 2).toFixed(1)]
    });
  }
  out.可编辑候选 = cands;
  out.候选数 = cands.length;

  // 底部区域（y > 640）内所有可点元素，用来看输入区构成
  var bottom = document.querySelectorAll('button[aria-label], [role="textbox"], [contenteditable]');
  var bl = [];
  for (var j = 0; j < bottom.length; j++) {
    var rj = bottom[j].getBoundingClientRect();
    if (rj.top < 640 || rj.width < 10) continue;
    bl.push({
      标签: bottom[j].tagName,
      aria: bottom[j].getAttribute('aria-label'),
      ce: bottom[j].getAttribute('contenteditable'),
      矩形: Math.round(rj.left) + ',' + Math.round(rj.top) + ' ' +
        Math.round(rj.width) + 'x' + Math.round(rj.height),
      中心: [+(rj.left + rj.width / 2).toFixed(1), +(rj.top + rj.height / 2).toFixed(1)]
    });
  }
  out.底部区元素 = bl;
  return JSON.stringify(out, null, 1);
})()
