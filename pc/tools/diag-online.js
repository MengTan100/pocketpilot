// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:87b451ccd8​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
// 诊断：DSH 的恢复机制是否会因为"浏览器以为离线"而永久暂停。
(function () {
  var out = {};

  out.onLine = navigator.onLine;
  out.connection = (navigator.connection && {
    type: navigator.connection.type,
    effectiveType: navigator.connection.effectiveType,
    downlink: navigator.connection.downlink,
    rtt: navigator.connection.rtt,
  }) || null;

  // DSH 暴露的恢复状态（README 提到 observable recovery state）
  var keys = Object.keys(window).filter(function (k) {
    return /dsh|connection|recovery|generation|gateway/i.test(k);
  });
  out.相关全局 = keys.slice(0, 30);

  // 逐个看能不能读出状态
  out.全局详情 = {};
  keys.forEach(function (k) {
    try {
      var v = window[k];
      var t = typeof v;
      if (t === 'object' && v) {
        out.全局详情[k] = { type: t, keys: Object.keys(v).slice(0, 12) };
      } else if (t !== 'function') {
        out.全局详情[k] = { type: t, value: String(v).slice(0, 60) };
      } else {
        out.全局详情[k] = { type: 'function' };
      }
    } catch (e) { out.全局详情[k] = { err: String(e).slice(0, 40) }; }
  });

  // 最近是否触发过 online/offline —— 记录起来供下一轮观察
  if (!window.__netLog) {
    window.__netLog = [];
    window.addEventListener('online', function () {
      window.__netLog.push({ t: Date.now(), k: 'online', onLine: navigator.onLine });
    });
    window.addEventListener('offline', function () {
      window.__netLog.push({ t: Date.now(), k: 'offline', onLine: navigator.onLine });
    });
    out.netLogHooked = true;
  } else {
    out.netLogHooked = 'already';
  }
  out.netLog = window.__netLog || [];

  return JSON.stringify(out, null, 1);
})()
