// SPDX-License-Identifier: MIT
// 端到端验证：用 CDP 精确事件，验证重构后的完整行为矩阵。
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
  function imeUp() { return window.innerHeight < 700; }  // 键盘顶起则 innerH 缩小
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var log = [];
  function L(s) { log.push(s); }

  return (async function () {
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });

    L('① 初始: 面板开=' + panelOpen() + ' 键盘顶起=' + imeUp());

    // —— 开面板
    btn.click();
    await wait(900);
    L('② click开面板后: 面板开=' + panelOpen() + ' 键盘顶起=' + imeUp());
    if (!panelOpen()) return JSON.stringify({ 结果: '开面板失败', 日志: log });

    // 面板开了，等 1s 看键盘有没有被压住（不应顶起）
    await wait(1000);
    L('③ 面板开1s后: 面板开=' + panelOpen() + ' 键盘顶起=' + imeUp());

    // —— toggle 关面板：在「+」上派发 pointerdown + click
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width/2, cy = r.top + r.height/2;
    try { btn.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,cancelable:true,clientX:cx,clientY:cy})); } catch(e){}
    btn.click();
    await wait(900);
    L('④ 再点+收面板后: 面板开=' + panelOpen() + ' 键盘顶起=' + imeUp());

    // —— 面板关后，聚焦输入框，键盘应正常起来
    var ta = document.querySelector('[role="textbox"]');
    if (ta) { try { ta.focus(); } catch(e){} }
    await wait(900);
    L('⑤ 面板关后聚焦输入框: 面板开=' + panelOpen() + ' 键盘顶起=' + imeUp());

    return JSON.stringify(log, null, 1);
  })();
})()
