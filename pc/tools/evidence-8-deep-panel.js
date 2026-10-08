// SPDX-License-Identifier: MIT
// 证据 8：深度 dump 面板——把 listbox 内所有后代节点（含隐藏的）逐层导出，
// 用 querySelectorAll 而非 innerText（innerText 会漏掉 display:none 的内容）。
// 目的：判断「添加(文件/目标/计划/反馈)」组是被 CSS 隐藏，还是根本没渲染。
(function () {
  function brief(el) {
    var cs = el === document ? null : getComputedStyle(el);
    var r = el === document ? null : el.getBoundingClientRect();
    return {
      标签: el.tagName,
      role: el.getAttribute && el.getAttribute('role'),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 36),
      text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 60),
      disp: cs ? cs.display : null,
      vis: cs ? cs.visibility : null,
      opacity: cs ? cs.opacity : null,
      h: r ? Math.round(r.height) : null,
      w: r ? Math.round(r.width) : null,
      aria: el.getAttribute && el.getAttribute('aria-label')
    };
  }

  var out = { innerH: window.innerHeight };
  var nodes = document.querySelectorAll('[role="listbox"]');
  out.listbox总数 = nodes.length;
  out.面板 = [];

  for (var i = 0; i < nodes.length; i++) {
    var lb = nodes[i];
    var r = lb.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;

    // 递归收集所有后代，最多 3 层
    function walk(el, depth, acc) {
      if (depth > 3 || acc.length > 200) return;
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        acc.push({ d: depth, 节点: brief(c) });
        walk(c, depth + 1, acc);
      }
    }
    var children = [];
    walk(lb, 0, children);

    out.面板.push({
      矩形: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
      scrollH: lb.scrollHeight,
      clientH: lb.clientHeight,
      overflowY: getComputedStyle(lb).overflowY,
      overflow: getComputedStyle(lb).overflow,
      后代节点: children,
      // 关键：直接查找「文件」「目标」「计划」「反馈」这几个字，看它们各自是否存在于 DOM、是否可见
      关键词存在性: (function () {
        var map = {};
        ['文件', '目标', '计划', '反馈', '压缩', '权限', '模型', '下载日志'].forEach(function (kw) {
          var found = [];
          var all = lb.querySelectorAll('*');
          for (var k = 0; k < all.length; k++) {
            if ((all[k].textContent || '').indexOf(kw) >= 0 && all[k].children.length === 0) {
              var cs = getComputedStyle(all[k]);
              var rr = all[k].getBoundingClientRect();
              found.push({
                文本: (all[k].textContent || '').replace(/\s+/g, ' ').slice(0, 30),
                disp: cs.display, vis: cs.visibility,
                h: Math.round(rr.height),
                在文档流: rr.height > 0 && cs.display !== 'none'
              });
              if (found.length >= 3) break;
            }
          }
          map[kw] = found;
        });
        return map;
      })()
    });
  }
  return JSON.stringify(out, null, 1);
})()
