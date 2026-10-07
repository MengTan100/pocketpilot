// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:b656f80136​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 完整验证：第一次点不闪、第二次点收面板不弹键盘、面板关后打字正常。
// 用 CDP 精确事件触发，监测 innerH 时序（键盘顶起则 innerH 缩小）。
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
  // 高频采样 innerH，捕捉"键盘有没有短暂升起"
  function sample(dur, step) {
    return new Promise(function (resolve) {
      var arr = [];
      var t0 = Date.now();
      var iv = setInterval(function () {
        arr.push({ ms: Date.now() - t0, innerH: window.innerHeight, 面板开: panelOpen() });
      }, step);
      setTimeout(function () { clearInterval(iv); resolve(arr); }, dur);
    });
  }
  var log = [];

  return (async function () {
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });

    // ① 第一次点「+」开面板：采样看键盘有没有短暂升起（闪）
    log.push('① 第一次点+前 innerH=' + window.innerHeight + ' 面板开=' + panelOpen());
    btn.click();
    var s1 = await sample(1000, 80);
    var minH1 = Math.min.apply(null, s1.map(function (x) { return x.innerH; }));
    log.push('① 第一次点+后 1s 内 innerH 最小=' + minH1 + '（759=没升起/不闪；<700=升起过=闪）  面板开=' + panelOpen());

    if (!panelOpen()) return JSON.stringify({ 结果: '开面板失败', 日志: log });

    await wait(500);

    // ② 第二次点「+」收面板：采样看键盘有没有弹起
    log.push('② 第二次点+前 innerH=' + window.innerHeight + ' 面板开=' + panelOpen());
    try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 38, clientY: 706 })); } catch (e) {}
    btn.click();
    var s2 = await sample(1000, 80);
    var minH2 = Math.min.apply(null, s2.map(function (x) { return x.innerH; }));
    log.push('② 第二次点+后 1s 内 innerH 最小=' + minH2 + '（759=没弹；<700=弹了）  面板开=' + panelOpen());

    // ③ 面板关后等 1s（超过 500ms 宽限期），聚焦输入框看键盘正常起来
    await wait(1200);
    log.push('③ 宽限期过后 innerH=' + window.innerHeight + ' 面板开=' + panelOpen());
    var ta = document.querySelector('[role="textbox"]');
    if (ta) { try { ta.focus(); } catch (e) {} }
    await wait(800);
    log.push('③ 聚焦输入框后 innerH=' + window.innerHeight + '（<700=键盘正常起来=打字不受影响）');

    return JSON.stringify(log, null, 1);
  })();
})()
