#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:4e9102948d​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
/**
 * 安全与隐私自检 —— 把 SECURITY.md 里的铁律变成可执行断言。
 *
 * 用法：
 *   node tools/security-check.mjs          # 检查，退出码非 0 表示不可提交
 *   node tools/security-check.mjs --all    # 连"被忽略的文件"也一并报出来（看看本机有没有残留）
 *
 * 设计原则：
 *   1) 检查的是"**会不会被提交**"，而不是"磁盘上有没有" —— 被 .gitignore 正确忽略的
 *      运行时文件（如 pc/runtime/bridge-runtime.json）是合法存在的，不该报错。
 *      有 git 时用 `git check-ignore` 判定；没有 git 时退回内置忽略表。
 *   2) 真实的个人值（你的姓名/序列号/网段）**不写进本脚本** —— 那等于又泄露一次。
 *      要精确拦截自己的值，把它们放进 `security-denylist.local.txt`（已被忽略）。
 *   3) 只做"能证明的"判断，不猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
// 水印常量与判定复用同一份库，避免两处漂移
import {
  PROJECT_ID, watermarkCode, hasWatermark, visibleCode, ruleFor,
  SKIP_FILES as WM_SKIP_FILES, JSON_TARGETS,
} from './watermark-lib.mjs';

// ⚠️ 不要用 new URL(...).pathname：它会把非 ASCII（中文用户名）百分号编码，
//    导致 scandir 找不到目录。fileURLToPath 才会正确解码。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOW_ALL = process.argv.includes('--all');

const results = [];
const pass = (name, note = '') => results.push({ ok: true, name, note });
const fail = (name, hits) => results.push({ ok: false, name, hits: hits.slice(0, 12), more: Math.max(0, hits.length - 12) });

// ---------------------------------------------------------------- 工具

const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', '.gradle', '.idea', 'icon-out']);
const TEXT_EXT = new Set(['.kt', '.java', '.js', '.mjs', '.ts', '.json', '.xml', '.md', '.properties',
  '.yml', '.yaml', '.txt', '.bat', '.ps1', '.sh', '.gradle', '.kts', '.py', '.css', '.html', '.log', '.gitignore']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

let hasGit = fs.existsSync(path.join(ROOT, '.git'));
function gitIgnored(rel) {
  if (!hasGit) return null;
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** 没有 git 时的兜底判定：按 SECURITY.md 里那几类路径前缀。 */
const FALLBACK_IGNORE = [
  /^pc\/bridge\.config\.json$/, /^pc\/runtime\//, /^pc\/logs\//, /^pc\/tools\/bin\//,
  /^pc\/tools\/ui\.xml$/, /^pc\/tools\/.*\.png$/, /^apk\//, /^phone\/toolpkg_cache\//,
  /^phone\/[^/]*\.png$/, /^phone\/[^/]*\.log$/, /^phone\/logs\//, /^phone\/[^/]*\.toolpkg$/,
  /^phone\/PackageManager\.xml\./, /^phone\/apk-icons\//, /^phone\/app-android\/tools\/icon-out\//,
  /^phone\/app-android\/local\.properties$/, /^node_modules\//, /\/build\//, /^\.gradle\//,
  /^security-denylist\.local\.txt$/, /^phone\/set-lan-env\.js$/,
  // 已废弃的 Operit ToolPkg 方案（.gitignore 里同样排除）：侵入式改写第三方 App 私有数据
  /^phone\/toolpkg-src\//, /^phone\/(build|install|patch|purge|test)-[a-z0-9.-]*\.(js|sh)$/,
];
function isIgnored(rel) {
  const g = gitIgnored(rel);
  if (g !== null) return g;
  return FALLBACK_IGNORE.some((re) => re.test(rel));
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const read = (abs) => fs.readFileSync(abs, 'utf8');

// ---------------------------------------------------------------- 收集文件

const allFiles = walk(ROOT).map(rel);
const wouldCommit = allFiles.filter((r) => !isIgnored(r));

// ---------------------------------------------------------------- 1. 明文凭据

{
  const hits = [];
  for (const r of wouldCommit) {
    if (!TEXT_EXT.has(path.extname(r)) && !r.endsWith('.gitignore')) continue;
    const abs = path.join(ROOT, r);
    if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
    const text = read(abs);
    text.split(/\r?\n/).forEach((line, i) => {
      // 32+ 位的高熵串（base64url / hex），且不是明显的占位符、哈希常量或示例
      const m = line.match(/["'`=:\s]([A-Za-z0-9_-]{32,})["'`\s,;)]/);
      if (!m) return;
      const v = m[1];
      if (/^<.*>$/.test(v)) return;                       // 占位符
      if (/^(0{8,}|1{8,}|[a-f0-9]{32,})$/.test(v) && /sha|hash|integrity/i.test(line)) return;
      if (/node_modules|package-lock|pnpm-lock/.test(r)) return;
      // 令牌上下文才算：bridgeToken / token / secret / key / k=
      if (!/\b(bridgeToken|token|secret|api[_-]?key|password|passwd|auth[_-]?code)\b|k=/i.test(line)) return;
      hits.push(`${r}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  hits.length ? fail('① 明文凭据/令牌未入库', hits) : pass('① 明文凭据/令牌未入库');
}

// ---------------------------------------------------------------- 2. 个人信息

// 允许出现的"示例用"私有地址：文档/占位符里必须举例，统一用这一个（非你真实网段）。
const EXAMPLE_IPS = new Set(['192.168.1.100']);

{
  const hits = [];
  const denylistFile = path.join(ROOT, 'security-denylist.local.txt');
  const denylist = fs.existsSync(denylistFile)
    ? read(denylistFile).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
    : [];

  for (const r of wouldCommit) {
    if (!TEXT_EXT.has(path.extname(r))) continue;
    // 锁文件里全是版本号（形如「十点十三点零」那种数字会被误判成 IP），不参与个人信息检查
    if (/package-lock\.json|pnpm-lock\.yaml|yarn\.lock$/.test(r)) continue;
    const abs = path.join(ROOT, r);
    if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
    read(abs).split(/\r?\n/).forEach((line, i) => {
      const at = `${r}:${i + 1}`;
      // Windows 用户目录里的真实用户名（占位符 <用户目录> / <user> 不算）
      const um = line.match(/[A-Za-z]:\\Users\\([^\\<>/]+)/);
      if (um && !/^<.*>$/.test(um[1])) hits.push(`${at}  绝对路径含用户名: ${um[0].slice(0, 80)}`);
      // 私有网段（示例请统一用 192.168.1.100；你自己的真实网段请写进本地禁列表）
      const ip = line.match(/\b(192\.168|10|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/);
      if (ip && !EXAMPLE_IPS.has(ip[0])) hits.push(`${at}  私有网段: ${ip[0]}`);
      // 设备序列号（adb -s <8位十六进制>）
      const sn = line.match(/adb -s ([0-9a-f]{8,})\b/) || line.match(/"(?:deviceSerial|serial)"\s*:\s*"([0-9a-f]{8,})"/);
      if (sn) hits.push(`${at}  设备序列号: ${sn[1]}`);
      for (const d of denylist) {
        if (line.includes(d)) hits.push(`${at}  命中本地禁列表: ${d}`);
      }
    });
  }
  hits.length ? fail('② 个人信息（路径/网段/序列号）未入库', hits)
              : pass('② 个人信息（路径/网段/序列号）未入库', denylist.length ? `本地禁列表 ${denylist.length} 条` : '（未配置本地禁列表）');
}

// ---------------------------------------------------------------- 3. 禁止入仓的产物类型

{
  const bad = [
    [/\.apk$/i, '第三方安装包'], [/\.toolpkg$/i, '第三方工具包'],
    [/^pc\/tools\/bin\//, '第三方二进制（cloudflared 等）'],
    [/^phone\/toolpkg_cache\//, '第三方工具缓存'],
    [/^apk\//, '第三方安装包目录'],
    [/\.log$/i, '日志（可能含令牌）'],
    [/^pc\/runtime\//, '运行时状态（含令牌）'],
    [/^pc\/bridge\.config\.json$/, '配置（含令牌）'],
    [/ui\.xml$/, '界面转储（含对话全文）'],
    [/\.png$/i, '图片/截图'],
    [/^node_modules\//, '依赖目录'],
    [/\/build\//, '构建产物'],
    [/^local\.properties$/, '本机 SDK 路径'],
    [/^phone\/app-android\/app\/src\/main\/res\//, null], // res 下的 png 是图标，允许
  ];
  const hits = [];
  for (const r of wouldCommit) {
    if (r.startsWith('phone/app-android/app/src/main/res/')) continue;
    for (const [re, why] of bad) {
      if (why && re.test(r)) { hits.push(`${r}  (${why})`); break; }
    }
  }
  // 被忽略的文件也列一下（便于本机清理），但不算失败
  if (SHOW_ALL) {
    const ignoredBig = allFiles.filter((r) => isIgnored(r) && !wouldCommit.includes(r));
    console.log(`\n[信息] 被 .gitignore 正确忽略的本机文件 ${ignoredBig.length} 个（不会入库，无需处理）`);
  }
  hits.length ? fail('③ 禁止入仓的产物类型', hits) : pass('③ 禁止入仓的产物类型');
}

// ---------------------------------------------------------------- 4. Android 安全基线

{
  const hits = [];
  const A = 'phone/app-android/app/src/main';
  const src = `${A}/java/com/dsh/bridge/MainActivity.kt`;
  const layout = `${A}/res/layout/activity_main.xml`;
  const manifest = `${A}/AndroidManifest.xml`;
  const exists = (p) => fs.existsSync(path.join(ROOT, p));
  const text = (p) => exists(p) ? read(path.join(ROOT, p)) : '';

  if (exists(src)) {
    const s = text(src);
    if (/setWebContentsDebuggingEnabled\(\s*true\s*\)/.test(s)) hits.push('MainActivity.kt: WebView 远程调试被硬编码为 true（正式包会泄令牌与对话）');
    if (!/setWebContentsDebuggingEnabled\(\s*BuildConfig\.DEBUG\s*\)/.test(s)) hits.push('MainActivity.kt: 未见到 setWebContentsDebuggingEnabled(BuildConfig.DEBUG)');
    if (!/MIXED_CONTENT_NEVER_ALLOW/.test(s)) hits.push('MainActivity.kt: 混合内容未设为 NEVER_ALLOW');
    if (/allowFileAccess\s*=\s*true/.test(s)) hits.push('MainActivity.kt: allowFileAccess 被打开');
    if (/allowContentAccess\s*=\s*true/.test(s)) hits.push('MainActivity.kt: allowContentAccess 被打开');
    if (!/override fun onRestoreInstanceState/.test(s)) hits.push('MainActivity.kt: 缺少 onRestoreInstanceState 覆盖（系统会恢复上次视图状态，导致"一打开就进对话页"）');
  } else hits.push('MainActivity.kt 不存在（路径变了？请同步更新本检查）');

  if (exists(layout)) {
    const l = text(layout);
    if (!/android:id="@\+id\/webView"[\s\S]{0,400}?android:saveEnabled="false"/.test(l)) {
      hits.push('activity_main.xml: WebView 缺少 android:saveEnabled="false"（会导致启动恢复到上次的对话页）');
    }
  } else hits.push('activity_main.xml 不存在');

  if (exists(manifest)) {
    const m = text(manifest);
    if (/android:allowBackup="true"/.test(m)) hits.push('AndroidManifest.xml: allowBackup="true"（令牌可被 adb backup 导出）');
  } else hits.push('AndroidManifest.xml 不存在');

  hits.length ? fail('④ Android 安全基线', hits) : pass('④ Android 安全基线');
}

// ---------------------------------------------------------------- 5. 桥接端安全基线

{
  const hits = [];
  const p = path.join(ROOT, 'pc/bridge.js');
  if (!fs.existsSync(p)) {
    hits.push('pc/bridge.js 不存在');
  } else {
    const s = read(p);
    if (!/randomBytes\(\s*(1[6-9]|[2-9]\d)\s*\)/.test(s)) hits.push('bridge.js: 令牌随机长度不足 128 位');
    if (!/timingSafeEqual/.test(s)) hits.push('bridge.js: 未使用常量时间比较（timingSafeEqual）');
    if (!/maskSecret/.test(s)) hits.push('bridge.js: 缺少 maskSecret（令牌会明文进日志）');
    if (/log\([^)]*config\.bridgeToken(?!\w)/.test(s.replace(/maskSecret\([^)]*\)/g, 'MASKED'))) {
      hits.push('bridge.js: 仍有把明文令牌写进日志的语句');
    }
    if (/exec\(/.test(s) && !/execFile\(/.test(s)) hits.push('bridge.js: 使用了 exec（走 shell，有注入风险），应改用 execFile');
  }
  hits.length ? fail('⑤ 桥接端安全基线', hits) : pass('⑤ 桥接端安全基线');
}

// ---------------------------------------------------------------- 6. .gitignore 关键项

{
  const gi = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(gi)) {
    fail('⑥ .gitignore 存在且覆盖关键项', ['.gitignore 不存在 —— 这是最严重的一类问题']);
  } else {
    const g = read(gi);
    const must = ['pc/bridge.config.json', 'pc/runtime/', 'pc/logs/', 'pc/tools/bin/', 'apk/',
      'node_modules/', 'local.properties', 'phone/*.png', 'phone/*.log', '*.apk'];
    const missing = must.filter((k) => !g.includes(k));
    missing.length ? fail('⑥ .gitignore 存在且覆盖关键项', missing.map((m) => `.gitignore 缺少: ${m}`))
                   : pass('⑥ .gitignore 存在且覆盖关键项');
  }
}

// ---------------------------------------------------------------- 7. 治理文件齐备

{
  const needed = [
    ['LICENSE', '项目许可证（没有它默认"保留所有权利"，别人无法合法使用）'],
    ['DISCLAIMER.md', '免责与安全声明'],
    ['SECURITY.md', '安全与隐私规范'],
    ['THIRD-PARTY-NOTICES.md', '第三方组件许可证声明'],
    ['WATERMARK.md', '水印说明（水印必须公开说明，否则会被当成恶意代码）'],
    ['tools/watermark-lib.mjs', '水印常量库'],
    ['tools/watermark-apply.mjs', '水印注入器'],
    ['tools/watermark-check.mjs', '水印校验器'],
    ['.gitignore', '忽略规则'],
    ['.githooks/pre-commit', '提交前自检钩子'],
  ];
  const hits = needed
    .filter(([f]) => !fs.existsSync(path.join(ROOT, f)))
    .map(([f, why]) => `缺少 ${f}（${why}）`);
  if (hits.length) fail('⑦ 治理文件齐备', hits);
  else pass('⑦ 治理文件齐备', `${needed.length} 个`);
}

// ---------------------------------------------------------------- 8. 原创水印完整

{
  const hits = [];
  let checked = 0;
  for (const r of wouldCommit) {
    if (WM_SKIP_FILES.has(r)) continue;
    if (!ruleFor(r)) continue;
    if (r.startsWith('tools/watermark-')) continue;   // 水印工具自身的码由自身逻辑保证
    const abs = path.join(ROOT, r);
    if (!fs.existsSync(abs) || fs.statSync(abs).size > 2 * 1024 * 1024) continue;
    const text = read(abs);
    checked++;
    if (!hasWatermark(text)) { hits.push(`${r}  缺少水印（跑 node tools/watermark-apply.mjs 补上）`); continue; }
    const code = visibleCode(text);
    if (code !== watermarkCode(r)) hits.push(`${r}  可见码不符（文件里 ${code || '无'} / 应为 ${watermarkCode(r)}）→ 水印被改过或路径被搬动`);
  }
  for (const r of JSON_TARGETS) {
    const abs = path.join(ROOT, r);
    if (!fs.existsSync(abs)) continue;
    checked++;
    try {
      const j = JSON.parse(read(abs));
      if (!j._watermark || j._watermark.project !== PROJECT_ID || j._watermark.origin !== watermarkCode(r)) {
        hits.push(`${r}  JSON 字段水印缺失或不符`);
      }
    } catch { hits.push(`${r}  JSON 解析失败`); }
  }
  hits.length ? fail('⑧ 原创水印完整', hits) : pass('⑧ 原创水印完整', `${checked} 个文件`);
}

// ---------------------------------------------------------------- 输出

console.log('\n=== 安全与隐私自检 ===');
console.log(hasGit ? '模式：有 git —— 按"是否会被提交"判定（.gitignore 生效）'
                   : '模式：无 git —— 按内置忽略表近似判定（建议先 git init）');
console.log(`扫描：${allFiles.length} 个文件，其中 ${wouldCommit.length} 个会被提交\n`);

let bad = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ✅ ${r.name}${r.note ? '  ' + r.note : ''}`);
  } else {
    bad++;
    console.log(`  ❌ ${r.name}`);
    for (const h of r.hits) console.log(`       ${h}`);
    if (r.more) console.log(`       …还有 ${r.more} 处`);
  }
}
console.log('');
if (bad) {
  console.log(`结果：${bad} 项不合规 —— 修完再提交（规则见 SECURITY.md）`);
  process.exit(1);
} else {
  console.log('结果：全部通过 ✅');
}
