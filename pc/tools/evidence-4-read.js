// SPDX-License-Identifier: MIT
// 证据 4：把记录器的时间序列读回来。
(function () {
  if (!window.__REC) return JSON.stringify({ ok: false, note: '记录器未安装' });
  return JSON.stringify({
    ok: true,
    条数: window.__REC.length,
    时间线: window.__REC
  }, null, 1);
})()
