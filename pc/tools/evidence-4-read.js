// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:e56ddae8d8​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 证据 4：把记录器的时间序列读回来。
(function () {
  if (!window.__REC) return JSON.stringify({ ok: false, note: '记录器未安装' });
  return JSON.stringify({
    ok: true,
    条数: window.__REC.length,
    时间线: window.__REC
  }, null, 1);
})()
