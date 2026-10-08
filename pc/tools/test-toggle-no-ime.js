// SPDX-License-Identifier: MIT
// 验证：再点「+」收面板，键盘仍不弹。
(function () {
  function findPlus() {
    var all = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('aria-label') === '添加文件或调用指令') return all[i];
    }
    return null;
  }
  function panelOpen() {
    var nodes = document.querySelectorAll('[role="listbox"]');
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 20) return true;
    }
    return false;
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
  return (async function () {
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });
    if (!panelOpen()) {
      var r0 = btn.getBoundingClientRect();
      try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r0.left + 14, clientY: r0.top + 14 })); } catch (e) {}
      btn.click();
      await wait(900);
    }
    log.push('① 收面板前 面板开=' + panelOpen() + ' innerH=' + window.innerHeight);

    var r = btn.getBoundingClientRect();
    try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r.left + 14, clientY: r.top + 14 })); } catch (e) {}
    btn.click();
    var s = await sample(1200, 60);
    var minH = Math.min.apply(null, s);
    log.push('② 再点+后 innerH 最小=' + minH + '（759=键盘没弹 ✅）  面板开=' + panelOpen());
    return JSON.stringify(log, null, 1);
  })();
})()
