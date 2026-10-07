// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:dbdf99c37c​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
'use strict';
/**
 * dsh-client.js —— PC 端 DeepSeek Harness Web 实例的受控客户端。
 *
 * 职责：
 *  1. 以子进程方式启动 `dsh web --port <port> --no-open`，捕获其 stdout 中
 *     打印的启动 URL（形如 http://127.0.0.1:3081/?token=XXXX），从而拿到
 *     DSH 的进程内 launch token（该 token 不落盘，只能这样获得）。
 *  2. 用 launch token 换取 dsh-auth 签名 Cookie，并维持之。
 *  3. 提供统一的 RPC 调用（POST /api/<method>），供桥接层使用。
 *  4. 提供"发消息 → 等待最终回复"的高层语义（与社区插件同协议）。
 *
 * 协议要点（已实测确认）：
 *   请求体: { type: "client-request", rpcId, method, payload: { args } }
 *   响应体: { type: "server-response", rpcId, result: { ok, value|error } }
 *   鉴权:   GET /?token=<launchToken> → Set-Cookie dsh-auth-* (HMAC 签名)
 *   注意:   转发必须保持 Origin/Host 与实例一致，否则触发 browser-trust fence。
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 从 dsh web 的启动输出里抓取带 token 的 URL。 */
const LAUNCH_URL_RE = /(https?:\/\/[^\s"'`]+?\?token=([A-Za-z0-9_-]{16,}))/;

/** session/page 单页消息数（沿用社区插件取值）。 */
const HISTORY_PAGE_MESSAGES = 50;

const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 300000;

let rpcCounter = 0;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nextRpcId(method) {
  rpcCounter += 1;
  return `bridge-${String(method).replace(/[^a-z0-9.-]/gi, '-')}-${Date.now()}-${rpcCounter}`;
}

/** 从 assistant/user 事件里抽出纯文本。 */
function parseMessage(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function eventText(event) {
  if (!isRecord(event.data)) return '';
  const data = event.data;
  const nested = isRecord(data.message) ? data.message : undefined;
  if (nested !== undefined && 'content' in nested) return parseMessage(nested.content);
  return parseMessage(data.content);
}

function eventSequence(event) {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1;
}

function clampTimeout(value) {
  if (!Number.isInteger(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, value));
}

class DshClient {
  /**
   * @param {object} options
   * @param {string} options.cli        dsh CLI 入口 (lib/bin.js 或 dsh 可执行文件)
   * @param {number} options.port       Web 端口
   * @param {string} [options.host]     绑定地址，默认 127.0.0.1；局域网用 0.0.0.0
   * @param {string} [options.workspace] 子进程工作目录
   * @param {string[]} [options.trustedHosts] 传给 --trusted-host 的授权 authority（局域网用）
   * @param {(msg:string)=>void} [options.log]
   */
  constructor(options) {
    this.cli = options.cli;
    this.profile = options.profile || 'web';
    this.port = Number(options.port) || 3081;
    this.host = options.host || '127.0.0.1';
    this.workspace = options.workspace || process.env.USERPROFILE || process.cwd();
    this.trustedHosts = Array.isArray(options.trustedHosts) ? options.trustedHosts : [];
    this.log = options.log || (() => {});

    /** @type {import('node:child_process').ChildProcess|null} */
    this.proc = null;
    this.token = null;
    this.baseUrl = null;
    this.cookie = null;
    this.startedAt = null;
    this.lastError = null;
    this.stopping = false;
    this.pending = null;
    this.stderrTail = [];
  }

  get authority() {
    // DSH 的 Cookie 绑定在它自己看到的 Host 上，反向探测时保持一致
    return this.baseUrl ? this.baseUrl.replace(/^https?:\/\//, '') : `${this.host}:${this.port}`;
  }

  get running() {
    return this.proc !== null && this.proc.exitCode === null && this.token !== null;
  }

  /** 供手机 WebView 直接加载的带鉴权 URL。 */
  get authenticatedUrl() {
    if (!this.baseUrl || !this.token) return null;
    return `${this.baseUrl}/?token=${this.token}`;
  }

  status() {
    return {
      running: this.running,
      pid: this.proc ? this.proc.pid : null,
      host: this.host,
      port: this.port,
      baseUrl: this.baseUrl,
      authenticatedUrl: this.authenticatedUrl,
      startedAt: this.startedAt,
      hasCookie: Boolean(this.cookie),
      lastError: this.lastError,
      stderrTail: this.stderrTail.slice(-8),
    };
  }

  /**
   * 启动实例并完成鉴权。重复调用是幂等的。
   * @returns {Promise<this>}
   */
  async start() {
    if (this.running) return this;
    if (this.pending) return this.pending;

    this.pending = this._start().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async _start() {
    this.stopping = false;
    this.token = null;
    this.cookie = null;
    this.baseUrl = null;
    this.lastError = null;
    this.stderrTail = [];

    // profile 是 DSH 的组合层：web 是内置别名，其他 profile 用 --profile 引导，
    // 后续参数会被透传给该 profile 的 app（即 dsh web 自己的 --port/--host）。
    const args = [this.cli];
    if (this.profile === 'web') {
      args.push('web');
    } else {
      args.push('--profile', this.profile);
    }
    args.push('--port', String(this.port), '--no-open');
    if (this.host && this.host !== '127.0.0.1') args.push('--host', this.host);
    for (const authority of this.trustedHosts) args.push('--trusted-host', authority);

    this.log(`启动 DSH Web: node ${args.join(' ')}`);

    const child = spawn(process.execPath, args, {
      cwd: this.workspace,
      env: { ...process.env, BROWSER: '', NO_COLOR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;

    // 子进程输出转发到桥接日志，便于诊断实例级异常
    child.stdout.on('data', (buf) => {
      const text = buf.toString('utf8').trim();
      if (text) this.log(`[dsh] ${text.slice(0, 2000)}`);
    });

    const launch = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 DSH 启动 URL 超时（${this.port}）`)), 120000);
      const onChunk = (buf) => {
        const text = buf.toString('utf8');
        const match = LAUNCH_URL_RE.exec(text);
        if (match) {
          clearTimeout(timer);
          resolve({ url: match[1].replace(/\/\?token=.*$/, ''), token: match[2] });
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', (buf) => {
        const text = buf.toString('utf8').trim();
        if (text) this.stderrTail.push(text);
        // dsh 在部分平台把启动行写到 stderr
        onChunk(buf);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (!this.stopping) {
          reject(new Error(`DSH 进程提前退出，code=${code}`));
        }
      });
    });

    let info;
    try {
      info = await launch;
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }

    this.baseUrl = info.url;
    this.token = info.token;
    this.startedAt = Date.now();
    this.log(`DSH 已启动 ${this.baseUrl} (pid=${child.pid})`);

    child.once('exit', (code) => {
      this.log(`DSH 进程退出 code=${code}`);
      this.proc = null;
      this.token = null;
      this.cookie = null;
      this.baseUrl = null;
      if (!this.stopping && this.onExit) this.onExit(code);
    });

    // 用 launch token 换 Cookie，并确认 /api 真的可用
    await this._ensureCookie(true);
    return this;
  }

  /** 停止实例（连同子进程树）。 */
  async stop() {
    const child = this.proc;
    this.stopping = true;
    if (!child || child.pid === undefined) {
      this.proc = null;
      return;
    }
    this.log(`停止 DSH (pid=${child.pid})`);
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    }
    this.proc = null;
    this.token = null;
    this.cookie = null;
    this.baseUrl = null;
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  /** 换取 dsh-auth Cookie。 */
  async _ensureCookie(force = false) {
    if (this.cookie && !force) return this.cookie;
    if (!this.token || !this.baseUrl) throw new Error('DSH 尚未启动，无法鉴权。');

    const res = await fetch(`${this.baseUrl}/?token=${this.token}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    const pairs = raw
      .map((entry) => String(entry).split(';')[0].trim())
      .filter((entry) => entry.includes('='));
    if (pairs.length === 0) {
      throw new Error(`DSH 未下发鉴权 Cookie（HTTP ${res.status}）`);
    }
    this.cookie = pairs.join('; ');
    this.log(`已获取 DSH 鉴权 Cookie（${pairs.length} 项）`);
    return this.cookie;
  }

  /**
   * 调用一次 DSH Web RPC。
   * @param {string} method 例如 session/list、session/prompt
   * @param {object} args
   * @returns {Promise<any>} result.value
   */
  async rpc(method, args = {}) {
    if (!this.token || !this.baseUrl) throw new Error('DSH 尚未启动。');
    await this._ensureCookie();

    const body = JSON.stringify({
      type: 'client-request',
      rpcId: nextRpcId(method),
      method,
      payload: { args },
    });

    const once = async () => fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: this.baseUrl,
        referer: `${this.baseUrl}/`,
        cookie: this.cookie || '',
      },
      body,
    });

    let res = await once();
    if (res.status === 401 || res.status === 403) {
      // Cookie 过期（DSH 重启会换 secret），重新换一次再试
      await this._ensureCookie(true);
      res = await once();
    }

    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`DSH ${method} HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`DSH ${method} 返回非 JSON：${text.slice(0, 500)}`);
    }

    const result = parsed && parsed.result;
    if (!isRecord(result)) throw new Error(`DSH ${method} 响应缺少 result 字段。`);
    if (result.ok !== true) {
      const err = isRecord(result.error) ? result.error : {};
      const failure = new Error(`DSH ${method} 失败：${err.code || 'RPC_ERROR'}: ${err.message || '未知错误'}`);
      failure.dshCode = err.code;
      throw failure;
    }
    return result.value;
  }

  /** 读取会话当前的投影游标（asOfSeq）。 */
  async sessionCursor(sessionId) {
    const value = await this.rpc('session/list', { _request: {} });
    const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
    const item = items.find((candidate) => isRecord(candidate) && candidate.sessionId === sessionId);
    if (!item || !isRecord(item.projections) || typeof item.projections.asOfSeq !== 'number') return 0;
    return item.projections.asOfSeq;
  }

  /** 读取会话到指定游标为止的事件列表。 */
  async sessionEvents(sessionId, throughSeq) {
    const value = await this.rpc('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages: HISTORY_PAGE_MESSAGES,
      },
    });
    const records = isRecord(value) && Array.isArray(value.records) ? value.records : [];
    return records
      .map((entry) => (isRecord(entry) && isRecord(entry.event) ? entry.event : undefined))
      .filter(Boolean);
  }

  // ---------------------------------------------------------------- 设置与权限

  /** 读取设置描述（含各命名空间的 revision）。 */
  async describeSettings() {
    return this.rpc('settings/describe', {});
  }

  /** 读取当前默认权限预设及 permission 命名空间的 revision。 */
  async readPermissionPreset() {
    const described = await this.describeSettings();
    const namespaces = Array.isArray(described.namespaces) ? described.namespaces : [];
    const entry = namespaces.find((item) => isRecord(item) && item.ns === 'permission');
    if (!entry) return { preset: null, revision: undefined };
    const preset = isRecord(entry.value) && typeof entry.value.defaultPreset === 'string'
      ? entry.value.defaultPreset
      : null;
    return { preset, revision: entry.revision };
  }

  /** 修改默认权限预设（作用于此后新建的会话）。 */
  async setPermissionPreset(preset, expectedRevision) {
    return this.rpc('settings/mutate', {
      ns: 'permission',
      ops: [{ op: 'set', path: ['defaultPreset'], value: preset }],
      expectedRevision,
    });
  }

  /**
   * 在"提升权限预设"的时间窗内执行任务，随后立即恢复原值。
   *
   * 背景：DSH 的审批应答走流通道，纯 HTTP RPC 无法代答；而默认预设
   * workspace-write 的 approval=ask 会让无人值守的手机任务永久挂起。
   * danger-full-access 预设的 approval=never，正好满足免值守执行。
   * 为避免长期改变桌面端的安全默认，这里用 try/finally 做临时提升。
   */
  async withPermissionPreset(preset, fn) {
    const before = await this.readPermissionPreset();
    let raised = false;
    if (preset && before.preset !== preset) {
      await this.setPermissionPreset(preset, before.revision);
      raised = true;
      this.log(`权限预设临时提升：${before.preset} → ${preset}`);
    }
    try {
      return await fn();
    } finally {
      if (raised && before.preset) {
        try {
          const now = await this.readPermissionPreset();
          await this.setPermissionPreset(before.preset, now.revision);
          this.log(`权限预设已恢复：${before.preset}`);
        } catch (error) {
          this.log(`权限预设恢复失败（请手动检查 DSH 设置）：${error.message}`);
        }
      }
    }
  }

  /** 列出会话（裁剪为手机端够用的字段）。 */
  async listSessions(limit = 30) {
    const value = await this.rpc('session/list', { _request: {} });
    const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
    return items
      .map((item) => {
        if (!isRecord(item)) return null;
        const title = isRecord(item.projections) && isRecord(item.projections.values)
          ? item.projections.values.title
          : undefined;
        return {
          sessionId: item.sessionId,
          cwd: item.cwd,
          updatedAt: item.updatedAt,
          running: item.running === true,
          blank: item.blank === true,
          title: typeof title === 'string' && title.trim() !== '' ? title : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit);
  }

  /**
   * 提交一条消息（不等回复）。
   * @returns {Promise<{sessionId:string, baselineSeq:number, accepted:boolean}>}
   */
  async prompt({ message, sessionId, mode = 'queue', cwd }) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new Error('message 不能为空。');
    }
    // DSH 只接受 queue / steer 两种投递模式
    const deliveryMode = mode === 'steer' ? 'steer' : 'queue';
    let target = sessionId;
    if (!target) {
      const request = {};
      if (typeof cwd === 'string' && cwd.trim() !== '') request.cwd = cwd;
      const created = await this.rpc('session/create', { request });
      if (!created || typeof created.sessionId !== 'string') {
        throw new Error('session/create 未返回 sessionId。');
      }
      target = created.sessionId;
    }
    const baselineSeq = await this.sessionCursor(target);
    const prompt = await this.rpc('session/prompt', {
      request: {
        requestId: nextRpcId('session/prompt'),
        sessionId: target,
        mode: deliveryMode,
        content: [{ type: 'text', text: message }],
      },
    });
    return { sessionId: target, baselineSeq, accepted: prompt && prompt.accepted === true };
  }

  /**
   * 轮询等待本轮最终回复（与社区插件同一判据：assistant/message + turn/end）。
   * @returns {Promise<{text:string, seq:number}>}
   */
  async waitForReply({ sessionId, message, baselineSeq, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
    const deadline = Date.now() + clampTimeout(timeoutMs);
    let lastUserSeq = baselineSeq;

    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw new Error('已取消等待。');
      const cursor = await this.sessionCursor(sessionId);
      const events = await this.sessionEvents(sessionId, cursor);

      // 本轮若已以 error 结束，立即失败，避免无谓空等到超时
      const failedTurn = events.find((event) => {
        if (event.type !== 'turn/end' || eventSequence(event) <= baselineSeq) return false;
        const reason = isRecord(event.data) ? event.data.reason : undefined;
        return isRecord(reason) && reason.kind === 'error';
      });
      if (failedTurn !== undefined) {
        const reason = failedTurn.data.reason;
        const detail = isRecord(reason.error) && typeof reason.error.message === 'string'
          ? reason.error.message
          : '未知错误';
        throw new Error(`DSH 本轮执行失败：${detail}`);
      }

      const userMessages = events
        .filter((event) => event.type === 'user/message' || event.type === 'steering/message')
        .filter((event) => eventSequence(event) > baselineSeq && eventText(event) === message)
        .sort((a, b) => eventSequence(a) - eventSequence(b));

      const latestUser = userMessages[userMessages.length - 1];
      if (latestUser !== undefined) {
        lastUserSeq = eventSequence(latestUser);
        const replies = events
          .filter((event) => event.type === 'assistant/message')
          .filter((event) => eventSequence(event) > lastUserSeq)
          .map((event) => ({ seq: eventSequence(event), text: eventText(event) }))
          .filter((reply) => reply.text !== '')
          .sort((a, b) => a.seq - b.seq);
        const turnEnded = events.some(
          (event) => event.type === 'turn/end' && eventSequence(event) > lastUserSeq,
        );
        const lastReply = replies[replies.length - 1];
        if (lastReply !== undefined && turnEnded) {
          return { text: lastReply.text, seq: lastReply.seq };
        }
        if (turnEnded && lastReply === undefined) {
          const ended = events
            .filter((event) => event.type === 'turn/end' && eventSequence(event) > lastUserSeq)
            .sort((a, b) => eventSequence(a) - eventSequence(b))
            .pop();
          const reason = isRecord(ended && ended.data) && isRecord(ended.data.reason)
            ? ended.data.reason
            : undefined;
          const kind = reason && typeof reason.kind === 'string' ? reason.kind : 'unknown';
          throw new Error(`本轮以 ${kind} 结束，未记录 assistant 回复。`);
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
    }

    const error = new Error('DSH 已接受消息，但在超时前没有返回最终回复。');
    error.timeout = true;
    error.lastObservedUserSeq = lastUserSeq;
    throw error;
  }

  /** 读取会话历史（用于手机端展示）。 */
  async history(sessionId, limit = 40) {
    const cursor = await this.sessionCursor(sessionId);
    const events = await this.sessionEvents(sessionId, cursor);
    const messages = events
      .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
      .map((event) => ({
        role: event.type === 'user/message' ? 'user' : 'assistant',
        seq: eventSequence(event),
        text: eventText(event),
      }))
      .filter((item) => item.text !== '')
      .sort((a, b) => a.seq - b.seq);
    return { sessionId, cursor, messages: messages.slice(-limit) };
  }
}

module.exports = { DshClient, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS };
