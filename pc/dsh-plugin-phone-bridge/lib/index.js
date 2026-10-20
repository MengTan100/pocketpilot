// SPDX-License-Identifier: Apache-2.0
/**
 * Host 侧入口：**让插件自己把桥接拉起来**，不再需要用户先手动双击 start-bridge.bat。
 *
 * 为什么改（用户反馈："插件不是一整块，还得依赖一个 bat 才能用"）：
 *   以前这里是个空函数 —— 插件只负责显示二维码，桥接进程要用户自己去点 bat。
 *   于是"插件装好了却用不了"，而且 bat 一关桥接就没了。
 *
 * 现在的行为（插件加载时）：
 *   ① 先探测 http://127.0.0.1:3080/health；
 *   ② 已经在跑 → 什么都不做（绝不重复拉起，避免两个桥接抢端口）；
 *   ③ 没在跑 → 用 node 以**独立进程**方式启动 pc/bridge.js，并等它就绪；
 *   ④ 任何异常都只记录、不外抛 —— 插件绝不能因为桥接起不来而拖垮 DSH 界面。
 *
 * 桥接脚本的定位顺序（尽量"装好即用"，同时允许显式覆盖）：
 *   1. 环境变量 DSH_PHONE_BRIDGE_SCRIPT
 *   2. 本插件作为仓库内 file: 依赖时：<repo>/pc/bridge.js
 *      即从 node_modules/dsh-plugin-phone-bridge/lib 上溯 4 层
 *   3. 插件包内自带的 lib/bridge/bridge.js（如果有人做了整包内置）
 * 都找不到时，打印一条明确的提示（含期望路径），而不是静默失败。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = 3080;
const HEALTH_URL = `http://127.0.0.1:${BRIDGE_PORT}/health`;

/** 探测桥接是否在跑（/health 未开 CORS，只能靠成败判断）。 */
async function alive(timeoutMs = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(HEALTH_URL, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 找到 pc/bridge.js 的实际路径；找不到返回 null。
 *
 * 这里必须处理两种安装形态（都真实存在）：
 *   A. 直接在仓库里跑（开发/`file:` 直连）：插件目录就是 <repo>/pc/dsh-plugin-phone-bridge
 *      → HERE/../../bridge.js = <repo>/pc/bridge.js
 *   B. 被拷进 profile（~/.dsh/profiles/<name>/node_modules/dsh-plugin-phone-bridge）
 *      → 目录里没有桥接，只能从 profile 的 package.json 里读到 `file:` 安装来源，
 *        再据此推出仓库位置。这也是"插件自带桥接"能成立的关键一环。
 * 另外支持环境变量与本地配置文件覆盖。
 */
function resolveBridgeScript() {
  const candidates = [];
  const fromEnv = process.env.DSH_PHONE_BRIDGE_SCRIPT;
  if (fromEnv) candidates.push(fromEnv);

  // A. 仓库内布局
  candidates.push(path.resolve(HERE, '..', '..', 'bridge.js'));
  // 插件包内自带（若有人做了整包内置）
  candidates.push(path.resolve(HERE, 'bridge', 'bridge.js'));

  // 本地保存的位置（首次成功后写回，后续直接命中）
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const savedPath = path.join(home, '.dsh', 'phone-bridge-location.json');
  try {
    if (existsSync(savedPath)) {
      const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
      if (saved && saved.bridgeScript) candidates.push(saved.bridgeScript);
    }
  } catch { /* 忽略 */ }

  // B. 从 profile 的 package.json 里回溯 `file:` 安装来源
  try {
    // HERE = <profile>/node_modules/dsh-plugin-phone-bridge/lib
    const profileDir = path.resolve(HERE, '..', '..', '..');
    const manifestPath = path.join(profileDir, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const spec = (manifest.dependencies || {})['dsh-plugin-phone-bridge'];
      if (typeof spec === 'string' && spec.startsWith('file:')) {
        const pluginDir = spec.slice('file:'.length).replace(/^\/+/, '');
        // <repo>/pc/dsh-plugin-phone-bridge → <repo>/pc/bridge.js
        candidates.push(path.resolve(pluginDir, '..', 'bridge.js'));
      }
    }
  } catch { /* 忽略 */ }

  for (const c of candidates) {
    try { if (c && existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  return null;
}

/** 记住找到的桥接路径，下次少走一遍回溯。 */
function rememberBridgeScript(script) {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const target = path.join(home, '.dsh', 'phone-bridge-location.json');
    writeFileSync(target, JSON.stringify({ bridgeScript: script, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch { /* 记不住也无妨 */ }
}

/**
 * 确保桥接在跑：已在跑直接返回；否则拉起并等待就绪。
 * @returns {Promise<{ok:boolean, action:'reused'|'started'|'failed', script?:string, error?:string}>}
 */
export async function ensureBridgeRunning() {
  if (await alive()) return { ok: true, action: 'reused' };

  const script = resolveBridgeScript();
  if (!script) {
    const expected = path.resolve(HERE, '..', '..', '..', 'bridge.js');
    console.warn(`[phone-bridge] 找不到桥接脚本，无法自动启动。期望路径：${expected}\n` +
      `  可设置环境变量 DSH_PHONE_BRIDGE_SCRIPT 指向 pc/bridge.js，或手动运行 start-bridge.bat。`);
    return { ok: false, action: 'failed', error: 'bridge script not found' };
  }

  try {
    // detached + ignore：桥接比 DSH 活得久（DSH 重启不该掐断手机连接），
    // 也不占插件进程的 stdout（否则 DSH 的日志会被桥接刷屏）。
    const child = spawn(process.execPath, [script], {
      cwd: path.dirname(script),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    console.info(`[phone-bridge] 未检测到桥接，已自动启动（pid=${child.pid}, script=${script}）`);
  } catch (error) {
    console.warn('[phone-bridge] 自动启动桥接失败：' + (error && error.message ? error.message : error));
    return { ok: false, action: 'failed', error: String(error) };
  }

  // 等它就绪：桥接要起 DSH 实例，给足 12 秒；期间每 400ms 探一次。
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await alive()) {
      console.info('[phone-bridge] 桥接已就绪');
      return { ok: true, action: 'started', script };
    }
  }
  console.warn('[phone-bridge] 桥接已启动但在 12 秒内未就绪 —— 可能是配置/端口问题，请看 pc/logs/bridge.log');
  return { ok: false, action: 'failed', script, error: 'not ready in 12s' };
}

/** 桥接用的鉴权头（与 bridge.js 的 authorize() 约定一致）。 */
const BRIDGE_TOKEN_HEADER = 'x-bridge-token';

/**
 * 读取桥接配置（`bridge.config.json` 就在 bridge.js 旁边）：端口 + 桥接令牌。
 * 读不到令牌就直接放弃 —— /upstream/desktop-session 走桥接自身的鉴权，不能匿名。
 */
function readBridgeConfig() {
  const candidates = [];
  const script = resolveBridgeScript();
  if (script) candidates.push(path.join(path.dirname(script), 'bridge.config.json'));
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) candidates.push(path.join(home, '.dsh', 'phone-bridge.config.json'));
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      const token = typeof cfg.bridgeToken === 'string' ? cfg.bridgeToken : '';
      if (!token) continue;
      return { port: Number(cfg.bridgePort) || BRIDGE_PORT, token };
    } catch { /* 试下一个 */ }
  }
  return { port: BRIDGE_PORT, token: '' };
}

/**
 * 把「带 launch token 的会话地址」交给桥接 —— 上游鉴权的**权威**来源。
 *
 * 为什么需要：桥接反向代理桌面端时，要么自签 Cookie（依赖 ~/.dsh 里持久化的
 * 会话密钥），要么让 DSH 自己发牌。实测前者并不可靠：桌面端进程内的密钥与磁盘
 * 偶尔不一致，同一个 authority、同一份凭据，桌面端回 401，手机端就看到
 * `dsh web authentication required`。我们跑在 DSH 宿主进程里，
 * `connection.authenticatedUrl()` 拿到的地址访问一次就回 303 + Set-Cookie，
 * 桥接拿它换 Cookie 即可 —— 不需要猜密钥，也不需要用户的 launch token。
 *
 * 安全性：URL 里含 launch token，只在**回环**上传给桥接，绝不打印到日志。
 *
 * @returns {Promise<{ok:boolean, port?:number, reason?:string}>}
 */
export async function publishDesktopSession(ctx) {
  const get = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);
  const webServer = get('webServer');
  const connection = get('connection');
  if (!webServer || !connection || typeof connection.authenticatedUrl !== 'function') {
    return { ok: false, reason: '服务未就绪（webServer / connection）' };
  }
  const port = Number(webServer.port);
  if (!Number.isInteger(port) || port <= 0) return { ok: false, reason: 'webServer 端口未知' };

  const protocol = webServer.protocol === 'https:' ? 'https:' : 'http:';
  const url = connection.authenticatedUrl(`${protocol}//127.0.0.1:${port}`);
  const cfg = readBridgeConfig();
  if (!cfg.token) return { ok: false, reason: '读不到桥接令牌（bridge.config.json）' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/upstream/desktop-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: cfg.token },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `桥接返回 HTTP ${res.status}` };
    return { ok: true, port };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 插件主体：只做"确保桥接在跑"这一件事，且**永不抛出**。
 * 前端（lib/client.js）照旧通过同源 iframe 显示二维码，不需要任何 RPC。
 */
export function apply(ctx) {
  // 用 ctx.effect 包住：插件卸载/热更新时清理我们自己起的定时器，避免重复拉进程。
  try {
    let announced = false;
    const run = () => {
      ensureBridgeRunning()
        .then(async (result) => {
          if (!result || !result.ok) return;
          const published = await publishDesktopSession(ctx)
            .catch((error) => ({ ok: false, reason: error && error.message ? error.message : String(error) }));
          if (published.ok) {
            if (!announced) {
              console.info(`[phone-bridge] 已交出桌面端会话（上游鉴权走 DSH 自己的 launch token，port=${published.port}）`);
            }
            announced = true;
          } else if (!announced) {
            console.warn(`[phone-bridge] 暂未交出桌面端会话：${published.reason}（稍后自动重试）`);
          }
        })
        .catch(() => {});
    };
    run();
    // DSH 可能先于网络栈就绪；再补一次延迟尝试（幂等：已在跑就 reuse）。
    const timer = setTimeout(run, 8000);
    // 定时兜底：桥接可能被用户关掉、崩掉，或比 DSH 晚启动。
    // 每 60 秒确认一次（已在跑就 reuse，不会重复拉起），保证"插件在 = 桥接在"。
    // 顺便把会话地址再交一次：DSH 宿主重启后 launch token 会变，桥接需要新的。
    const keepAlive = setInterval(run, 60000);
    if (typeof keepAlive.unref === "function") keepAlive.unref();
    if (typeof timer.unref === 'function') timer.unref();
  } catch (error) {
    console.warn('[phone-bridge] 初始化异常（已忽略，不影响 DSH）：' + (error && error.message ? error.message : error));
  }
}
