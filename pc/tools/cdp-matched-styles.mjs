// SPDX-License-Identifier: MIT
/**
 * cdp-matched-styles.mjs —— 用 CDP 的 CSS 域查"某元素最终被哪些规则影响"。
 *
 * 为什么要它：DSH 的样式被压缩、类名带哈希，靠肉眼猜不出来；
 * 而"侧栏展开后高度是 0"这种问题，必须看到**到底是哪条规则、在哪个媒体查询下**生效。
 *
 * 用法: node cdp-matched-styles.mjs <wsUrl> <选择器>
 *   例: node cdp-matched-styles.mjs ws://... "[class*=\"_frame\"]"
 */
const [, , wsUrl, selector] = process.argv;
if (!wsUrl || !selector) {
  console.error('用法: node cdp-matched-styles.mjs <wsUrl> <selector>');
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); }
    }, 15000);
  });
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
});

ws.addEventListener('open', async () => {
  try {
    await send('DOM.enable');
    await send('CSS.enable');
    const doc = await send('DOM.getDocument', { depth: -1 });
    const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!found || !found.nodeId) { console.error('找不到元素:', selector); process.exit(3); }

    const desc = await send('DOM.describeNode', { nodeId: found.nodeId });
    console.log('节点:', (desc.node.localName || '') + ' class=' + String((desc.node.attributes || []).join(' ')).slice(0, 160));

    const matched = await send('CSS.getMatchedStylesForNode', { nodeId: found.nodeId });
    const interesting = /grid-template|width|height|position|display|overflow|margin|padding|flex/i;

    console.log('\n=== 内联样式 ===');
    console.log(matched.inlineStyle ? (matched.inlineStyle.cssText || '(空)') : '(无)');

    console.log('\n=== 命中的规则（只列布局相关声明）===');
    for (const m of matched.matchedCSSRules || []) {
      const rule = m.rule;
      let decls = [];
      if (rule.style && rule.style.cssProperties) {
        decls = rule.style.cssProperties
          .filter((p) => p.name && interesting.test(p.name) && !p.disabled)
          .map((p) => `${p.name}: ${p.value}`);
      } else if (rule.style && rule.style.cssText) {
        decls = [rule.style.cssText];
      }
      if (!decls.length) continue;
      const media = (rule.media || []).map((x) => x.text || '').join(' ');
      console.log(`  ${rule.selectorList ? rule.selectorList.text.slice(0, 90) : '?'} ${media ? '[media ' + media + ']' : ''}`);
      console.log('      ' + decls.join('; ').slice(0, 300));
    }

    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('失败:', err.message);
    process.exit(1);
  }
});
ws.addEventListener('error', (e) => { console.error('WS 错误:', e.message); process.exit(1); });
