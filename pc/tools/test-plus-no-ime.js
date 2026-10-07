// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:062de90960​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 精确验证：点「+」时键盘不弹。
// 用 CDP 在「+」按钮上派发 pointerdown + click（会触发前端 onPlusTouch → App 开始"按住键盘"），
// 并高频采样 innerH（键盘顶起则缩小），判断键盘有没有弹出来。
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
      var iv = setInterval(function () {
        arr.push({ ms: Date.now() - t0, innerH: window.innerHeight });
      }, step);
      setTimeout(function () { clearInterval(iv); resolve(arr); }, dur);
    });
  }
  var log = [];

  return (async function () {
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;

    log.push('① 点前 innerH=' + window.innerHeight + ' 面板开=' + panelOpen());

    // 模拟真实点「+」：pointerdown → click
    try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy })); } catch (e) {}
    btn.click();

    var s = await sample(1200, 60);
    var minH = Math.min.apply(null, s.map(function (x) { return x.innerH; }));
    log.push('② 点+后 1.2s 内 innerH 最小=' + minH + '（759=键盘没弹 ✅；<700=弹了 ❌）');
    log.push('   面板开=' + panelOpen());

    return JSON.stringify(log, null, 1);
  })();
})()
