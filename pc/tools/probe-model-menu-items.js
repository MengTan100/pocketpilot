// SPDX-License-Identifier: MIT
// 打开模型菜单并 dump 其中所有可点项（含 aria-haspopup / role / 坐标），
// 用来确定"哪一项通向带搜索框的模型列表"。
(function () {
  function findModelBtn() {
    var all = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < all.length; i++) {
      if ((all[i].getAttribute('aria-label') || '').indexOf('选择模型') === 0) return all[i];
    }
    return null;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var log = [];

  return (async function () {
    var btn = findModelBtn();
    if (!btn) return JSON.stringify({ 错误: '未找到模型按钮' });
    var r0 = btn.getBoundingClientRect();
    try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2 })); } catch (e) {}
    btn.click();
    await wait(800);

    var surfaces = document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"]');
    var items = [];
    for (var s = 0; s < surfaces.length; s++) {
      var sr = surfaces[s].getBoundingClientRect();
      if (sr.width < 60 || sr.height < 30) continue;
      var all = surfaces[s].querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var role = el.getAttribute('role');
        var pop = el.getAttribute('aria-haspopup');
        var isBtn = el.tagName === 'BUTTON' || role === 'menuitem' || role === 'menuitemradio' ||
                    role === 'option' || role === 'button' || role === 'tab';
        if (!isBtn && !pop) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 8) continue;
        items.push({
          标签: el.tagName, role: role, haspopup: pop,
          aria: el.getAttribute('aria-label'),
          text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 30),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 28),
          矩形: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
        });
      }
    }
    log.push({ 步骤: '点模型选择器后', innerH: window.innerHeight,
      浮层数: surfaces.length, 可点项: items });
    return JSON.stringify(log, null, 1);
  })();
})()
