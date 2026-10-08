// SPDX-License-Identifier: MIT
// 证据：模型选择器按钮的属性 + 模型面板结构 + 搜索框。
(function () {
  var out = {};

  // 1) 所有带 aria-haspopup 的按钮
  var hs = [];
  var all = document.querySelectorAll('[aria-haspopup]');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    hs.push({
      标签: el.tagName,
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      haspopup: el.getAttribute('aria-haspopup'),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 30)
    });
  }
  out.带haspopup的元素 = hs;

  // 2) 模型选择器按钮
  var btns = document.querySelectorAll('button[aria-label]');
  out.模型按钮 = [];
  for (var j = 0; j < btns.length; j++) {
    var lb = btns[j].getAttribute('aria-label') || '';
    if (lb.indexOf('选择模型') >= 0 || lb.indexOf('模型') >= 0) {
      out.模型按钮.push({
        aria: lb,
        haspopup: btns[j].getAttribute('aria-haspopup'),
        cls: (typeof btns[j].className === 'string' ? btns[j].className : '').slice(0, 30)
      });
    }
  }

  // 3) 各种可编辑元素（用于"点了才允许弹键盘"的判定）
  var editables = [];
  var sel = 'input, textarea, [contenteditable="true"], [contenteditable=""], [role="searchbox"], [role="textbox"]';
  var eds = document.querySelectorAll(sel);
  for (var k = 0; k < eds.length; k++) {
    var r = eds[k].getBoundingClientRect();
    if (r.width < 10) continue;
    editables.push({
      标签: eds[k].tagName,
      role: eds[k].getAttribute('role'),
      type: eds[k].getAttribute('type'),
      ce: eds[k].getAttribute('contenteditable'),
      ph: eds[k].getAttribute('placeholder') || eds[k].getAttribute('aria-label'),
      cls: (typeof eds[k].className === 'string' ? eds[k].className : '').slice(0, 30),
      可见: r.height > 0
    });
  }
  out.可编辑元素 = editables;

  // 4) 当前是否有浮层容器（menu/dialog/listbox）
  out.浮层 += '';
  out.浮层容器 = [];
  ['[role="menu"]', '[role="dialog"]', '[role="listbox"]', '[role="list"]'].forEach(function (s) {
    var ns = document.querySelectorAll(s);
    for (var m = 0; m < ns.length; m++) {
      var rr = ns[m].getBoundingClientRect();
      if (rr.width < 40 || rr.height < 20) continue;
      out.浮层容器.push({
        sel: s,
        矩形: Math.round(rr.left) + ',' + Math.round(rr.top) + ' ' + Math.round(rr.width) + 'x' + Math.round(rr.height),
        含搜索框: !!ns[m].querySelector('input, [role="searchbox"]')
      });
    }
  });

  return JSON.stringify(out, null, 1);
})()
