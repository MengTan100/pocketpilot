// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:cec5afee48​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
/**
 * 水印公共库 —— 常量与编解码。
 *
 * ⚠️ 这里的常量必须与**已经打上的水印**保持一致：
 *    改动 PROJECT_ID / PAYLOAD_TEXT 会让所有既有水印校验失败（除非跑 --force 重打）。
 *    详细说明见 WATERMARK.md。
 */
import crypto from 'node:crypto';

/** 项目标识（参与每个文件可见水印码的哈希）。 */
export const PROJECT_ID = 'dsh-phone-bridge';
/** 隐形载荷明文；解码后必须完全等于它。 */
export const PAYLOAD_TEXT = 'DSPB2026';
/** 零宽位编码：0 = U+200B，1 = U+200C。 */
export const ZW_ZERO = '\u200b';
export const ZW_ONE = '\u200c';
/** 隐形载荷的正则（连续的一段零宽字符）。 */
export const ZW_RUN = /[\u200b\u200c]+/g;
/** 水印行的可见前缀。 */
export const WM_PREFIX = 'wm:';
/** 版权行标志（用于识别/剔除水印）。 */
export const COPY_LINE = 'DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md';
export const COPY_LINE_MD = 'DSH Phone Bridge 原创项目 · 见 WATERMARK.md';
export const SPDX_LINE = 'SPDX-License-Identifier: MIT';

/** 由项目名 + 相对路径推出该文件专属的可见水印码（10 位十六进制）。 */
export function watermarkCode(rel) {
  return crypto.createHash('sha256').update(`${PROJECT_ID}|${String(rel).split('\\').join('/')}`).digest('hex').slice(0, 10);
}

/** 把载荷编码成零宽字符串。 */
export function encodePayload(text = PAYLOAD_TEXT) {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  for (const b of bytes) for (let i = 7; i >= 0; i--) out += (b >> i) & 1 ? ZW_ONE : ZW_ZERO;
  return out;
}

/** 从任意文本里解出所有零宽载荷，返回去重后的明文数组。 */
export function decodePayloads(text) {
  const out = [];
  for (const run of String(text).match(ZW_RUN) || []) {
    let bits = '';
    for (const ch of run) bits += ch === ZW_ONE ? '1' : '0';
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    try {
      const s = Buffer.from(bytes).toString('utf8');
      if (s && !out.includes(s)) out.push(s);
    } catch { /* 忽略非法字节序列 */ }
  }
  return out;
}

/** 文本是否带本项目水印。 */
export function hasWatermark(text) {
  return (String(text).match(ZW_RUN) || []).some((run) => decodePayloads(run).includes(PAYLOAD_TEXT));
}

/** 从文本里抓出可见水印码（`wm:xxxxxxxxxx`）。 */
export function visibleCode(text) {
  const m = String(text).match(new RegExp(`${WM_PREFIX}([0-9a-f]{10})`));
  return m ? m[1] : null;
}

// ── 覆盖范围（必须与 watermark-apply.mjs 一致）───────────────────────────────
export const RULES = [
  { ext: ['.js', '.mjs', '.cjs', '.ts', '.kt', '.kts', '.gradle', '.java'], kind: 'line', token: '//' },
  { ext: ['.py', '.sh', '.ps1', '.yml', '.yaml'], kind: 'line', token: '#' },
  { ext: ['.bat', '.cmd'], kind: 'line', token: 'REM' },
  { ext: ['.xml', '.html'], kind: 'block', open: '<!--', close: '-->' },
  { ext: ['.md'], kind: 'md' },
];
export const SKIP_DIRS = ['.git', 'node_modules', 'build', '.gradle', '.idea', 'icon-out', 'toolpkg-src', 'logs', 'runtime'];
export const SKIP_FILES = new Set(['pc/bridge.config.json', 'phone/set-lan-env.js', 'security-denylist.local.txt']);
export const JSON_TARGETS = ['pc/package.json', 'pc/dsh-plugin-phone-bridge/package.json'];

export function ruleFor(file) {
  const ext = String(file).slice(String(file).lastIndexOf('.')).toLowerCase();
  for (const r of RULES) if (r.ext.includes(ext)) return r;
  return null;
}
