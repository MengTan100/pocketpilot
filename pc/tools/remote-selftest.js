// SPDX-License-Identifier: Apache-2.0
'use strict';
/**
 * remote-selftest.js —— 异地通道（provider 层 + 持久化隧道）的**可执行行为验证**。
 *
 * 为什么要单独一个可执行验证：
 *   "复用隧道地址"这件事只能在**行为**上验证 —— 光看代码无法证明"桥接重启后地址不变"。
 *   本工具用注入的假实现（假进程存活、假 HTTP、假记录、假守护进程）把四条关键路径
 *   全部跑一遍，输出真实的 PASS/FAIL 与关键数值，不触网、不装东西、不留进程。
 *
 * 运行：
 *   node tools/remote-selftest.js
 *
 * 覆盖：
 *   A. Tailscale provider 三态（未安装 / 未登录 / 已就绪）都不崩，且都给出可操作状态
 *   B. 100.64.0.0/10 判定（100.64/100.101/100.127 是、100.63/100.128/192.168 不是）
 *   C. 持久化隧道：runtime 记录"活着且可用" → **复用**该地址（不新建、地址不变）
 *   D. 持久化隧道：runtime 记录"进程已死" → 新建并把新地址写回记录
 *   E. 持久化隧道：记录里 pid 被系统复用成别的进程 → 必须判为不可复用（防误复用）
 *   F. 记录"进程活着但地址被 Cloudflare 回收（HTTP 非 200）" → 也必须重建
 *   G. 远程 provider 层：cloudflared 排最后的优先级顺序 + hasStable/note 在
 *      Tailscale 未登录时仍能给出**可操作**说明
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  createTailscaleProvider,
  createRemoteLayer,
  createCloudflaredProvider,
  isTailscaleCgnat,
} = require('../lib/remote');
const { createPersistentTunnel, isProcessAlive } = require('../lib/tunnel');

const results = [];
function check(name, expect, actual) {
  const ok = String(expect) === String(actual);
  results.push({ name, ok, expect, actual });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}\n        期望=${expect}  实际=${actual}`);
  return ok;
}

// 用当前进程的 pid 冒充"活着的进程"（它当然活着），用超大的 pid 冒充"已死"
const LIVE_PID = process.pid;
const DEAD_PID = 999999;

console.log('=== A. Tailscale provider：缺少 / 未登录 / 已就绪，三种状态都不崩且可操作 ===');

const absentTs = createTailscaleProvider({
  log: () => {},
  announce: () => {},
  networkInterfaces: () => ({}),
  fileExists: () => false,                 // 没装
  runCli: () => ({ ok: false, stdout: '', stderr: 'not found' }),
  platform: 'win32',
});
const absentStatus = absentTs.status();
check('A1 未安装：state=absent', 'absent', absentStatus.state);
check('A2 未安装：不伪造地址（baseUrls 为空）', '0', absentStatus.baseUrls.length);
check('A3 未安装：给出可操作动作（自动下载安装）', 'install', absentStatus.action && absentStatus.action.kind);
check('A4 未安装：status() 可安全重复调用', 'absent', absentTs.status().state);

// 未登录：完全复刻本机实测输出
const LOGGED_OUT_STDOUT = 'Logged out.\nLog in at: https://login.tailscale.com/a/67fce5b019624\n';
const loggedOutTs = createTailscaleProvider({
  log: () => {},
  announce: () => {},
  networkInterfaces: () => ({}),
  fileExists: (p) => /tailscale\.exe$/i.test(p),         // CLI 在
  runCli: (args) => (args[0] === 'ip'
    ? { ok: false, stdout: '', stderr: 'no current Tailscale IPs; state: NeedsLogin' }
    : { ok: false, stdout: LOGGED_OUT_STDOUT, stderr: '', status: 1 }),
  platform: 'win32',
});
const loggedOutStatus = loggedOutTs.status();
check('A5 未登录：state=needs-login', 'needs-login', loggedOutStatus.state);
check('A6 未登录：解析出登录链接', 'https://login.tailscale.com/a/67fce5b019624', loggedOutStatus.loginUrl);
check('A7 未登录：不伪造地址', '0', loggedOutStatus.baseUrls.length);
check('A8 未登录：动作为"点击登录"', 'login', loggedOutStatus.action && loggedOutStatus.action.kind);
check('A9 未登录：detail 说明登录后即固定', 'true',
  /登录后即获得固定的 100\.x 地址/.test(loggedOutStatus.detail));

// 已就绪：网卡里有 100.x
const readyTs = createTailscaleProvider({
  port: 3080,
  log: () => {},
  announce: () => {},
  networkInterfaces: () => ({ Tailscale: [{ family: 'IPv4', internal: false, address: '100.101.102.103' }] }),
  fileExists: () => true,
  runCli: () => ({ ok: true, stdout: '100.101.102.103\n', stderr: '' }),
  platform: 'win32',
});
const readyStatus = readyTs.status();
check('A10 已就绪：state=ready', 'ready', readyStatus.state);
check('A11 已就绪：发布 http://100.x:端口', 'http://100.101.102.103:3080', readyStatus.baseUrls[0]);
check('A12 已就绪：publicBases() 一致', 'http://100.101.102.103:3080', readyTs.publicBases()[0]);

// 非 Windows 平台：不支持自动安装，但必须给出人工指引（不能崩）
const linuxAbsent = createTailscaleProvider({
  log: () => {}, announce: () => {},
  networkInterfaces: () => ({}), fileExists: () => false,
  runCli: () => ({ ok: false, stdout: '', stderr: '' }),
  platform: 'linux',
});
const linuxStatus = linuxAbsent.status();
check('A13 Linux 未安装：installSupported=false', 'false', linuxStatus.installSupported);
check('A14 Linux 未安装：动作=manual（人工指引）', 'manual', linuxStatus.action && linuxStatus.action.kind);

console.log('\n=== B. 100.64.0.0/10（Tailscale CGNAT）判定：算异地、不算局域网 ===');
check('B1 100.64.0.1 是 CGNAT', 'true', isTailscaleCgnat('100.64.0.1'));
check('B2 100.101.102.103 是 CGNAT', 'true', isTailscaleCgnat('100.101.102.103'));
check('B3 100.127.255.254 是 CGNAT（上界内）', 'true', isTailscaleCgnat('100.127.255.254'));
check('B4 100.63.0.1 不是 CGNAT（下界外）', 'false', isTailscaleCgnat('100.63.0.1'));
check('B5 100.128.0.1 不是 CGNAT（上界外）', 'false', isTailscaleCgnat('100.128.0.1'));
check('B6 192.168.0.4 不是 CGNAT', 'false', isTailscaleCgnat('192.168.0.4'));
check('B7 进程存活探测：当前进程活的', 'true', isProcessAlive(LIVE_PID, ''));
check('B8 进程存活探测：超大 pid 判为死的', 'false', isProcessAlive(DEAD_PID, ''));

console.log('\n=== C. 持久化隧道：runtime 记录"活着且可用" → 复用（不新建、地址不变） ===');

/** 造一个"假世界"：记录文件在内存里，进程存活与 HTTP 结果由测试决定。 */
function makeFakeWorld(initialRecord, opts = {}) {
  const state = {
    record: initialRecord ? JSON.parse(JSON.stringify(initialRecord)) : null,
    spawned: 0,
    httpCalls: [],
    alive: opts.alive || (() => true),
    httpCode: opts.httpCode || (() => 200),
  };
  const tunnel = createPersistentTunnel({
    binary: 'C:\\fake\\cloudflared.exe',
    target: 'http://127.0.0.1:3080',
    runtimeDir: 'C:\\fake\\runtime',
    log: opts.log || (() => {}),
    reuse: opts.reuse !== false,
    deps: {
      isAlive: (pid, name) => state.alive(pid, name),
      httpStatus: async (url) => { state.httpCalls.push(url); return state.httpCode(url); },
      readRecord: () => state.record,
      writeRecord: (v) => { state.record = v; },
      spawnSupervisor: () => { state.spawned += 1; return { ok: true, pid: 4242 }; },
      sleep: async () => {},
      now: () => Date.parse('2026-10-08T12:00:00Z'),
    },
  });
  return { state, tunnel };
}

const LIVE_URL = 'https://blue-river-1234.trycloudflare.com';
const worldC = makeFakeWorld({
  pid: LIVE_PID,
  publicUrl: LIVE_URL,
  startedAt: Date.parse('2026-10-08T11:30:00Z'),   // 30 分钟前
  state: 'running',
  managedBy: 'dsh-phone-bridge/supervisor',
});
const logsC = [];
const tunnelC = createPersistentTunnel({
  binary: 'C:\\fake\\cloudflared.exe',
  target: 'http://127.0.0.1:3080',
  runtimeDir: 'C:\\fake\\runtime',
  log: (line) => logsC.push(line),
  reuse: true,
  deps: {
    isAlive: () => true,
    httpStatus: async (url) => { worldC.state.httpCalls.push(url); return 200; },
    readRecord: () => worldC.state.record,
    writeRecord: (v) => { worldC.state.record = v; },
    spawnSupervisor: () => { worldC.state.spawned += 1; return { ok: true, pid: 4242 }; },
    sleep: async () => {},
    now: () => Date.parse('2026-10-08T12:00:00Z'),
  },
});
(async () => {
  const started = await tunnelC.start();
  check('C1 复用了已有隧道地址', LIVE_URL, started.publicUrl);
  check('C2 reused=true', 'true', started.reused);
  check('C3 没有新建守护进程（spawned=0）', '0', worldC.state.spawned);
  check('C4 复用时会做一次地址可用性校验', '1', worldC.state.httpCalls.length);
  check('C5 日志写明"复用已存在的隧道"', 'true',
    logsC.some((l) => l.includes('复用已存在的隧道') && l.includes(LIVE_URL)));
  check('C6 日志写明已运行时长（30 分钟）', 'true', logsC.some((l) => l.includes('已运行 30 分钟')));
  check('C7 status() 实时反映同一地址', LIVE_URL, tunnelC.status().publicUrl);
  check('C8 status().state=running', 'running', tunnelC.status().state);

  console.log('\n=== D. 持久化隧道：记录还在但进程已死 → 新建并写回新地址 ===');
  const worldD = makeFakeWorld({ pid: DEAD_PID, publicUrl: 'https://stale-old.trycloudflare.com', startedAt: Date.now() });
  const logsD = [];
  const tunnelD = createPersistentTunnel({
    binary: 'C:\\fake\\cloudflared.exe',
    target: 'http://127.0.0.1:3080',
    runtimeDir: 'C:\\fake\\runtime',
    log: (line) => logsD.push(line),
    reuse: true,
    deps: {
      isAlive: (pid) => pid !== DEAD_PID,               // 记录里的 pid 已死
      httpStatus: async () => 200,
      readRecord: () => worldD.state.record,
      writeRecord: (v) => { worldD.state.record = v; },
      // 假守护进程：被拉起后"写出"新地址，模拟真实 supervisor 的行为
      spawnSupervisor: () => {
        worldD.state.spawned += 1;
        worldD.state.record = { pid: 7777, publicUrl: 'https://new-fresh-5678.trycloudflare.com', startedAt: Date.parse('2026-10-08T12:00:00Z'), state: 'running' };
        return { ok: true, pid: 7777 };
      },
      sleep: async () => {},
      now: () => Date.parse('2026-10-08T12:00:00Z'),
    },
  });
  const startedD = await tunnelD.start();
  check('D1 判定旧记录不可复用并新建', 'false', startedD.reused);
  check('D2 新地址已写回记录', 'https://new-fresh-5678.trycloudflare.com', worldD.state.record.publicUrl);
  check('D3 返回的是新地址（不再是旧域名）', 'https://new-fresh-5678.trycloudflare.com', startedD.publicUrl);
  check('D4 只拉起一个守护进程', '1', worldD.state.spawned);
  check('D5 日志说明旧记录为何被弃用', 'true', logsD.some((l) => l.includes('已不存在')));
  check('D6 status() 读到的也是新地址', 'https://new-fresh-5678.trycloudflare.com', tunnelD.status().publicUrl);

  console.log('\n=== E. pid 被系统复用成别的进程 → 必须判为不可复用 ===');
  const worldE = makeFakeWorld({ pid: 1234, publicUrl: 'https://pid-reused.trycloudflare.com', startedAt: Date.now() });
  let eSpawned = 0;
  const tunnelE = createPersistentTunnel({
    binary: 'C:\\fake\\cloudflared.exe',
    runtimeDir: 'C:\\fake\\runtime',
    log: () => {},
    reuse: true,
    deps: {
      // pid 存在，但名字不是 cloudflared（模拟被复用）
      isAlive: (pid, name) => (name === 'cloudflared' ? false : true),
      httpStatus: async () => 200,
      readRecord: () => worldE.state.record,
      writeRecord: (v) => { worldE.state.record = v; },
      spawnSupervisor: () => {
        eSpawned += 1;
        worldE.state.record = { pid: 8888, publicUrl: 'https://after-reuse-check.trycloudflare.com', startedAt: Date.now() };
        return { ok: true, pid: 8888 };
      },
      sleep: async () => {},
      now: () => Date.now(),
    },
  });
  const startedE = await tunnelE.start();
  check('E1 名字不匹配 → 不复用', 'false', startedE.reused);
  check('E2 已新建（spawned=1）', '1', eSpawned);

  console.log('\n=== F. 进程活着但地址被 Cloudflare 回收（HTTP 530） → 也要重建 ===');
  const worldF = makeFakeWorld({ pid: LIVE_PID, publicUrl: 'https://reclaimed.trycloudflare.com', startedAt: Date.now() });
  const logsF = [];
  const tunnelF = createPersistentTunnel({
    binary: 'C:\\fake\\cloudflared.exe',
    runtimeDir: 'C:\\fake\\runtime',
    log: (line) => logsF.push(line),
    reuse: true,
    deps: {
      isAlive: () => true,
      httpStatus: async () => 530,                      // Cloudflare 回收后的典型码
      readRecord: () => worldF.state.record,
      writeRecord: (v) => { worldF.state.record = v; },
      spawnSupervisor: () => {
        worldF.state.spawned += 1;
        worldF.state.record = { pid: 5150, publicUrl: 'https://rebuilt.trycloudflare.com', startedAt: Date.now() };
        return { ok: true, pid: 5150 };
      },
      sleep: async () => {},
      now: () => Date.now(),
    },
  });
  const startedF = await tunnelF.start();
  check('F1 地址不可用 → 不复用', 'false', startedF.reused);
  check('F2 新地址 = rebuilt', 'https://rebuilt.trycloudflare.com', worldF.state.record.publicUrl);
  check('F3 日志写明不可用原因（HTTP 530）', 'true', logsF.some((l) => l.includes('530')));

  console.log('\n=== G. provider 层：顺序、稳定性判定与可操作说明 ===');
  const layer = createRemoteLayer({
    providers: ['cloudflared', 'tailscale'],
    port: 3080,
    cfEnabled: true,
    cfPersistent: false,
    log: () => {},
    announce: () => {},
    deps: {
      networkInterfaces: () => ({}),
      fileExists: (p) => /tailscale\.exe$/i.test(p),
      runCli: (args) => (args[0] === 'ip'
        ? { ok: false, stdout: '', stderr: 'state: NeedsLogin' }
        : { ok: false, stdout: LOGGED_OUT_STDOUT, stderr: '' }),
      platform: 'win32',
    },
  });
  console.log(`     provider 列表：${layer.providers.map((p) => p.name).join(', ')}`);
  console.log(`     note：${layer.note()}`);
  // 注意：provider 的装配顺序由 remote.js 归一化为"tailscale 在前"（固定地址优先、
  //      临时隧道在注），与用户传入的 ['cloudflared','tailscale'] 无关 —— 这是刻意的，
  //      因为临时隧道排前面会让手机优先去试一条注定过期的地址。
  check('G1 provider 装配顺序归一化为 tailscale→cloudflared', 'tailscale,cloudflared',
    layer.providers.map((p) => p.name).join(','));
  check('G2 未登录时 note 给出登录链接', 'true', layer.note().includes('login.tailscale.com'));
  check('G3 未登录时 note 说明可选增强（可操作）', 'true', /可选增强/.test(layer.note()));
  check('G4 只有临时隧道时 hasStable=false', 'false', layer.hasStable());
  check('G5 tailscale 状态可读且不崩', 'needs-login', layer.status().tailscale.state);

  // 手写固定 remoteBase → 视为稳定通道，且排在候选首位
  const layer2 = createRemoteLayer({
    providers: ['cloudflared'],
    remoteBase: 'https://my.fixed.domain',
    port: 3080,
    cfEnabled: false,
    log: () => {}, announce: () => {},
  });
  check('G6 配置的固定地址排在首位', 'https://my.fixed.domain', layer2.publicBases()[0]);
  check('G7 有固定地址 → hasStable=true', 'true', layer2.hasStable());

  // cloudflared provider 在未启用时也必须能安全回答
  const cfOff = createCloudflaredProvider({ enabled: false });
  check('G8 cloudflared 未启用：state=disabled', 'disabled', cfOff.status().state);
  check('G9 cloudflared 未启用：不崩且候选为空', '0', cfOff.publicBases().length);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n--- ${pass}/${results.length} 通过 ---`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log('失败项：');
    failed.forEach((r) => console.log(`  · ${r.name}（期望 ${r.expect}，实际 ${r.actual}）`));
  }
  console.log(failed.length === 0 ? 'RESULT: ALL PASS' : 'RESULT: FAILED');
  process.exit(failed.length === 0 ? 0 : 1);
})();
