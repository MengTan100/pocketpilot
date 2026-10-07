// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:0f882ec7e3​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
'use strict';
/**
 * dsh-proxy.js —— 把只监听回环的 DSH 实例反向代理给手机（含 WebSocket）。
 *
 * 为什么必须走代理：
 *   DSH 明确拒绝绑定 0.0.0.0 ——
 *   `error: --host 0.0.0.0 is intentionally not supported yet for safety:
 *    it would expose remote code execution to the network; use 127.0.0.1 instead`
 *   因此"让 DSH 自己监听局域网"这条路被官方设计封死。
 *   正确做法是：DSH 继续只绑 127.0.0.1，由桥接进程对外提供入口，并在转发时
 *   完成鉴权注入与 Host/Origin 改写。
 *
 * 这个代理同时解决三件事：
 *   1. 局域网可用（手机经 WiFi 访问桥接，桥接转发到回环上的 DSH）；
 *   2. 手机在局域网下也能连上"桌面端实例"，从而看到当前对话与正在跑的任务；
 *   3. 顺手给主入口 /assets/* 补上强缓存头（DSH 自带产物里这几项没有缓存头）。
 *
 * 路径约定：手机访问 /dsh/<path>  →  上游 /<path>
 *   DSH 首页用 <base href="./">，相对路径会自动落到 /dsh/ 之下，无需改写 HTML。
 *
 * WebSocket：DSH 的实时流走 HTTP Upgrade（server.registerUpgrade + WebSocketServer），
 * 这里用原始 socket 双向 pipe 转发，握手头原样带上。
 */

const http = require('node:http');
const net = require('node:net');

/** 逐跳头不应转发。 */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

const PREFIX = '/dsh';

/**
 * 走代理的请求体上限。
 * 本地 /fs/upload（手机文件上传，可达数十 MB）**不经过这里**，所以正常代理请求体都很小；
 * 留 16MB 只是为了容忍会话导出、图片粘贴这类中等体积请求。
 */
const MAX_BODY_BUFFER = 16 * 1024 * 1024;

/**
 * 上游"空闲"多久算卡死。
 * 必须设：上游一旦不对某次请求作答，手机端那个请求会永久挂着，
 * 表现就是消息一直"发送中…"、对话状态不再同步（实测曾挂 323 秒）。
 * 这里主动断开并回 504，让页面能拿到明确失败、进而自己重试。
 */
const UPSTREAM_IDLE_TIMEOUT_MS = 120000;

/** 该路径是否属于带内容哈希的静态产物（可长期强缓存）。 */
function isImmutableAsset(pathname) {
    return /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(js|mjs|css|woff2?|png|svg|jpg|webp)$/.test(pathname)
        || pathname.startsWith('/plugins/');
}

function strippedPath(url) {
    const q = url.indexOf('?');
    const pathname = q === -1 ? url : url.slice(0, q);
    const search = q === -1 ? '' : url.slice(q);
    let rest = pathname.slice(PREFIX.length);
    if (rest === '' || rest === '/') rest = '/';
    if (rest.charAt(0) !== '/') rest = '/' + rest;
    return rest + search;
}

/**
 * @param {object} options
 * @param {() => ({host:string, port:number, authority:string, cookie:string}|null)} options.getUpstream
 * @param {(msg:string)=>void} [options.log]
 * @param {() => void} [options.refreshUpstream]
 */
function createDshProxy(options) {
    const getUpstream = options.getUpstream;
    const log = options.log || (() => {});

    /** 组装转发头：Host/Origin/Cookie 必须由本代理改写（满足上游 authority 校验）。 */
    function buildHeaders(sourceHeaders, upstream, bodyLength) {
        const headers = {};
        for (const [key, value] of Object.entries(sourceHeaders)) {
            if (HOP_BY_HOP.has(key.toLowerCase())) continue;
            headers[key] = value;
        }
        headers.host = upstream.authority;
        headers.origin = `http://${upstream.authority}`;
        if (upstream.cookie) headers.cookie = upstream.cookie;
        if (bodyLength !== null) headers['content-length'] = String(bodyLength);
        return headers;
    }

    /**
     * 把请求发给上游。
     *
     * @param {Buffer|null} body 已缓冲的请求体；null 表示无体（GET/HEAD）。
     *
     * 为什么请求体要"先缓冲再转发"（本文件最关键的一处修复）：
     *   401 自愈重试时必须把请求体**原样重发**。旧实现是 entry 里直接
     *   `req.pipe(proxyReq)`，第一次就把 req 流读空了；发生 401 重试时，
     *   上游收到 content-length>0 却永远等不到 body，于是这个请求挂死
     *   （实测挂 323 秒后 408）。手机端那条 POST 就永远停在"发送中…"，
     *   对话状态也随之不再同步。
     */
    function relay(req, res, upstream, sourceHeaders, target, body, attempt) {
        const headers = buildHeaders(sourceHeaders, upstream, body === null ? null : body.length);
        const started = Date.now();

        const proxyReq = http.request({
            host: upstream.host,
            port: upstream.port,
            method: req.method,
            path: target,
            headers,
        }, (proxyRes) => {
            // 认证失效自愈：DSH 桌面端重启 / 轮换签名密钥后，手里的 cookie 会失效（上游回 401）。
            // 重新签一次并**带原请求体重试一次**，而不是把 401 透传给手机 ——
            // 手机端看到 "dsh web authentication required" 只会干等，表现就是"App 打不开"。
            if (proxyRes.statusCode === 401
                && attempt === 0
                && typeof options.refreshUpstream === 'function') {
                log(`上游 401（会话 cookie 可能已失效），重新签名后重试: ${target}`);
                proxyRes.resume();               // 丢弃这次响应体
                options.refreshUpstream();
                const next = getUpstream();
                if (next) {
                    relay(req, res, next, sourceHeaders, target, body, attempt + 1);
                    return;
                }
            }

            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['set-cookie'];              // 上游 cookie 由桥接自己维护
            delete outHeaders['content-security-policy']; // 允许手机端 CSS 注入生效
            if (isImmutableAsset(target.split('?')[0]) && !outHeaders['cache-control']) {
                outHeaders['cache-control'] = 'public, max-age=31536000, immutable';
            }
            res.writeHead(proxyRes.statusCode || 502, outHeaders);
            proxyRes.pipe(res);
            if (target === '/' || target.startsWith('/api/')) {
                log(`proxy ${req.method} ${target} -> ${proxyRes.statusCode} (${Date.now() - started}ms)`);
            }
        });

        // 空闲超时兜底：上游长时间不吐任何数据就断开，绝不把手机端永久挂住。
        proxyReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
            log(`上游空闲超时 ${UPSTREAM_IDLE_TIMEOUT_MS}ms，断开: ${target}`);
            proxyReq.destroy(new Error('上游空闲超时'));
        });

        proxyReq.on('error', (error) => {
            log(`proxy 转发失败 ${target}: ${error.message}`);
            if (!res.headersSent) {
                res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
            }
            res.end(`上游转发失败: ${error.message}\n`);
        });

        if (body === null) req.pipe(proxyReq);
        else proxyReq.end(body);
    }

    /** HTTP 转发入口：先把请求体缓冲好（可重发），再交给 relay。 */
    function handleRequest(req, res) {
        const upstream = getUpstream();
        if (!upstream) {
            res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('DSH 上游不可用\n');
            return;
        }

        const target = strippedPath(req.url);
        const sourceHeaders = { ...req.headers };

        if (req.method === 'GET' || req.method === 'HEAD') {
            relay(req, res, upstream, sourceHeaders, target, null, 0);
            return;
        }

        // 有体请求：整体缓冲后再转发，这样 401 重试才能把 body 原样重发。
        const chunks = [];
        let size = 0;
        let aborted = false;

        req.on('data', (chunk) => {
            if (aborted) return;
            size += chunk.length;
            if (size > MAX_BODY_BUFFER) {
                aborted = true;
                chunks.length = 0;
                log(`请求体过大(${size}B)，拒绝转发: ${target}`);
                try {
                    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
                    res.end('请求体过大\n');
                } catch { /* 忽略：可能已断开 */ }
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (aborted) return;
            relay(req, res, upstream, sourceHeaders, target, Buffer.concat(chunks), 0);
        });

        req.on('error', () => {
            if (aborted) return;
            aborted = true;
            try {
                if (!res.headersSent) {
                    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                }
                res.end('请求体读取失败\n');
            } catch { /* 忽略 */ }
        });
    }

    /** WebSocket（HTTP Upgrade）转发：用原始 socket 双向 pipe。 */
    function handleUpgrade(req, socket, head) {
        const upstream = getUpstream();
        if (!upstream) {
            socket.destroy();
            return;
        }

        const target = strippedPath(req.url);
        const lines = [`GET ${target} HTTP/1.1`];
        for (const [key, value] of Object.entries(req.headers)) {
            const lower = key.toLowerCase();
            // host/origin/cookie 必须由本代理重写：既满足上游的 authority 校验，
            // 也避免同名头重复出现导致上游判定请求非法（曾经因此让 WS 反复重连）。
            if (lower === 'host' || lower === 'origin' || lower === 'cookie') continue;
            lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
        }
        lines.push(`Host: ${upstream.authority}`);
        lines.push(`Origin: http://${upstream.authority}`);
        if (upstream.cookie) lines.push(`Cookie: ${upstream.cookie}`);

        const startedAt = Date.now();
        const upstreamSocket = net.connect(upstream.port, upstream.host, () => {
            upstreamSocket.write(lines.join('\r\n') + '\r\n\r\n');
            if (head && head.length) upstreamSocket.write(head);
            upstreamSocket.pipe(socket);
            socket.pipe(upstreamSocket);
        });

        // 移动端保活：USB/无线链路可能"静默断掉"（对端消失但没有 FIN）。
        // 没有 TCP keepalive 时浏览器拿不到 close 事件，页面会一直以为自己连着，
        // 于是对话状态永远不再更新（表现为"不同步、刷新一下才好"）。
        // 15 秒探测一次，让死链在十几秒内被内核发现并关闭，DSH 自己的重连逻辑才能接上。
        try {
            socket.setKeepAlive(true, 15000);
            upstreamSocket.setKeepAlive(true, 15000);
            socket.setNoDelay(true);
            upstreamSocket.setNoDelay(true);
        } catch { /* 部分环境下不支持，忽略 */ }

        // 记录上游握手结果（101 才算成功），便于定位 WS 问题
        upstreamSocket.once('data', (chunk) => {
            const firstLine = chunk.toString('utf8', 0, Math.min(96, chunk.length)).split('\r\n')[0];
            log(`proxy WS ${target} <- ${firstLine}`);
        });

        const cleanup = () => {
            upstreamSocket.destroy();
            socket.destroy();
        };
        upstreamSocket.on('error', cleanup);
        socket.on('error', cleanup);
        upstreamSocket.on('close', () => {
            log(`proxy WS ${target} 关闭（持续 ${Math.round((Date.now() - startedAt) / 1000)}s）`);
            socket.destroy();
        });
        socket.on('close', () => upstreamSocket.destroy());
    }

    return { handleRequest, handleUpgrade, PREFIX };
}

module.exports = { createDshProxy, PREFIX, strippedPath };
