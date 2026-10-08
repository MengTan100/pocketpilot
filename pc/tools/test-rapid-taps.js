// SPDX-License-Identifier: MIT
// 连点验证：连续快速点「+」8 次（间隔 120ms），全程 30ms 采样 innerH。
// 判据：innerH 始终 759 → 键盘一次都没露出（连点也不弹）。
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

  var samples = [];
  var iv = null;
  function startSampling() {
    iv = setInterval(function () {
      samples.push({ t: Date.now(), innerH: window.innerHeight });
    }, 30);
  }
  function stopSampling() { if (iv) clearInterval(iv); iv = null; }

  return (async function () {
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;

    var before = window.innerHeight;
    startSampling();

    var states = [];
    for (var i = 0; i < 8; i++) {
      try { btn.dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, cancelable: true, clientX: cx, clientY: cy })); } catch (e) {}
      btn.click();
      states.push(panelOpen() ? '开' : '关');
      await wait(120);
    }
    var afterTaps = window.innerHeight;
    await wait(1600);           // 连点结束后再观察 1.6s（覆盖 1500ms 续期窗口）
    stopSampling();

    var minH = Math.min.apply(null, samples.map(function (s) { return s.innerH; }));
    // 找出所有 innerH < 700 的采样点（键盘露出过的时刻）
    var leaks = samples.filter(function (s) { return s.innerH < 700; });

    return JSON.stringify({
      初始innerH: before,
      连点后innerH: afterTaps,
      最终innerH: window.innerHeight,
      采样点数: samples.length,
      最小innerH: minH,
      键盘是否露出过: leaks.length > 0,
      露出采样数: leaks.length,
      连点期间面板开合序列: states.join(''),
      判定: (leaks.length === 0 ? '✅ 连点全程键盘未露出' : '❌ 键盘露出过')
    }, null, 1);
  })();
})()
