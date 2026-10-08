// SPDX-License-Identifier: MIT
// 探查：手机页面当前显示的对话内容与实时通道状态。
(function () {
  var out = { url: location.href.slice(0, 90), title: document.title };

  // 1) WS 资源与可疑全局
  out.ws资源 = performance.getEntriesByType('resource')
    .filter(function (e) { return /websocket/i.test(String(e.initiatorType || '')); })
    .map(function (e) { return e.name.slice(0, 80); });
  out.可疑全局 = Object.keys(window).filter(function (k) {
    return /socket|mux|remote|channel|realtime|recovery/i.test(k);
  }).slice(0, 15);

  // 2) 对话消息：按几种常见结构统计
  var sels = ['[data-message-id]', '[role="article"]', '[class*="_message"]', '[class*="_turn"]', '[class*="_bubble"]', '[class*="_item"]'];
  out.消息候选 = {};
  sels.forEach(function (s) {
    try { out.消息候选[s] = document.querySelectorAll(s).length; } catch (e) {}
  });

  // 3) 取页面可见正文的最后几段（对话内容）
  var main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
  var txt = (main.innerText || '').replace(/\s+/g, ' ').trim();
  out.正文长度 = txt.length;
  out.正文尾部 = txt.slice(-400);

  // 4) 侧栏会话列表（看手机端认为当前是哪个会话）
  var items = [];
  var nodes = document.querySelectorAll('[class*="_session"], [class*="_chatItem"], [class*="_row"]');
  for (var i = 0; i < nodes.length && items.length < 12; i++) {
    var t = (nodes[i].innerText || '').replace(/\s+/g, ' ').trim();
    if (t && t.length < 40) items.push(t);
  }
  out.侧栏项 = items;

  // 5) 有没有"连接中/已断开"之类的提示
  out.连接提示 = txt.match(/连接中|已断开|重连|离线|断开|connecting|reconnect|offline/gi) || [];

  return JSON.stringify(out, null, 1);
})()
