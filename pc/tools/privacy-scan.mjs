// SPDX-License-Identifier: MIT
/**
 * privacy-scan.mjs —— 发布前隐私/密钥扫描（APK / 插件包 / 仓库三处一起查）。
 *
 * 为什么需要它：发布包里最危险的不是代码，而是**本机凭据**——
 * bridge token、API key、真实姓名/路径、设备序列号。之前 LinkSelfTest 里
 * 就写死过一个真实 bridge token（已清除并改写历史）。
 *
 * 用法:
 *   node privacy-scan.mjs --dir <解包目录> [--dir ...]
 *   node privacy-scan.mjs --zip <包.zip>
 *   node privacy-scan.mjs --git                 # 扫描 git 已跟踪文件的全部提交？
 *   默认（不带参数）= --git（工作区已跟踪文件）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// ⚠️ 必须用 fileURLToPath：路径里含中文（谭猛）时 URL 是百分号编码的，
// 直接拿 pathname 会得到一个不存在的目录（曾导致 spawnSync git ENOENT）。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function bridgeToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'pc', 'bridge.config.json'), 'utf8'));
    return String(cfg.bridgeToken || '');
  } catch {
    return '';
  }
}

function patterns() {
  const tok = bridgeToken();
  const out = [
    { name: 'bridge token（本机真实凭据）', re: tok ? new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null },
    { name: '真实姓名', re: /谭猛/ },
    { name: 'QQ / 邮箱号', re: /1655077418/ },
    { name: '手机设备序列号', re: /a9da9b93/ },
    { name: 'OpenAI 风格 key', re: /sk-[A-Za-z0-9_-]{20,}/ },
    { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
    { name: 'GitHub 细粒度 token', re: /github_pat_[A-Za-z0-9_]{20,}/ },
    { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
    { name: '私钥头', re: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/ },
    { name: 'Windows 用户目录', re: /C:\\Users\\/i },
    { name: '签名口令字面量', re: /storePassword\s*=\s*["'][^"']{4,}["']/ },
  ];
  return out.filter((p) => p.re);
}

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.so', '.jar']);

function scanBuffer(buf, label, pats, hits) {
  if (!buf || buf.length === 0) return;
  let text = buf.toString('latin1');
  if (buf.length < 8 * 1024 * 1024) text += '\n' + buf.toString('utf8');
  for (const p of pats) {
    const m = text.match(p.re);
    if (m) hits.push({ where: label, what: p.name, sample: String(m[0]).slice(0, 24) });
  }
}

function walk(dir, pats, hits) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, pats, hits); continue; }
    const ext = path.extname(entry.name).toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    let buf;
    try { buf = fs.readFileSync(full); } catch { continue; }
    scanBuffer(buf, path.relative(dir, full), pats, hits);
  }
}

function scanZip(file, pats, hits) {
  const data = fs.readFileSync(file);
  // 简易 zip 解析：遍历本地文件头，解压 stored/deflate 内容
  let i = 0;
  while (i < data.length - 30) {
    if (data.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const method = data.readUInt16LE(i + 8);
    const compSize = data.readUInt32LE(i + 18);
    const nameLen = data.readUInt16LE(i + 26);
    const extraLen = data.readUInt16LE(i + 28);
    const name = data.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const raw = data.subarray(start, start + compSize);
    let buf = null;
    try {
      if (method === 0) buf = raw;
      else if (method === 8) buf = zlib.inflateRawSync(raw);
    } catch { buf = null; }
    if (buf) scanBuffer(buf, `${path.basename(file)}:${name}`, pats, hits);
    i = start + compSize;
  }
}

function scanGit(pats, hits) {
  // Node 子进程不一定继承 PATH 里的 git，按常见位置兜底（Windows）
  const gitCandidates = [
    process.env.GIT_EXE,
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\msys64\\usr\\bin\\git.exe',
    'git',
  ].filter(Boolean);
  let git = null;
  for (const c of gitCandidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); git = c; break; } catch { /* 试下一个 */ }
  }
  if (!git) throw new Error('找不到 git，可用 GIT_EXE 环境变量指定');
  const files = execFileSync(git, ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
  for (const rel of files) {
    const full = path.join(repoRoot, rel);
    let buf;
    try { buf = fs.readFileSync(full); } catch { continue; }
    scanBuffer(buf, rel, pats, hits);
  }
  return files.length;
}

const args = process.argv.slice(2);
const pats = patterns();
const hits = [];
let scanned = 0;
if (args.length === 0) args.push('--git');
for (let a = 0; a < args.length; a++) {
  const flag = args[a];
  if (flag === '--git') { scanned += scanGit(pats, hits); continue; }
  if (flag === '--dir' && args[a + 1]) { walk(args[a + 1], pats, hits); a++; continue; }
  if (flag === '--zip' && args[a + 1]) { scanZip(args[a + 1], pats, hits); a++; continue; }
}

console.log(`扫描完成：${scanned} 个仓库文件 + 指定目录/压缩包；命中 ${hits.length} 条`);
for (const h of hits) console.log(`  ⚠ ${h.where} → ${h.what}（样例 ${JSON.stringify(h.sample)}）`);
if (hits.length === 0) console.log('  ✔ 未发现真实凭据 / 姓名 / 设备号 / key 形态');
process.exit(hits.length === 0 ? 0 : 1);
