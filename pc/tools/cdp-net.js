// SPDX-License-Identifier: MIT
// 检查页面加载过的资源与失败的请求，判断会话列表是不是"数据没到"。
(function () {
  var out = {};

  // 1) 加载过的资源里，哪些看起来和会话/工作区相关
  var entries = performance.getEntriesByType('resource') || [];
  var interesting = [];
  entries.forEach(function (e) {
    var n = e.name || '';
    if (/session|workspace|conversation|history|list|api|rpc/i.test(n)) {
      interesting.push({
        name: n.replace(location.origin, '').slice(0, 80),
        ms: Math.round(e.duration),
        size: e.transferSize || 0
      });
    }
  });
  out.relatedRequests = interesting.slice(-25);
  out.totalRequests = entries.length;

  // 2) 窗口里是否有 DSH 暴露的全局对象（找它的前端 API）
  out.globals = Object.keys(window).filter(function (k) {
    return /dsh|harness|remote|rpc|boot|store/i.test(k);
  }).slice(0, 25);

  // 3) 抓当时的 console 错误（已经发生的抓不到，这里看 error 计数）
  out.hasBoot = typeof window.__DSH_BOOT__ !== 'undefined';
  if (out.hasBoot) {
    try {
      var b = window.__DSH_BOOT__;
      out.bootKeys = Object.keys(b).slice(0, 20);
    } catch (e) {}
  }

  // 4) 当前路由/会话标识（URL 或 hash 里有没有 sessionId）
  out.href = location.href.replace(/k=[^&]+/, 'k=***').slice(0, 120);
  out.localStorageKeys = Object.keys(localStorage).slice(0, 30);

  return JSON.stringify(out, null, 1);
})()
