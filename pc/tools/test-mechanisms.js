// SPDX-License-Identifier: MIT
// 机制预测试：在写任何代码前，先用 CDP 把"开/关"两个机制验证清楚。
// 1) plusButton.click() 能否打开面板？（React onClick 是否响应合成 click）
// 2) 面板打开后，在 document.body 上派发 pointerdown+mousedown 能否关闭？
//    （目标显式为 body，绝不可能命中面板内的列表项 → 不会改坏列表）
// 全程只读+派发 body 事件，不碰面板内部任何节点。
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
  function panelItemCount() {
    var nodes = document.querySelectorAll('[role="listbox"]');
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 20) {
        return nodes[i].querySelectorAll('[role="option"]').length;
      }
    }
    return -1;
  }
  function snap() {
    return { 开: panelOpen(), 条目数: panelItemCount(), 焦点: (document.activeElement && document.activeElement.tagName) + '.' + (typeof document.activeElement.className === 'string' ? document.activeElement.className.slice(0,18) : '') };
  }
  var log = [];
  var btn = findPlus();
  if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });
  log.push({ 步骤: '初始', 状态: snap() });

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  return (async function () {
    // —— 机制1：用 .click() 打开
    if (!panelOpen()) {
      btn.click();
      await wait(600);
      log.push({ 步骤: 'click()后', 状态: snap() });
    }
    // —— 机制2：若已开，派发 body 上的 pointerdown+mousedown 关闭
    if (panelOpen()) {
      var before = panelItemCount();
      try {
        var pd = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 2, clientY: 2 });
        document.body.dispatchEvent(pd);
        var md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 2, clientY: 2 });
        document.body.dispatchEvent(md);
      } catch (e) { log.push({ 步骤: '派发异常', err: String(e) }); }
      await wait(600);
      log.push({ 步骤: 'body-pointerdown后', 关前条目数: before, 关后状态: snap() });
    } else {
      log.push({ 步骤: 'click()没打开面板，跳过关闭测试' });
    }
    return JSON.stringify(log, null, 1);
  })();
})()
