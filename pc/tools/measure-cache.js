// SPDX-License-Identifier: MIT
'use strict';
/**
 * measure-cache.js —— 针对 DSH 静态资源的缓存与传输特征做精确测量。
 *
 * 关注三件事（决定手机端二次打开能否接近瞬时）：
 *   1. 是否带 Cache-Control / ETag / Last-Modified（决定 WebView 能否复用缓存）；
 *   2. 实际传输体积（决定冷启动成本）；
 *   3. 同一资源二次请求耗时（判断是否走了 304 或本地缓存）。
 *
 * 用法: node measure-cache.js [host:port]
 */

const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { mintCookie } = require('../lib/desktop-auth');

const target = process.argv.find((a) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) || '127.0.0.1:19387';
const HOST = target.split(':')[0];
const PORT = Number(target.split(':')[1]);
const AUTHORITY = `${HOST}:${PORT}`;

const PATHS = [
  '/',
  '/assets/index-5SrrfWpU.js',
  '/assets/vendor-CCJJTK99.js',
  '/assets/vendor-BNsW4eBh.css',
  '/assets/index-BPHePDI_.css',
  '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=ef51cd359934',
  '/plugins/??@deepseek-ai/dsh-client-ui-conversation/client.js,@deepseek-ai/dsh-client-ui-chat/client.js,@deepseek-ai/dsh-client-ui-session/client.js&rev=8339cd9de3b3',
];

function req(pathname, cookieValue, extra = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const r = http.request({
      host: HOST, port: PORT, path: pathname, method: 'GET',
      headers: {
        Host: AUTHORITY,
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        ...(cookieValue ? { Cookie: cookieValue } : {}),
        ...extra,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        bytes: Buffer.concat(chunks).length,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
      }));
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, bytes: 0, ms: 0, error: e.message }));
    r.end();
  });
}

const human = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);

(async () => {
  const cookie = mintCookie({ homeDir: path.join(os.homedir(), '.dsh'), authority: AUTHORITY });
  const cv = `${cookie.name}=${cookie.value}`;

  console.log(`目标: ${AUTHORITY}\n`);
  let total = 0;
  let noCache = 0;
  for (const p of PATHS) {
    const r = await req(p, cv);
    total += r.bytes;
    const cc = r.headers['cache-control'] || '(无)';
    const etag = r.headers.etag || '(无)';
    const lm = r.headers['last-modified'] || '(无)';
    const ce = r.headers['content-encoding'] || '(无)';
    if (cc === '(无)') noCache += 1;
    console.log(`${String(r.status).padEnd(4)} ${human(r.bytes).padEnd(9)} ${ce.padEnd(5)} ${String(Math.round(r.ms)).padStart(4)}ms  ${p.slice(0, 62)}`);
    console.log(`     Cache-Control: ${cc}`);
    console.log(`     ETag: ${etag}   Last-Modified: ${lm}`);

    // 二次请求：验证是否走 304 / 本地缓存
    const again = await req(p, cv, r.headers.etag ? { 'If-None-Match': r.headers.etag } : {});
    console.log(`     二次(带 If-None-Match): HTTP ${again.status}  ${human(again.bytes)}  ${Math.round(again.ms)}ms\n`);
  }

  console.log('=== 汇总 ===');
  console.log(`样本总传输: ${human(total)}`);
  console.log(`无 Cache-Control 的资源: ${noCache}/${PATHS.length}`);

  // 手机侧（经 adb reverse）对比
  const adbCandidates = ['C:\\AndroidSDK\\platform-tools\\adb.exe', 'C:\\android-sdk-x\\platform-tools\\adb.exe'];
  const adb = adbCandidates.find((p) => fs.existsSync(p)) || 'adb';
  try {
    const devs = execFileSync(adb, ['devices'], { encoding: 'utf8' }).split(/\r?\n/).slice(1)
      .map((l) => l.trim().split(/\s+/)).filter((x) => x[1] === 'device');
    if (devs.length) {
      const serial = devs[0][0];
      console.log(`\n=== 手机侧（${serial}，经 adb reverse）===`);
      for (const p of ['/', '/assets/index-5SrrfWpU.js', '/assets/vendor-CCJJTK99.js']) {
        const out = execFileSync(adb, ['-s', serial, 'shell',
          `curl -sS -m 30 -o /dev/null -w '%{http_code} %{size_download} %{time_total}' 'http://127.0.0.1:${PORT}${p}'`],
        { encoding: 'utf8' }).trim();
        console.log(`  ${out.padEnd(28)} ${p}`);
      }
    }
  } catch (error) {
    console.log(`\n手机侧测量跳过: ${error.message}`);
  }
})();
