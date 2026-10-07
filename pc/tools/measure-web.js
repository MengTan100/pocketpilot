// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:b1eb5abbca​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
'use strict';
/**
 * measure-web.js —— 量化 DSH Web 前端的加载成本，为延迟优化定位瓶颈。
 *
 * 会做三件事：
 *   1. 用自签 Cookie 进入桌面端实例，取首页 HTML；
 *   2. 解析其中的 <script src> / <link href>，逐个请求并记录体积与响应头
 *      （Content-Encoding / Cache-Control / ETag），判断可压缩与可缓存空间；
 *   3. 汇总总量，并给出优化建议。
 *
 * 用法: node measure-web.js [host:port] [--mobile]
 *   --mobile  额外经手机侧（adb reverse）测一次首页耗时，对比隧道开销
 */

const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mintCookie } = require('../lib/desktop-auth');

const target = process.argv.find((a) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) || '127.0.0.1:19387';
const [HOST, PORT] = [target.split(':')[0], Number(target.split(':')[1])];
const AUTHORITY = `${HOST}:${PORT}`;

function request(pathname, extraHeaders = {}, cookieValue) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.request({
      host: HOST,
      port: PORT,
      path: pathname,
      method: 'GET',
      headers: {
        Host: AUTHORITY,
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        ...(cookieValue ? { Cookie: cookieValue } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; });
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          bytes: size,
          ms,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const home = process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh');
  const cookie = mintCookie({ homeDir: home, authority: AUTHORITY });
  const cookieValue = `${cookie.name}=${cookie.value}`;

  console.log(`目标实例: ${AUTHORITY}\n`);

  const index = await request('/', {}, cookieValue);
  console.log(`首页: HTTP ${index.status}  ${human(index.bytes)}  ${index.ms.toFixed(1)}ms`);
  console.log(`   Content-Encoding: ${index.headers['content-encoding'] || '(无)'}`);
  console.log(`   Cache-Control   : ${index.headers['cache-control'] || '(无)'}`);
  console.log(`   ETag            : ${index.headers['etag'] || '(无)'}`);

  const html = index.body.toString('utf8');
  const assets = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^https?:\/\//i.test(ref)) continue;
    if (!/\.(js|mjs|css|woff2?|png|svg|json)(\?|$)/i.test(ref)) continue;
    assets.add(ref.startsWith('/') ? ref : `/${ref.replace(/^\.\//, '')}`);
  }

  console.log(`\n首页引用资源 ${assets.size} 个，逐个测量：\n`);
  console.log('  状态  原始大小    传输大小   编码     缓存             耗时     资源');
  let totalRaw = 0;
  let totalWire = 0;
  let cacheable = 0;
  let uncompressed = 0;
  const rows = [];

  for (const asset of Array.from(assets).sort()) {
    try {
      const res = await request(asset, {}, cookieValue);
      const enc = res.headers['content-encoding'] || '-';
      const cc = res.headers['cache-control'] || '(无)';
      const wire = res.bytes;
      const raw = Number(res.headers['content-length'] || 0) || wire;
      totalWire += wire;
      totalRaw += enc === '-' ? wire : Math.max(raw, wire);
      if (/immutable|max-age=\d{4,}/.test(cc)) cacheable += 1;
      if (enc === '-') uncompressed += 1;
      rows.push({ asset, status: res.status, wire, enc, cc, ms: res.ms });
      console.log(
        `  ${String(res.status).padEnd(5)} ${human(wire).padEnd(11)} ${human(wire).padEnd(10)} `
        + `${enc.padEnd(8)} ${cc.slice(0, 16).padEnd(17)} ${res.ms.toFixed(0).padStart(4)}ms  ${asset}`,
      );
    } catch (error) {
      console.log(`  失败  ${asset}: ${error.message}`);
    }
  }

  console.log('\n=== 汇总 ===');
  console.log(`资源总传输量 : ${human(totalWire)}`);
  console.log(`未压缩资源数 : ${uncompressed} / ${rows.length}`);
  console.log(`可长期缓存数 : ${cacheable} / ${rows.length}`);

  console.log('\n=== 优化建议 ===');
  if (uncompressed > 0) {
    console.log(`• 有 ${uncompressed} 个资源未压缩：由 Bridge 反代加 gzip/brotli 可显著减少传输量`);
  }
  if (cacheable < rows.length) {
    console.log(`• 有 ${rows.length - cacheable} 个资源缺少强缓存头：反代补 immutable 可让二次打开接近零传输`);
  }
  if (totalWire > 1024 * 1024) {
    console.log(`• 首页依赖 ${human(totalWire)}，冷启动必然偏慢：建议反代层做内存缓存 + 压缩`);
  }
  if (!/immutable|max-age/.test(index.headers['cache-control'] || '')) {
    console.log('• 首页 HTML 未设缓存策略：反代应设 no-cache（保留 ETag 校验）');
  }

  if (process.argv.includes('--mobile')) {
    console.log('\n=== 手机侧（经 adb reverse）对比 ===');
    const adb = ['C:\\AndroidSDK\\platform-tools\\adb.exe', 'C:\\android-sdk-x\\platform-tools\\adb.exe']
      .find((p) => require('node:fs').existsSync(p)) || 'adb';
    const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' }).split(/\r?\n/).slice(1)
      .map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === 'device');
    const serial = devices[0] ? devices[0][0] : null;
    if (!serial) {
      console.log('没有可用设备');
      return;
    }
    const sh = (cmd) => execFileSync(adb, ['-s', serial, 'shell', cmd], { encoding: 'utf8' }).trim();
    for (const asset of ['/', ...Array.from(assets).slice(0, 5)]) {
      const out = sh(`curl -sS -m 30 -o /dev/null -w '%{http_code} %{size_download} %{time_total}' http://127.0.0.1:${PORT}${asset}`);
      console.log(`  ${asset.padEnd(46)} -> ${out}`);
    }
  }
}

main().catch((error) => {
  console.error('[error]', error.message);
  process.exit(1);
});
