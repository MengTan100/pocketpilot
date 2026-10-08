// SPDX-License-Identifier: MIT
// 验证：面板开后，键盘是否被持续压制。
// 步骤：1) .click() 开面板  2) 立即聚焦输入框（模拟 DSH 抢焦点）  3) 轮询 innerH 看键盘有没有顶起
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
  var log = [];
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  return (async function () {
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });
    log.push({ 步骤: '初始', 面板开: panelOpen(), innerH: window.innerHeight });

    if (!panelOpen()) {
      btn.click();
      await wait(800);
      log.push({ 步骤: 'click开面板后', 面板开: panelOpen(), innerH: window.innerHeight });
    }
    if (!panelOpen()) return JSON.stringify({ 结果: '开面板失败', 日志: log });

    // 面板已开。现在等 1.5s，观察键盘有没有试图顶起（innerH 变化）
    var samples = [];
    for (var i = 0; i < 10; i++) {
      samples.push({ ms: i * 150, innerH: window.innerHeight, 面板开: panelOpen() });
      await wait(150);
    }
    log.push({ 步骤: '面板开期间键盘采样(innerH)', 样本: samples });

    // 主动聚焦输入框（模拟 DSH 抢焦点），看键盘会不会被压下去
    var ta = document.querySelector('[role="textbox"]');
    if (ta) { try { ta.focus(); } catch (e) {} }
    await wait(800);
    log.push({ 步骤: '聚焦输入框后', 面板开: panelOpen(), innerH: window.innerHeight });

    return JSON.stringify(log, null, 1);
  })();
})()
