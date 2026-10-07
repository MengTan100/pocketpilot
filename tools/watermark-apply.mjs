#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:75a1cb200a​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
/**
 * 水印注入器 —— 给源码与文档打上**多层、可验证**的原创水印。
 * （本文件自身的水印由 watermark-apply.mjs 自动补，见 WATERMARK.md）
 *
 * 设计原则（重要，别改坏）：
 *   1. **只动注释**。隐形字符一律只出现在注释里，绝不进入代码、字符串字面量或数据。
 *      这样任何编译器/解释器/打包器都不会受影响，也不会形成"trojan source"式的隐患。
 *   2. **完全公开**。所有水印的形式、位置、解码方式都写在 WATERMARK.md 里。
 *      水印的目的是"证明出处"，不是"藏后门"——偷偷埋东西反而会被当成恶意代码。
 *   3. **可验证**。每个文件的可见码由"项目名+文件路径"哈希得出，任何人可复算；
 *      隐形载荷是固定串，tools/watermark-check.mjs 可一键校验或解码。
 *   4. **幂等**。已经打过的不重复打；`--force` 可重写（会先删掉旧水印）。
 *
 * 用法：
 *   node tools/watermark-apply.mjs            # 给缺水印的文件补上
 *   node tools/watermark-apply.mjs --dry      # 只看会改哪些文件
 *   node tools/watermark-apply.mjs --force    # 重写全部（替换旧水印）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_ID, PAYLOAD_TEXT, WM_PREFIX, COPY_LINE, COPY_LINE_MD, SPDX_LINE,
  watermarkCode, encodePayload, hasWatermark,
  SKIP_DIRS, SKIP_FILES, JSON_TARGETS, ruleFor,
} from './watermark-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.includes(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

/** 生成可见水印行（隐形载荷挂在第三行）。 */
function headerLines(rel, rule) {
  const code = watermarkCode(rel);
  const payload = encodePayload();
  const text = [SPDX_LINE, COPY_LINE, `${WM_PREFIX}${code}${payload}`];
  if (rule.kind === 'line') return text.map((t) => `${rule.token} ${t}`);
  return [`${rule.open}`, ...text.map((t) => `  ${t}`), `${rule.close}`];
}

/** 去掉旧水印（--force 用）。 */
function stripWatermark(text) {
  return text
    .split('\n')
    .filter((l) => !(hasWatermark(l) || l.includes(SPDX_LINE) || l.includes(COPY_LINE) || l.includes(COPY_LINE_MD)))
    .join('\n');
}

/** 插入位置：必须在 shebang / XML 声明 / Python 编码声明 / .bat @echo off 之后。 */
function insertIndex(lines, rel, rule) {
  let i = 0;
  if (lines[0] && lines[0].startsWith('#!')) i = 1;
  if (rule.kind === 'block' && lines[i] && /^\s*<\?xml/.test(lines[i])) i += 1;
  if (/\.py$/i.test(rel) && lines[i] && /coding[:=]/.test(lines[i])) i += 1;
  if (/\.(bat|cmd)$/i.test(rel) && lines[i] && /@echo\s+off/i.test(lines[i])) i += 1;
  return i;
}

const report = { added: [], skipped: [], json: [] };

for (const abs of walk(ROOT)) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (SKIP_FILES.has(rel)) continue;
  const rule = ruleFor(abs);
  if (!rule) continue;
  let text = fs.readFileSync(abs, 'utf8');

  // 文档：水印放**尾部** HTML 注释 —— 渲染后看不见，源码里可见
  if (rule.kind === 'md') {
    if (hasWatermark(text) && !FORCE) { report.skipped.push(rel); continue; }
    if (FORCE) text = stripWatermark(text);
    const code = watermarkCode(rel);
    text = `${text.replace(/\s*$/, '')}\n\n<!-- ${WM_PREFIX}${code}${encodePayload()} · ${COPY_LINE_MD} -->\n`;
    if (!DRY) fs.writeFileSync(abs, text, 'utf8');
    report.added.push(rel);
    continue;
  }

  if (hasWatermark(text) && !FORCE) { report.skipped.push(rel); continue; }
  if (FORCE) text = stripWatermark(text);

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  lines.splice(insertIndex(lines, rel, rule), 0, ...headerLines(rel, rule));
  if (!DRY) fs.writeFileSync(abs, lines.join(eol), 'utf8');
  report.added.push(rel);
}

// JSON：用字段水印（JSON 无注释，字段是唯一不破坏语法的做法）
for (const rel of JSON_TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
  const want = { project: PROJECT_ID, origin: watermarkCode(rel), license: 'MIT', notice: '见 WATERMARK.md' };
  if (JSON.stringify(obj._watermark) === JSON.stringify(want) && !FORCE) { report.skipped.push(rel); continue; }
  obj._watermark = want;
  if (!DRY) fs.writeFileSync(abs, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  report.json.push(rel);
}

console.log(`\n=== 水印注入${DRY ? '（演练）' : ''} ===`);
console.log(`  新增/更新: ${report.added.length + report.json.length} 个文件`);
if (!DRY) {
  for (const f of report.added) console.log(`    + ${f}`);
  for (const f of report.json) console.log(`    + ${f}  (JSON 字段水印)`);
}
console.log(`  已具备（跳过）: ${report.skipped.length} 个`);
console.log(`  载荷明文: ${PAYLOAD_TEXT}（编码为零宽字符，仅存在于注释中）`);
if (DRY) console.log('  （演练模式，未写盘）');
