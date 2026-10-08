// SPDX-License-Identifier: MIT
// 定位底部状态栏（"轮 N 步" / "缓存命中" / "tok" / 百分比）的可点击目标，
// 为后续"在它展开的页面里加关闭入口"做准备。
(function () {
  var out = { candidates: [], bottomArea: [] };
  var vh = window.innerHeight;
  var all = document.querySelectorAll('*');

  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var t = (el.innerText || '').trim();
    if (!t || t.length > 70) continue;
    if (!/(轮|步|缓存|命中|tok)/.test(t)) continue;
    var r = el.getBoundingClientRect();
    if (r.top < vh * 0.78) continue;          // 只看靠近底部的
    if (r.width < 2 || r.height < 2) continue;

    // 向上找最近的"可点击"祖先
    var node = el;
    var clickable = null;
    for (var d = 0; d < 8 && node; d++) {
      var tag = node.tagName;
      var role = node.getAttribute ? (node.getAttribute('role') || '') : '';
      if (tag === 'BUTTON' || tag === 'A' || role === 'button' || node.onclick) {
        clickable = node;
        break;
      }
      node = node.parentElement;
    }

    out.candidates.push({
      文本: t.slice(0, 40),
      类名: String(el.className).slice(0, 42),
      位置: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
      可点标签: clickable ? clickable.tagName : '(无)',
      可点类名: clickable ? String(clickable.className).slice(0, 42) : '',
      可点aria: clickable ? (clickable.getAttribute('aria-label') || '') : ''
    });
  }

  // 底部整片区域内所有可点元素（含无文字的图标按钮）
  var clickables = document.querySelectorAll('button, [role="button"], a');
  for (var j = 0; j < clickables.length; j++) {
    var c = clickables[j];
    var rc = c.getBoundingClientRect();
    if (rc.top < vh * 0.85 || rc.width < 8 || rc.height < 8) continue;
    out.bottomArea.push({
      标签: c.tagName,
      类名: String(c.className).slice(0, 42),
      aria: c.getAttribute('aria-label') || '',
      文本: (c.innerText || '').trim().slice(0, 30),
      位置: Math.round(rc.left) + ',' + Math.round(rc.top) + ' ' + Math.round(rc.width) + 'x' + Math.round(rc.height)
    });
  }

  out.candidates = out.candidates.slice(0, 10);
  out.bottomArea = out.bottomArea.slice(0, 10);
  out.视口 = window.innerWidth + 'x' + vh;
  return JSON.stringify(out, null, 1);
})()
