// SPDX-License-Identifier: MIT
/**
 * 验证 401 自愈重试时请求体是否被完整重发。
 *
 * 背景（真机日志实测到的故障）：
 *   [18:20:59] proxy POST /api/dynamicCordisRunner/syncInspectManifest -> 408 (323106ms)
 *   请求挂死 323 秒。根因是旧实现用 req.pipe(proxyReq) 转发，
 *   第一次就把请求流读空；401 重试时上游收到 content-length>0 却永远等不到 body。
 *
 * 本测试用"第一次 401、第二次 200"的假上游复现该场景，断言第二次收到完整 body。
 */
import http from 'node:http';
import { createDshProxy } from '../lib/dsh-proxy.js';

const received = [];
let first = true;
const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        received.push({ url: req.url, len: body.length, method: req.method });
        if (first) {
            first = false;
            res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
        } else {
            res.writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ ok: true, receivedLen: body.length }));
        }
    });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;

const proxy = createDshProxy({
    getUpstream: () => ({
        host: '127.0.0.1', port: upstreamPort,
        authority: '127.0.0.1:19387', cookie: 'dsh-auth-test=1',
    }),
    refreshUpstream: () => {},
    log: (m) => console.log('  [proxy]', m),
});

const proxyServer = http.createServer((req, res) => proxy.handleRequest(req, res));
await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r));
const proxyPort = proxyServer.address().port;

// —— 场景1：带体 POST，上游先 401 再 200 ——
const payload = '{"hello":"world","pad":"' + 'X'.repeat(20000) + '"}';
console.log('=== 场景1：POST 带 20014 字节请求体，上游第一次回 401 ===');
const res = await fetch(`http://127.0.0.1:${proxyPort}/dsh/api/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
});
const text = await res.text();
console.log('  客户端收到 :', res.status, text);
console.log('  上游收到   :', JSON.stringify(received));

const bodyLens = received.map((r) => r.len);
const ok1 = res.status === 200
    && received.length === 2
    && bodyLens[1] === payload.length
    && bodyLens[1] === bodyLens[0];
console.log(ok1
    ? '  ✅ 重试带上了完整请求体（修复生效）'
    : '  ❌ 重试请求体丢失或不完整（bug 仍在）');

// —— 场景2：GET（无体），确认重试路径没被破坏 ——
first = true;
received.length = 0;
console.log('\n=== 场景2：GET（无请求体）第一次 401 ===');
const res2 = await fetch(`http://127.0.0.1:${proxyPort}/dsh/api/ping`, { method: 'GET' });
console.log('  客户端收到 :', res2.status, await res2.text());
console.log('  上游收到   :', JSON.stringify(received));
const ok2 = res2.status === 200 && received.length === 2;
console.log(ok2 ? '  ✅ GET 重试正常' : '  ❌ GET 重试异常');

proxyServer.close();
upstream.close();
process.exit(ok1 && ok2 ? 0 : 1);
