// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:57b37e5e8f​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 决定性实验：面板打开时，把焦点从输入框移走，面板会不会被 DSH 关掉？
// 变体1：composer.blur()      变体2：plusButton.focus()
// 只有当"焦点移走后面板依然开着"时，才能用"撤焦点"从根上阻止键盘弹出。
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
  function who() {
    var a = document.activeElement;
    if (!a) return '(null)';
    return a.tagName + '.' + (typeof a.className === 'string' ? a.className.slice(0, 22) : '');
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var log = [];

  return (async function () {
    var btn = findPlus();
    if (!btn) return JSON.stringify({ 错误: '未找到+按钮' });

    // 确保面板开着
    if (!panelOpen()) {
      var r = btn.getBoundingClientRect();
      try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
        clientX: r.left + 14, clientY: r.top + 14 })); } catch (e) {}
      btn.click();
      await wait(800);
    }
    log.push('① 面板开=' + panelOpen() + ' 焦点=' + who() + ' innerH=' + window.innerHeight);
    if (!panelOpen()) return JSON.stringify({ 结果: '无法打开面板，中止', 日志: log });

    // —— 变体1：可编辑元素 blur()
    var ae = document.activeElement;
    if (ae && ae.blur) { try { ae.blur(); } catch (e) {} }
    await wait(700);
    log.push('② 变体1 对焦点元素 blur() 后: 面板开=' + panelOpen() + ' 焦点=' + who());

    // 若面板被关了，重新开，再测变体2
    if (!panelOpen()) {
      var r2 = btn.getBoundingClientRect();
      try { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
        clientX: r2.left + 14, clientY: r2.top + 14 })); } catch (e) {}
      btn.click();
      await wait(800);
      log.push('   （变体1 把面板关掉了，重开: 面板开=' + panelOpen() + '）');
    }

    // —— 变体2：把焦点给「+」按钮本身
    try { btn.focus(); } catch (e) {}
    await wait(700);
    log.push('③ 变体2 「+」按钮 focus() 后: 面板开=' + panelOpen() + ' 焦点=' + who());

    return JSON.stringify(log, null, 1);
  })();
})()
