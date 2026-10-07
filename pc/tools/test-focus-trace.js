// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:7548ae6b4c​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 诊断：连点期间输入框是否拿到过焦点？JS 桥方法是否真的可调用？
(function () {
  function findPlus() {
    var all = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('aria-label') === '添加文件或调用指令') return all[i];
    }
    return null;
  }
  function who() {
    var a = document.activeElement;
    if (!a || a === document.body) return 'BODY';
    return a.tagName + '.' + (typeof a.className === 'string' ? a.className.slice(0, 20) : '');
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  return (async function () {
    var out = {};
    // ① 桥方法是否可调用
    out.桥方法 = {
      onImeHold: window.DshApp ? typeof window.DshApp.onImeHold : '(无DshApp)',
      onImeRelease: window.DshApp ? typeof window.DshApp.onImeRelease : '(无DshApp)'
    };

    // ② 装焦点追踪
    var focusLog = [];
    var t0 = Date.now();
    function onIn(e) { focusLog.push({ t: Date.now() - t0, k: 'focusin', 目标: who() }); }
    function onOut(e) { focusLog.push({ t: Date.now() - t0, k: 'focusout' }); }
    document.addEventListener('focusin', onIn, true);
    document.addEventListener('focusout', onOut, true);

    // ③ 极速连点 10 次
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var innerHs = [];
    for (var i = 0; i < 10; i++) {
      try { btn.dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, cancelable: true, clientX: cx, clientY: cy })); } catch (e) {}
      btn.click();
      innerHs.push(window.innerHeight);
      await wait(70);
    }
    // 连点后再观察 1.5s
    for (var j = 0; j < 10; j++) { innerHs.push(window.innerHeight); await wait(150); }

    document.removeEventListener('focusin', onIn, true);
    document.removeEventListener('focusout', onOut, true);

    out.连点期间innerH序列 = innerHs.join(',');
    out.innerH最小 = Math.min.apply(null, innerHs);
    out.键盘是否弹起 = Math.min.apply(null, innerHs) < 700;
    out.焦点事件 = focusLog.slice(0, 40);
    out.焦点事件数 = focusLog.length;
    out.结束时焦点 = who();
    return JSON.stringify(out, null, 1);
  })();
})()
