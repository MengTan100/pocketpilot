// SPDX-License-Identifier: MIT
// 检查页面里 WebSocket 的痕迹（不依赖 CDP 事件，直接问页面）
(function () {
  var out = {};

  // 1) performance 里登记为 websocket 的资源
  var res = performance.getEntriesByType('resource').filter(function (e) {
    return String(e.initiatorType || '').toLowerCase() === 'websocket';
  });
  out.wsResources = res.map(function (e) {
    return e.name.replace(location.origin, '').slice(0, 70);
  });

  // 2) 与实时通道相关的全局变量
  out.socketGlobals = Object.keys(window).filter(function (k) {
    return /socket|mux|remote|channel|realtime|stream/i.test(k);
  }).slice(0, 20);

  // 3) DSH 的启动信息里是否有通道配置
  try {
    var boot = window.__DSH_BOOT__;
    if (boot) {
      out.bootKeys = Object.keys(boot);
      out.bootStr = JSON.stringify(boot).slice(0, 300);
    }
  } catch (e) {}

  // 4) 连接恢复机制的配置（__DSH_CONNECTION_RECOVERY__ 是页面里真实存在的全局）
  try {
    var rec = window.__DSH_CONNECTION_RECOVERY__;
    if (rec) out.connectionRecovery = JSON.stringify(rec).slice(0, 300);
  } catch (e) {}

  // 5) hook 一下未来的 WebSocket，便于下一轮观察
  if (!window.__wsHooked) {
    window.__wsHooked = true;
    window.__wsLog = [];
    var Orig = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      var sock = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
      window.__wsLog.push({ at: Date.now(), url: String(url).slice(0, 80), state: 'created' });
      sock.addEventListener('open', function () {
        window.__wsLog.push({ at: Date.now(), url: String(url).slice(0, 80), state: 'open' });
      });
      sock.addEventListener('message', function (e) {
        window.__wsLog.push({
          at: Date.now(), url: String(url).slice(0, 80), state: 'recv',
          size: String(e.data || '').length
        });
      });
      sock.addEventListener('close', function () {
        window.__wsLog.push({ at: Date.now(), url: String(url).slice(0, 80), state: 'closed' });
      });
      sock.addEventListener('error', function () {
        window.__wsLog.push({ at: Date.now(), url: String(url).slice(0, 80), state: 'error' });
      });
      return sock;
    };
    window.WebSocket.prototype = Orig.prototype;
    out.hooked = true;
  } else {
    out.hooked = 'already';
  }

  return JSON.stringify(out, null, 1);
})()
