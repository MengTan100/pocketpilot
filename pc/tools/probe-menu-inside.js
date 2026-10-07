// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:eadf85dc75​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 证据：dump 当前打开的模型菜单结构，找出"搜索"元素到底是什么。
(function () {
  var out = {};
  var menus = document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"]');
  out.浮层 = [];
  for (var i = 0; i < menus.length; i++) {
    var m = menus[i];
    var r = m.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) continue;
    var inputs = [];
    var all = m.querySelectorAll('input, textarea, [contenteditable], [role="searchbox"], [role="textbox"], [role="combobox"]');
    for (var k = 0; k < all.length; k++) {
      var e = all[k];
      var rr = e.getBoundingClientRect();
      inputs.push({
        标签: e.tagName,
        role: e.getAttribute('role'),
        type: e.getAttribute('type'),
        ce: e.getAttribute('contenteditable'),
        ph: e.getAttribute('placeholder'),
        aria: e.getAttribute('aria-label'),
        cls: (typeof e.className === 'string' ? e.className : '').slice(0, 34),
        矩形: Math.round(rr.left) + ',' + Math.round(rr.top) + ' ' + Math.round(rr.width) + 'x' + Math.round(rr.height),
        可见: rr.height > 0 && getComputedStyle(e).display !== 'none'
      });
    }
    // 所有含"搜索"字样的元素
    var searchy = [];
    var every = m.querySelectorAll('*');
    for (var q = 0; q < every.length; q++) {
      var t = (every[q].textContent || '');
      var pl = every[q].getAttribute && every[q].getAttribute('placeholder');
      if ((t.indexOf('搜索') >= 0 && every[q].children.length === 0) || (pl && pl.indexOf('搜索') >= 0)) {
        var rq = every[q].getBoundingClientRect();
        searchy.push({
          标签: every[q].tagName,
          role: every[q].getAttribute && every[q].getAttribute('role'),
          ph: pl,
          text: t.replace(/\s+/g, ' ').slice(0, 30),
          矩形: Math.round(rq.left) + ',' + Math.round(rq.top) + ' ' + Math.round(rq.width) + 'x' + Math.round(rq.height)
        });
        if (searchy.length >= 6) break;
      }
    }
    out.浮层.push({
      sel: menus[i].getAttribute('role'),
      cls: (typeof m.className === 'string' ? m.className : '').slice(0, 30),
      矩形: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
      内部可编辑元素: inputs,
      含搜索字样: searchy,
      文本前200: (m.innerText || '').replace(/\s+/g, ' ').slice(0, 200)
    });
  }
  // 全文档范围内的可编辑元素（也许搜索框不在 menu 内）
  out.全文档可编辑 = [];
  var g = document.querySelectorAll('input, textarea, [role="searchbox"], [contenteditable="true"]');
  for (var z = 0; z < g.length; z++) {
    var rg = g[z].getBoundingClientRect();
    if (rg.width < 10) continue;
    out.全文档可编辑.push({
      标签: g[z].tagName, role: g[z].getAttribute('role'),
      ph: g[z].getAttribute('placeholder') || g[z].getAttribute('aria-label'),
      cls: (typeof g[z].className === 'string' ? g[z].className : '').slice(0, 34),
      矩形: Math.round(rg.left) + ',' + Math.round(rg.top) + ' ' + Math.round(rg.width) + 'x' + Math.round(rg.height)
    });
  }
  return JSON.stringify(out, null, 1);
})()
