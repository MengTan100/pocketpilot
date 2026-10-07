#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:c0f0eb8b04​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
/**
 * 水印校验 / 解码器。
 *
 * 用法：
 *   node tools/watermark-check.mjs                 # 校验全部文件（退出码非 0 = 有水印缺失/被改）
 *   node tools/watermark-check.mjs --decode <文件> # 解码某个文件的水印（拿到被抄走的文件时用这个）
 *   node tools/watermark-check.mjs --quiet         # 只输出结论
 *
 * 校验两件事：
 *   ① 可见水印码 = sha256("dsh-phone-bridge|" + 相对路径) 前 10 位（任何人可复算，篡改路径即对不上）
 *   ② 隐形载荷解码后必须等于 PAYLOAD_TEXT（被删/被替换都会发现）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodePayloads, hasWatermark, visibleCode, watermarkCode, ruleFor,
  SKIP_DIRS, SKIP_FILES, JSON_TARGETS, PAYLOAD_TEXT, WM_PREFIX,
} from './watermark-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');
const di = process.argv.indexOf('--decode');

// ---------------------------------------------------------------- 解码模式
if (di !== -1) {
  const target = process.argv[di + 1];
  if (!target) {
    console.error('用法: node tools/watermark-check.mjs --decode <文件>');
    process.exit(2);
  }
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) {
    console.error(`文件不存在: ${abs}`);
    process.exit(2);
  }
  const text = fs.readFileSync(abs, 'utf8');
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const payloads = decodePayloads(text);
  const code = visibleCode(text);
  const expect = watermarkCode(rel);
  console.log('\n=== 水印解码 ===');
  console.log(`  文件      : ${rel}`);
  console.log(`  可见码    : ${code || '(无)'}`);
  console.log(`  按路径应为: ${expect}  →  ${code === expect ? '✅ 一致（确认是原始文件）' : '❌ 不一致（路径被改过，或不是本项目原始文件）'}`);
  console.log(`  隐形载荷  : ${payloads.length ? payloads.join(', ') : '(无)'}  →  ${payloads.includes(PAYLOAD_TEXT) ? '✅ 含本项目载荷' : '❌ 无本项目载荷'}`);
  console.log('');
  process.exit(code === expect && payloads.includes(PAYLOAD_TEXT) ? 0 : 1);
}

// ---------------------------------------------------------------- 校验模式
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.includes(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

const missing = [];
const codeBad = [];
const payloadBad = [];
let ok = 0;

for (const abs of walk(ROOT)) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (SKIP_FILES.has(rel)) continue;
  const rule = ruleFor(abs);
  if (!rule) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const code = visibleCode(text);
  const has = hasWatermark(text);
  if (!has) { missing.push(rel); continue; }
  if (code !== watermarkCode(rel)) { codeBad.push(`${rel}  (文件里 ${code || '无'} / 应为 ${watermarkCode(rel)})`); continue; }
  if (!decodePayloads(text).includes(PAYLOAD_TEXT)) { payloadBad.push(rel); continue; }
  ok++;
}

for (const rel of JSON_TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  try {
    const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const w = j._watermark;
    if (w && w.project === 'dsh-phone-bridge' && w.origin === watermarkCode(rel)) ok++;
    else missing.push(`${rel}  (JSON 字段水印缺失或不符)`);
  } catch { missing.push(`${rel}  (JSON 解析失败)`); }
}

console.log('\n=== 水印校验 ===');
if (!QUIET) {
  for (const f of missing) console.log(`  ❌ 缺水印: ${f}`);
  for (const f of codeBad) console.log(`  ❌ 可见码不符: ${f}`);
  for (const f of payloadBad) console.log(`  ❌ 隐形载荷缺失: ${f}`);
}
console.log(`  通过 ${ok} 个 · 缺水印 ${missing.length} · 码不符 ${codeBad.length} · 载荷缺失 ${payloadBad.length}`);
const bad = missing.length + codeBad.length + payloadBad.length;
if (bad) {
  console.log(`\n结果：${bad} 个文件的水印有问题。`);
  console.log('  新增文件忘记打水印 → 跑 node tools/watermark-apply.mjs');
  console.log('  水印被移除/篡改   → 说明代码可能被搬运过，见 WATERMARK.md');
  process.exit(1);
} else {
  console.log(`\n结果：全部通过 ✅（载荷明文 ${PAYLOAD_TEXT}，前缀 ${WM_PREFIX}）`);
}
