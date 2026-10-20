// SPDX-License-Identifier: MIT
/**
 * version-check.js —— 「有没有新版本」的唯一判断处（插件面板与手机 App 共用）。
 *
 * 为什么要放在电脑端：手机与电脑都可能被墙，但**判断逻辑只能有一份**。
 * 桥接在这里做一次带缓存的检查，手机 App 通过 `/version` 问它，
 * 面板直接用它渲染，两边看到的结论永远一致。
 *
 * 探测顺序（前一个失败就试下一个）：
 *   1) api.github.com（本机最稳的 GitHub 通道）
 *   2) ghfast.top + api.github.com（国内加速镜像）
 *   3) docs/version.json（GitHub Pages 静态文件）
 *   4) ghfast.top + raw.githubusercontent.com 的 version.json
 */
'use strict';

const CACHE_MS = 10 * 60 * 1000;        // 10 分钟内不重复请求
const TIMEOUT_MS = 5000;

const REPO = 'MengTan100/pocketpilot';
const GH_API = `https://api.github.com/repos/${REPO}`;
const MIRROR = 'https://ghfast.top';
const PAGES = 'https://mengtan100.github.io/pocketpilot';
const RAW = `https://raw.githubusercontent.com/${REPO}/main/docs`;

let cache = { at: 0, data: null };

/** 版本号比较：只认 x.y.z（可带 -后缀），新版本返回正数。 */
function compareVersions(a, b) {
  const norm = (v) => String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = norm(a);
  const y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': 'pocketpilot-bridge' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 从各通道取"最新版本 + 各产物的下载地址"。 */
async function probeLatest() {
  // 1) GitHub API（正式通道）
  const rel = await fetchJson(`${GH_API}/releases/latest`);
  if (rel && rel.tag_name) {
    const tags = Array.isArray(rel.assets) ? rel.assets : [];
    const asset = (name) => {
      const hit = tags.find((a) => a && a.name === name);
      return hit && hit.browser_download_url ? hit.browser_download_url : '';
    };
    return {
      latest: String(rel.tag_name).replace(/^v/i, ''),
      apkUrl: asset('app-release.apk') || `${GH_API.replace('api.github.com/repos', 'github.com')}/releases/latest/download/app-release.apk`,
      pluginUrl: asset('dsh-plugin-phone-bridge.zip') || asset('dsh-plugin-phone-bridge-0.5.0.zip') || `${GH_API.replace('api.github.com/repos', 'github.com')}/releases/latest/download/dsh-plugin-phone-bridge.zip`,
      notesUrl: rel.html_url || '',
      source: 'api.github.com',
    };
  }

  // 2) 国内镜像 + API
  const mirrored = await fetchJson(`${MIRROR}/${GH_API}/releases/latest`);
  if (mirrored && mirrored.tag_name) {
    return {
      latest: String(mirrored.tag_name).replace(/^v/i, ''),
      apkUrl: `${MIRROR}/https://github.com/${REPO}/releases/latest/download/app-release.apk`,
      pluginUrl: `${MIRROR}/https://github.com/${REPO}/releases/latest/download/dsh-plugin-phone-bridge.zip`,
      notesUrl: `${GH_API.replace('api.github.com/repos', 'github.com')}/releases/latest`,
      source: 'ghfast.top/api',
    };
  }

  // 3) Pages 上的 version.json（发布时生成）
  for (const [url, source] of [
    [`${PAGES}/version.json`, 'pages'],
    [`${MIRROR}/${RAW}/version.json`, 'ghfast.top/raw'],
  ]) {
    const v = await fetchJson(url);
    if (v && v.version) {
      return {
        latest: String(v.version).replace(/^v/i, ''),
        apkUrl: v.apkUrl || `${MIRROR}/https://github.com/${REPO}/releases/latest/download/app-release.apk`,
        pluginUrl: v.pluginUrl || `${MIRROR}/https://github.com/${REPO}/releases/latest/download/dsh-plugin-phone-bridge.zip`,
        notesUrl: v.notesUrl || `${GH_API.replace('api.github.com/repos', 'github.com')}/releases`,
        source,
      };
    }
  }

  return null;
}

/**
 * @param {string} current 当前版本（插件 package.json 的 version）
 * @param {boolean} force  忽略缓存
 */
async function check(current, force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_MS) {
    return { ...cache.data, cached: true };
  }

  const latest = await probeLatest();
  const base = {
    current,
    checkedAt: new Date().toISOString(),
    reachable: Boolean(latest),
  };

  if (!latest) {
    // 全部通道失败：不谎报"已是最新"，明确告知"没查到"
    const data = { ...base, latest: '', hasUpdate: false, error: '无法连接更新服务器（可稍后重试）' };
    cache = { at: now, data };
    return data;
  }

  const data = {
    ...base,
    latest: latest.latest,
    hasUpdate: compareVersions(latest.latest, current) > 0,
    apkUrl: latest.apkUrl,
    pluginUrl: latest.pluginUrl,
    notesUrl: latest.notesUrl,
    source: latest.source,
  };
  cache = { at: now, data };
  return data;
}

module.exports = { check, compareVersions, CACHE_MS };
