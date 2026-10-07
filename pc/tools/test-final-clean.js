// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:5075ded128​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 完整验证：toggle 开合 + 发消息不受干扰。
// 关键：点输入框打字时，innerH 应正常缩小（键盘正常起来），绝不被压。
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
  var log = [];
  function L(s) { log.push(s); }

  return (async function () {
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });

    L('① 初始 面板开=' + panelOpen() + ' innerH=' + window.innerHeight);

    // 开面板
    btn.click();
    await wait(800);
    L('② click开面板后 面板开=' + panelOpen() + ' innerH=' + window.innerHeight);
    if (!panelOpen()) return JSON.stringify({ 结果: '开面板失败', 日志: log });

    // toggle 关面板
    try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 38, clientY: 706 })); } catch (e) {}
    btn.click();
    await wait(800);
    L('③ 再点+收面板后 面板开=' + panelOpen() + ' innerH=' + window.innerHeight);

    // 发消息：点输入框 → 键盘应正常起来（innerH 缩小），绝不闪
    var ta = document.querySelector('[role="textbox"]');
    if (ta) { try { ta.focus(); } catch (e) {} }
    await wait(800);
    L('④ 点输入框打字 面板开=' + panelOpen() + ' innerH=' + window.innerHeight + '（<700=键盘正常起来=发消息OK）');

    return JSON.stringify(log, null, 1);
  })();
})()
