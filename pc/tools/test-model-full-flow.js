// SPDX-License-Identifier: MIT
// 复现完整流程：点模型选择器 → 点菜单里的「模型」→ 出现的列表里找搜索框。
(function () {
  function findModelBtn() {
    var all = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < all.length; i++) {
      if ((all[i].getAttribute('aria-label') || '').indexOf('选择模型') === 0) return all[i];
    }
    return null;
  }
  function visibleSurface() {
    var sels = ['[role="menu"]', '[role="listbox"]', '[role="dialog"]'];
    var found = [];
    for (var s = 0; s < sels.length; s++) {
      var ns = document.querySelectorAll(sels[s]);
      for (var i = 0; i < ns.length; i++) {
        var r = ns[i].getBoundingClientRect();
        if (r.width > 60 && r.height > 30) {
          found.push({ sel: sels[s], cls: (typeof ns[i].className === 'string' ? ns[i].className : '').slice(0, 26),
            矩形: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) });
        }
      }
    }
    return found;
  }
  function findEditable() {
    var out = [];
    var g = document.querySelectorAll('input, textarea, [role="searchbox"], [contenteditable="true"], [role="textbox"]');
    for (var z = 0; z < g.length; z++) {
      var rg = g[z].getBoundingClientRect();
      if (rg.width < 10) continue;
      out.push({
        标签: g[z].tagName, role: g[z].getAttribute('role'),
        ph: g[z].getAttribute('placeholder') || g[z].getAttribute('aria-label'),
        cls: (typeof g[z].className === 'string' ? g[z].className : '').slice(0, 30),
        矩形: Math.round(rg.left) + ',' + Math.round(rg.top) + ' ' + Math.round(rg.width) + 'x' + Math.round(rg.height)
      });
    }
    return out;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var DPR = 3.25, OFF_Y = 152;
  var log = [];

  return (async function () {
    var btn = findModelBtn();
    if (!btn) return JSON.stringify({ 错误: '未找到模型按钮' });
    var r0 = btn.getBoundingClientRect();
    try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2 })); } catch (e) {}
    btn.click();
    await wait(700);
    log.push({ 步骤: '点模型选择器后', innerH: window.innerHeight, 浮层: visibleSurface(), 可编辑: findEditable() });

    // 点菜单里的「模型」项
    var cands = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button');
    var target = null;
    for (var i = 0; i < cands.length; i++) {
      var r = cands[i].getBoundingClientRect();
      if (r.width < 30 || r.height < 10) continue;
      var t = (cands[i].innerText || '').replace(/\s+/g, '');
      if (t.indexOf('模型') === 0 && t.length < 12) { target = cands[i]; break; }
    }
    if (!target) {
      log.push({ 步骤: '未找到「模型」菜单项' });
      return JSON.stringify(log, null, 1);
    }
    var tr = target.getBoundingClientRect();
    log.push({ 步骤: '准备点「模型」项', 文本: (target.innerText || '').replace(/\s+/g, ' ').slice(0, 20),
      矩形: Math.round(tr.left) + ',' + Math.round(tr.top) + ' ' + Math.round(tr.width) + 'x' + Math.round(tr.height),
      屏幕坐标: { sx: Math.round((tr.left + tr.width / 2) * DPR), sy: Math.round(OFF_Y + (tr.top + tr.height / 2) * DPR) } });

    try { target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: tr.left + tr.width / 2, clientY: tr.top + tr.height / 2 })); } catch (e) {}
    target.click();
    await wait(900);
    log.push({ 步骤: '点「模型」项后', innerH: window.innerHeight + '（759=键盘没弹）', 浮层: visibleSurface(), 可编辑: findEditable() });

    return JSON.stringify(log, null, 1);
  })();
})()
