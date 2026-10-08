// SPDX-License-Identifier: MIT
// 实测底部面板的开合行为：
//   点「+」→ 应打开；再点「+」→ 应关闭；点「缓存」→ 应切换而不是叠加。
(function () {
  function openPanelCount() {
    var sels = ['[role="dialog"][class*="_panel"]', '[role="menu"]', '[class*="popover"]', '[class*="Popover"]'];
    var n = 0;
    sels.forEach(function (s) {
      Array.prototype.forEach.call(document.querySelectorAll(s), function (el) {
        var r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 20) n++;
      });
    });
    return n;
  }

  function findTrigger(re) {
    var b = document.querySelectorAll('button[aria-label]');
    for (var i = 0; i < b.length; i++) {
      if (re.test(b[i].getAttribute('aria-label') || '')) return b[i];
    }
    return null;
  }

  /** 模拟一次真实点击（指针 + 鼠标 + click 全套，确保各层监听都能收到） */
  function tap(el) {
    if (!el) return false;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      var Ev = t.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(t, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  }

  var plus = findTrigger(/添加文件|调用指令/);
  var cache = findTrigger(/缓存命中/);
  var steps = [];
  steps.push('触发按钮: +' + (plus ? '找到' : '未找到') + ' / 缓存' + (cache ? '找到' : '未找到'));
  steps.push('初始面板数 = ' + openPanelCount());

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  return (async function () {
    tap(plus);   await wait(700);
    steps.push('点「+」后          = ' + openPanelCount() + '  (期望 1)');
    tap(plus);   await wait(700);
    steps.push('再点「+」后        = ' + openPanelCount() + '  (期望 0)');
    tap(cache);  await wait(700);
    steps.push('点「缓存」后       = ' + openPanelCount() + '  (期望 1)');
    tap(cache);  await wait(700);
    steps.push('再点「缓存」后     = ' + openPanelCount() + '  (期望 0)');
    return steps.join('\n');
  })();
})()
