// SPDX-License-Identifier: MIT
'use strict';
/**
 * tuner-selftest.js —— 验证打分器"该单调的单调、有界、连续、可解释"。
 * 这些性质比"数值好看"重要：网络变差不该让超时**变短**，输出不该跳变，也不该越界。
 */
const { suggest } = require('../lib/tuner');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  [PASS] ' + name + (detail ? '  · ' + detail : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  · ' + detail : '')); }
};

console.log('=== 1. 延迟越高，探测/握手超时越长（单调）===');
{
  let prev = null, monotonic = true, samples = [];
  for (const rtt of [20, 80, 200, 500, 1200, 2400]) {
    const s = suggest({ mode: 'remote', rttMs: rtt, failRate: 0 });
    samples.push(rtt + 'ms→' + s.probeTimeoutMs + 'ms');
    if (prev !== null && s.probeTimeoutMs < prev) monotonic = false;
    prev = s.probeTimeoutMs;
  }
  check('探测超时随 rtt 单调不减', monotonic, samples.join(', '));
}

console.log('=== 2. 失败率越高，重试次数越多（单调）===');
{
  let prev = null, monotonic = true, samples = [];
  for (const fr of [0, 0.2, 0.5, 0.8, 1]) {
    const s = suggest({ mode: 'lan', rttMs: 20, failRate: fr });
    samples.push(fr + '→' + s.retries);
    if (prev !== null && s.retries < prev) monotonic = false;
    prev = s.retries;
  }
  check('重试次数随失败率单调不减', monotonic, samples.join(', '));
}

console.log('=== 3. 同类条件下异地 > 局域网 > USB（基线正确）===');
{
  const usb = suggest({ mode: 'usb', rttMs: 20, failRate: 0 });
  const lan = suggest({ mode: 'lan', rttMs: 20, failRate: 0 });
  const wan = suggest({ mode: 'remote', rttMs: 20, failRate: 0 });
  check('usb <= lan', usb.probeTimeoutMs <= lan.probeTimeoutMs, usb.probeTimeoutMs + ' <= ' + lan.probeTimeoutMs);
  check('lan < remote', lan.probeTimeoutMs < wan.probeTimeoutMs, lan.probeTimeoutMs + ' < ' + wan.probeTimeoutMs);
}

console.log('=== 4. 输出有界（不会被异常输入推出可用范围）===');
{
  const bad = [suggest({ mode: 'remote', rttMs: 999999, failRate: 5 }), suggest({ mode: 'usb', rttMs: -100, failRate: -1 })];
  const bounded = bad.every((s) =>
    s.probeTimeoutMs >= 400 && s.probeTimeoutMs <= 6000 &&
    s.handshakeTimeoutMs >= 3000 && s.handshakeTimeoutMs <= 25000 &&
    s.retries >= 0 && s.retries <= 3 &&
    s.weight >= 0 && s.weight <= 1);
  check('极值输入下仍在绝对区间内', bounded,
    bad.map((s) => s.probeTimeoutMs + '/' + s.handshakeTimeoutMs + '/' + s.retries + '/' + s.weight).join(' | '));
}

console.log('=== 5. 连续（不会在临界点跳变）===');
{
  let maxJump = 0, prev = null;
  for (let rtt = 0; rtt <= 500; rtt += 5) {
    const s = suggest({ mode: 'lan', rttMs: rtt, failRate: 0 });
    if (prev !== null) maxJump = Math.max(maxJump, Math.abs(s.probeTimeoutMs - prev));
    prev = s.probeTimeoutMs;
  }
  check('rtt 每 5ms 步进时超时变化 <= 120ms', maxJump <= 120, '最大跳变 ' + maxJump + 'ms');
}

console.log('=== 6. 缺测量时给保守值，而不是崩/给 0 ===');
{
  const s = suggest({ mode: 'remote' }); // rtt 未知
  check('rtt 未知时在 2800~6000ms（保守但不夸张，且不等于 0）', s.probeTimeoutMs >= 2800 && s.probeTimeoutMs <= 6000, s.probeTimeoutMs + 'ms');
  const s2 = suggest({});
  check('完全无输入也不崩且模式回落 lan', s2.mode === 'lan', s2.explain);
}

console.log('=== 7. 可解释（每次都给出依据，便于排查）===');
{
  const s = suggest({ mode: 'remote', rttMs: 180, failRate: 0.08, reconnects: 3 });
  check('explain 含 rtt/失败率/重建/结果', /rtt=180ms/.test(s.explain) && /失败率=8%/.test(s.explain) && /重建=3次/.test(s.explain), s.explain);
}

console.log('=== 8. 标定验收：常用档位的绝对数值必须落在实测得出的区间 ===');
{
  const u = suggest({ mode: 'usb', rttMs: 20, failRate: 0 });
  const l = suggest({ mode: 'lan', rttMs: 60, failRate: 0.05 });
  const w = suggest({ mode: 'remote', rttMs: 1500, failRate: 0.1 });
  check('USB 探测 <= 1200ms', u.probeTimeoutMs <= 1200, u.probeTimeoutMs + 'ms');
  check('LAN 探测 800~1600ms', l.probeTimeoutMs >= 800 && l.probeTimeoutMs <= 1600, l.probeTimeoutMs + 'ms');
  check('异地(1.5s) 探测 <= 6000ms 且 >= 2800ms', w.probeTimeoutMs >= 2800 && w.probeTimeoutMs <= 6000, w.probeTimeoutMs + 'ms');
}

console.log('\n--- ' + pass + '/' + (pass + fail) + ' 通过 ---');
process.exit(fail === 0 ? 0 : 1);
