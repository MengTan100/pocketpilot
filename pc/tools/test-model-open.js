// SPDX-License-Identifier: MIT
// 验证：打开模型列表时键盘不弹。并输出搜索框的屏幕坐标（供真实点击下一步用）。
(function () {
  function findModelBtn() {
    var all = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < all.length; i++) {
      var lb = all[i].getAttribute('aria-label') || '';
      if (lb.indexOf('选择模型') === 0) return all[i];
    }
    return null;
  }
  function anyMenuOpen() {
    var sels = ['[role="menu"]', '[role="listbox"]', '[role="dialog"]'];
    for (var s = 0; s < sels.length; s++) {
      var ns = document.querySelectorAll(sels[s]);
      for (var i = 0; i < ns.length; i++) {
        var r = ns[i].getBoundingClientRect();
        if (r.width > 60 && r.height > 40) return sels[s];
      }
    }
    return null;
  }
  function searchBox() {
    return document.querySelector('input[role="searchbox"]') ||
           document.querySelector('input[placeholder*="搜索"]') ||
           document.querySelector('input[type="search"]');
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function sample(dur, step) {
    return new Promise(function (resolve) {
      var arr = [], t0 = Date.now();
      var iv = setInterval(function () { arr.push(window.innerHeight); }, step);
      setTimeout(function () { clearInterval(iv); resolve(arr); }, dur);
    });
  }
  var log = [];
  var DPR = 3.25, OFF_Y = 152;
  function toScreen(r) {
    return { sx: Math.round((r.left + r.width / 2) * DPR),
             sy: Math.round(OFF_Y + (r.top + r.height / 2) * DPR) };
  }

  return (async function () {
    var btn = findModelBtn();
    if (!btn) return JSON.stringify({ 错误: '未找到模型选择按钮' });
    var r0 = btn.getBoundingClientRect();
    log.push('① 打开前 innerH=' + window.innerHeight + ' 浮层=' + anyMenuOpen());

    try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2 })); } catch (e) {}
    btn.click();

    var s = await sample(1400, 60);
    var minH = Math.min.apply(null, s);
    log.push('② 打开模型列表后 1.4s 内 innerH 最小=' + minH + '（759=键盘没弹 ✅；<700=弹了 ❌）');
    log.push('   浮层=' + anyMenuOpen());

    var sb = searchBox();
    if (sb) {
      var rb = sb.getBoundingClientRect();
      var sc = toScreen(rb);
      log.push('③ 搜索框找到: 矩形=' + Math.round(rb.left) + ',' + Math.round(rb.top) + ' ' +
        Math.round(rb.width) + 'x' + Math.round(rb.height) + ' 可编辑=' + sb.tagName +
        ' role=' + sb.getAttribute('role'));
      log.push('👉 搜索框屏幕坐标 sx=' + sc.sx + ' sy=' + sc.sy);
    } else {
      log.push('③ 未找到搜索框');
    }
    return JSON.stringify(log, null, 1);
  })();
})()
