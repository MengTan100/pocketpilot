// SPDX-License-Identifier: MIT
// 深挖：DSH 连接恢复模块的实时状态 + 页面上是否有"重连/断开"提示元素。
(function () {
  var out = {};
  try {
    var rec = window.__DSH_CONNECTION_RECOVERY__;
    out.连接恢复类型 = typeof rec;
    if (rec && typeof rec === 'object') {
      out.连接恢复 = JSON.stringify(rec).slice(0, 800);
      out.字段 = Object.keys(rec);
    } else if (typeof rec === 'function') {
      out.连接恢复 = String(rec).slice(0, 300);
    }
  } catch (e) { out.连接恢复错误 = String(e); }

  // 页面上是否存在连接状态提示（横幅/toast）
  var hints = [];
  var all = document.querySelectorAll('div, span, button');
  for (var i = 0; i < all.length && hints.length < 15; i++) {
    var t = (all[i].innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 60) continue;
    if (/重连|断开|连接中|离线|恢复|reconnect|offline|retry|失去|错误|失败/.test(t)) {
      var r = all[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) hints.push(t);
    }
  }
  out.连接提示元素 = hints;

  // 「发送中」这类 pending 状态出现在哪些元素上
  var pend = [];
  var every = document.querySelectorAll('*');
  for (var k = 0; k < every.length && pend.length < 10; k++) {
    var tx = (every[k].innerText || '').replace(/\s+/g, ' ').trim();
    if (every[k].children.length === 0 && /发送中|排队中|处理中/.test(tx) && tx.length < 30) {
      pend.push(tx);
    }
  }
  out.pending文本 = pend;

  // 页面里最后一次"服务端事件"的迹象：取对话区尾部
  var main = document.querySelector('main') || document.body;
  out.对话区尾部 = (main.innerText || '').replace(/\s+/g, ' ').trim().slice(-260);

  return JSON.stringify(out, null, 1);
})()
