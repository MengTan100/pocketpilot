// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:8be48a5dc1​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 完整流程：点模型选择器 → 点「模型 …」项 → 看带搜索框的列表是否出现、键盘是否弹。
(function () {
  function findModelBtn() {
    var all = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < all.length; i++) {
      if ((all[i].getAttribute('aria-label') || '').indexOf('选择模型') === 0) return all[i];
    }
    return null;
  }
  function findCell() {
    var all = document.querySelectorAll('button[role="menuitem"]');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].innerText || '').replace(/\s+/g, '');
      if (t.indexOf('模型') === 0) return all[i];
    }
    return null;
  }
  function searchBox() {
    return document.querySelector('input[role="searchbox"]') ||
           document.querySelector('input[placeholder*="搜索"]');
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function sample(dur, step) {
    return new Promise(function (resolve) {
      var arr = [], t0 = Date.now();
      var iv = setInterval(function () { arr.push(window.innerHeight); }, step);
      setTimeout(function () { clearInterval(iv); resolve(arr); }, dur);
    });
  }
  var log = [], DPR = 3.25, OFF_Y = 152;

  return (async function () {
    var btn = findModelBtn();
    if (!btn) return JSON.stringify({ 错误: '未找到模型按钮' });
    var r0 = btn.getBoundingClientRect();
    try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2 })); } catch (e) {}
    btn.click();
    await wait(700);
    log.push('① 菜单已开 innerH=' + window.innerHeight);

    var cell = findCell();
    if (!cell) return JSON.stringify({ 结果: '未找到「模型」菜单项', 日志: log });
    var cr = cell.getBoundingClientRect();

    // 模拟点该菜单项（非可编辑 → 会 onImeHold）
    try { cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      clientX: cr.left + cr.width / 2, clientY: cr.top + cr.height / 2 })); } catch (e) {}
    cell.click();

    var s = await sample(1500, 60);
    var minH = Math.min.apply(null, s);
    log.push('② 点「模型 …」后 1.5s 内 innerH 最小=' + minH + '（759=键盘没弹 ✅；<700=弹了 ❌）');

    var sb = searchBox();
    if (sb) {
      var rb = sb.getBoundingClientRect();
      log.push('③ 搜索框出现: ' + sb.tagName + ' role=' + sb.getAttribute('role') +
        ' ph=' + (sb.getAttribute('placeholder') || sb.getAttribute('aria-label')) +
        ' 矩形=' + Math.round(rb.left) + ',' + Math.round(rb.top) + ' ' + Math.round(rb.width) + 'x' + Math.round(rb.height) +
        ' 屏幕坐标=(' + Math.round((rb.left + rb.width / 2) * DPR) + ',' + Math.round(OFF_Y + (rb.top + rb.height / 2) * DPR) + ')');
    } else {
      log.push('③ 未找到搜索框');
    }
    return JSON.stringify(log, null, 1);
  })();
})()
