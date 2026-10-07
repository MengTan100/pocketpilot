// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:dcd0477ab8​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 定位 DSH 底部那条"轮次 / token / 百分比"状态栏，读出它的结构与尺寸，
// 以便判断能不能收窄居中（用户反馈它横铺满屏、不好退出）。
(function () {
  var out = { items: [], bars: [] };

  // 1) 找含 轮/tok/% 的叶子节点
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.children.length !== 0) continue;
    var t = (el.innerText || '').trim();
    if (!t || t.length > 40) continue;
    if (!/轮|tok|%|步/.test(t)) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.items.push({
      text: t.slice(0, 30),
      cls: String(el.className).slice(0, 40),
      rect: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
      父: String(el.parentElement && el.parentElement.className).slice(0, 44)
    });
  }
  out.items = out.items.slice(0, 12);

  // 2) 找视口底部附近的横向容器（那条栏本身）
  for (var j = 0; j < all.length; j++) {
    var e2 = all[j];
    var r2 = e2.getBoundingClientRect();
    if (r2.height < 12 || r2.height > 70) continue;
    if (r2.width < window.innerWidth * 0.5) continue;
    if (r2.top < window.innerHeight * 0.7) continue;
    var cs = getComputedStyle(e2);
    out.bars.push({
      cls: String(e2.className).slice(0, 50),
      rect: Math.round(r2.left) + ',' + Math.round(r2.top) + ' ' + Math.round(r2.width) + 'x' + Math.round(r2.height),
      display: cs.display,
      justifyContent: cs.justifyContent,
      padding: cs.paddingLeft + '/' + cs.paddingRight,
      text: (e2.innerText || '').trim().slice(0, 60)
    });
  }
  out.bars = out.bars.slice(0, 8);
  out.viewport = window.innerWidth + 'x' + window.innerHeight;

  return JSON.stringify(out, null, 1);
})()
