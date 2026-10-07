// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:15f92e0993​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 极速连点：12 次 × 60ms，结束立即返回（不等待），方便 PC 端立刻采样键盘状态。
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
    var seq = [];
    for (var i = 0; i < 12; i++) {
      try { btn.dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, cancelable: true, clientX: cx, clientY: cy })); } catch (e) {}
      btn.click();
      seq.push(document.querySelector('[role="listbox"]') ? '开' : '关');
      await wait(60);
    }
    return JSON.stringify({ 完成: 12, 开合序列: seq.join(''), innerH: window.innerHeight });
  })();
})()
