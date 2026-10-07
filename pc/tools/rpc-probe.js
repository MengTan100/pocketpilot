// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:a5874db993​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
'use strict';
/**
 * rpc-probe.js —— 独立诊断脚本：对指定 DSH Web 实例跑一次完整会话往返，
 * 并打印事件类型序列，用于确认真实的事件模型与失败原因。
 *
 * 用法: node rpc-probe.js <baseUrl> <token> [prompt]
 */

const base = process.argv[2];
const token = process.argv[3];
const prompt = process.argv[4] || 'reply with exactly: clean ok';

if (!base || !token) {
  console.error('用法: node rpc-probe.js <baseUrl> <token> [prompt]');
  process.exit(2);
}

let cookie = null;

async function ensureCookie() {
  const res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  cookie = raw.map((s) => String(s).split(';')[0]).join('; ');
  console.log(`[auth] HTTP ${res.status}, cookie 项数=${raw.length}`);
}

async function rpc(method, args) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `probe-${Date.now()}`, method, payload: { args } }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} 非 JSON: ${text.slice(0, 300)}`);
  }
  if (!json.result || json.result.ok !== true) {
    throw new Error(`${method} 失败: ${JSON.stringify(json.result && json.result.error)}`);
  }
  return json.result.value;
}

(async () => {
  await ensureCookie();

  const created = await rpc('session/create', { request: {} });
  const sessionId = created.sessionId;
  console.log(`[create] sessionId=${sessionId} preset=${created.agentPreset}`);

  const accepted = await rpc('session/prompt', {
    request: {
      requestId: `probe-req-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    },
  });
  console.log(`[prompt] accepted=${accepted.accepted}`);

  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const list = await rpc('session/list', { _request: {} });
    const item = (list.items || []).find((x) => x.sessionId === sessionId);
    const cursor = (item && item.projections && item.projections.asOfSeq) || 0;
    const page = await rpc('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq: cursor, maxMessages: 80 },
    });
    const events = (page.records || []).map((r) => r.event).filter(Boolean);
    const ended = events.find((e) => e.type === 'turn/end');
    if (ended) {
      console.log(`[events] 共 ${events.length} 条，类型序列：`);
      console.log('  ' + events.map((e) => `${e.seq}:${e.type}`).join('  '));
      console.log(`[turn/end] ${JSON.stringify(ended.data)}`);
      // 打印非生命周期事件的精简结构，确认助手回复的真实类型
      for (const e of events) {
        if (/message|inbox|assistant|content/i.test(e.type)) {
          let s = JSON.stringify(e);
          if (s.length > 320) s = s.slice(0, 320) + '…';
          console.log(`  · ${e.seq} ${e.type} => ${s}`);
        }
      }
      process.exit(0);
    }
    if (i % 10 === 9) console.log(`[wait] ${i + 1}s…`);
  }
  console.log('[timeout] 90 秒内没有 turn/end');
  process.exit(1);
})().catch((error) => {
  console.error('[error]', error.message);
  process.exit(3);
});
