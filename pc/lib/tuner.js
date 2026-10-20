// SPDX-License-Identifier: Apache-2.0
'use strict';
/**
 * tuner.js —— 几十行的"手工权重前馈打分器"（无需训练、无依赖、微秒级）。
 *
 * 为什么要有它：
 *   通信参数不该写成死板的 if-else。写 `if (rtt > 100) timeout = 3000` 的问题是**不连续**：
 *   rtt=99 时用 1200ms、rtt=101 时突然跳到 3000ms，行为会抖。这里用一个极小的前馈网络
 *   （矩阵乘 + ReLU），输出随输入**平滑变化**，并且权重集中在一处、便于按现场情况微调。
 *
 * ⚠️ 只喂**真实采集到**的信号（这条是硬规矩）：
 *   本项目的通信是 HTTP/WebSocket over TCP，客户端**测不到丢包率**（丢包被内核重传隐藏）。
 *   所以这里没有 loss 输入 —— 用一个"假丢包率"喂网络，等于给 if-else 套了层数学外壳，
 *   出问题时反而更难排查。可用的真实信号只有：
 *     · rttMs        —— 隧道 /health 实测往返毫秒（拿不到时传 null）
 *     · failRate     —— 最近 N 次健康检查的失败占比（0~1，真实计数）
 *     · reconnects   —— 最近 10 分钟内的隧道重建次数（真实计数）
 *     · mode         —— usb / lan / remote（链路类别，决定基线）
 *
 * 输出（都有真实消费者）：
 *     · probeTimeoutMs     —— 建议的单次探测超时（手机端用它判断"这条路是否还活着"）
 *     · handshakeTimeoutMs —— 建议的握手超时
 *     · retries            —— 建议的重试次数
 *     · weight             —— 该链路的"粘性权重"（0~1，用于避免在两三条路之间来回跳）
 */

/** 手工标定的权重。想改变行为，只改这里（改完跑 tools/tuner-selftest.js 看趋势是否仍单调）。 */
const W = {
  // 隐层：3 个神经元，输入 [rttNorm, failNorm, isRemote]
  hidden: [
    [0.9, 0.2, 0.1], // 神经元1：主要看延迟
    [0.2, 1.0, 0.2], // 神经元2：主要看失败率
    [0.1, 0.3, 0.8], // 神经元3：主要看是否异地
  ],
  // 输出层：从 3 个隐单元映射到 [超时分量, 重试分量, 粘性分量]
  output: [
    [1.0, 0.6, 0.9],
    [1.4, 0.8, -0.6],
    // 异地这一档**只影响粘性权重**，不参与超时计算：
    // 超时应该由"这条链路现在健康不健康"（延迟/失败率）决定，而"它是异地"已经体现在 base 里。
    // 两者叠加会把异地超时推到 7 秒，拖慢故障切换。
    [0.0, 0.0, -0.9],
  ],
  // 每种链路的基线（毫秒）与上限。基线是**主导项**：网络只在此基础上温和放大，
  // 避免"基线 + isRemote 神经元"重复叠加把异地推到 7 秒（那会让故障切换变很慢）。
  // 标定依据（实测）：USB/LAN 探测通常 <50ms，1.2s 足够；隧道实测 1.1~1.7s，5s 足够。
  base: { usb: 700, lan: 800, remote: 3200 },
  cap: { usb: 1500, lan: 1800, remote: 6000 },
  handshakeBase: { usb: 5000, lan: 6000, remote: 10000 },
  handshakeCap: { usb: 12000, lan: 14000, remote: 25000 },
};

const relu = (x) => (x > 0 ? x : 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (x, dflt) => (typeof x === 'number' && Number.isFinite(x) ? x : dflt);

/** 把真实测量归一化到 0~1（分段线性，避免单点异常把网络推到饱和）。 */
function features({ rttMs, failRate, mode }) {
  const rttNorm = rttMs == null ? 0.5 : clamp(num(rttMs, 0) / 2500, 0, 1); // 2500ms 视为最差
  const failNorm = clamp(num(failRate, 0), 0, 1);
  const isRemote = mode === 'remote' ? 1 : 0;
  return [rttNorm, failNorm, isRemote];
}

/**
 * 前向传播，返回**建议参数**与可读依据。
 * @param {{mode?:string, rttMs?:number|null, failRate?:number, reconnects?:number}} input
 */
function suggest(input = {}) {
  const mode = input.mode === 'usb' || input.mode === 'lan' || input.mode === 'remote' ? input.mode : 'lan';
  const f = features({ rttMs: input.rttMs, failRate: input.failRate, mode });

  // 隐层
  const h = W.hidden.map((row) => relu(f.reduce((s, v, i) => s + v * row[i], 0)));

  // 输出层（三个分量）
  const out = [0, 1, 2].map((k) => h.reduce((s, v, i) => s + v * W.output[i][k], 0));

  const probeTimeoutMs = Math.round(clamp(W.base[mode] * (1 + 0.45 * out[0]), W.base[mode], W.cap[mode]));
  const handshakeTimeoutMs = Math.round(clamp(W.handshakeBase[mode] * (1 + 0.5 * out[0]), W.handshakeBase[mode], W.handshakeCap[mode]));
  const retries = Math.round(clamp(0.2 + out[1] * 2.4, 0, 3));
  const weight = Math.round(clamp(0.5 + out[2] * 0.9 + (num(input.reconnects, 0) > 2 ? -0.35 : 0), 0, 1) * 100) / 100;

  return {
    mode,
    probeTimeoutMs,
    handshakeTimeoutMs,
    retries,
    weight,
    // 依据：出问题时能一眼看出"为什么给了这个值"，而不是一个黑箱数字
    explain:
      `mode=${mode} rtt=${input.rttMs == null ? '未知' : Math.round(input.rttMs) + 'ms'} ` +
      `失败率=${Math.round(num(input.failRate, 0) * 100)}% 重建=${num(input.reconnects, 0)}次 ` +
      `→ 探测 ${probeTimeoutMs}ms / 握手 ${handshakeTimeoutMs}ms / 重试 ${retries} 次 / 粘性 ${weight}`,
  };
}

module.exports = { suggest, features, weights: W };
