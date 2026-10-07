// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:439ea8ed1d​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 强化版连点测试：连点 12 次（70ms）后，以 25ms 采样 innerH 持续 5 秒。
// innerH < 700 即键盘弹起（实测键盘为浮层，弹出时把视口从 759 压到 365）。
(function () {
  function findPlus() {
    var all = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('aria-label') === '添加文件或调用指令') return all[i];
    }
    return null;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  return (async function () {
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;

    var samples = [];
    var t0 = Date.now();
    var iv = setInterval(function () { samples.push({ t: Date.now() - t0, h: window.innerHeight }); }, 25);

    var seq = [];
    for (var i = 0; i < 12; i++) {
      try { btn.dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, cancelable: true, clientX: cx, clientY: cy })); } catch (e) {}
      btn.click();
      seq.push(document.querySelector('[role="listbox"]') ? '开' : '关');
      await wait(70);
    }
    var tapsDoneAt = Date.now() - t0;
    await wait(5000);                     // 连点结束后继续观察 5s
    clearInterval(iv);

    var minH = Math.min.apply(null, samples.map(function (s) { return s.h; }));
    var leaks = samples.filter(function (s) { return s.h < 700; });
    var leaksAfterTaps = leaks.filter(function (s) { return s.t > tapsDoneAt; });

    return JSON.stringify({
      连点开合序列: seq.join(''),
      连点耗时ms: tapsDoneAt,
      采样数: samples.length,
      最小innerH: minH,
      键盘弹起过: leaks.length > 0,
      弹出采样数: leaks.length,
      首次弹出时刻ms: leaks.length ? leaks[0].t : -1,
      连点结束后才弹的采样数: leaksAfterTaps.length,
      首次晚弹时刻ms: leaksAfterTaps.length ? leaksAfterTaps[0].t : -1,
      判定: leaks.length === 0 ? '✅ 全程键盘未弹' : '❌ 键盘弹起过'
    }, null, 1);
  })();
})()
