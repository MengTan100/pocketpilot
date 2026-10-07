// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:ef5f1a8e0a​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 逻辑验证：用 CDP 精确触发，验证 toggle 逻辑是否正确（不受 input tap 飘忽影响）。
// 步骤：
// 1. plusButton.click() 开面板（已验证有效）
// 2. 等面板开
// 3. 模拟"再点「+」"：在「+」按钮上派发 pointerdown + click（触发我的 toggle 关闭逻辑）
// 4. 检查面板是否关了
// 注意：第3步的 click 也会让 DSH 自己处理，但 DSH 对已开面板是 no-op（实测），
//       所以关不关取决于我的 closePanelSafely。
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
  function log(s) { window.__toggleTest = window.__toggleTest || []; window.__toggleTest.push(s); }

  var btn = findPlus();
  if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });
  log('初始 面板开=' + panelOpen());

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  return (async function () {
    // 1) 开面板
    if (!panelOpen()) {
      btn.click();
      await wait(700);
      log('click开面板后 面板开=' + panelOpen());
    } else {
      log('面板本就开着');
    }
    if (!panelOpen()) return JSON.stringify({ 结果: '开面板失败，中止', 日志: window.__toggleTest });

    // 2) 模拟"再点「+」"：在 btn 上派发 pointerdown + click
    //    这会触发我的 pointerdown（记 _stateBeforePlusTap=true）和 click（→ closePanelSafely）
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    try {
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    } catch (e) { btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy })); }
    btn.click();
    await wait(900);
    log('再点+后 面板开=' + panelOpen());

    return JSON.stringify({ 日志: window.__toggleTest, 最终面板开: panelOpen() }, null, 1);
  })();
})()
