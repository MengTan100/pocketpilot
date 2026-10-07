// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:eadb379aca​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
/**
 * CDP 求值工具：在手机 WebView 里执行一段 JS 并把结果打回来。
 *
 * 用法:
 *   node cdp-eval.mjs <wsUrl> "<jsExpr>"      直接给表达式
 *   node cdp-eval.mjs <wsUrl> @<脚本文件>      从文件读（推荐）
 *
 * 推荐用文件方式：命令行传 JS 时，PowerShell/bash 的引号转义会把
 * CSS 属性选择器（[class*="x"]）里的 *= 弄坏，报 SyntaxError。
 */
import { readFileSync } from 'node:fs';

const wsUrl = process.argv[2];
let expression = process.argv[3];

if (!wsUrl || !expression) {
  console.error('用法: node cdp-eval.mjs <wsUrl> "<jsExpr>" | @<file>');
  process.exit(2);
}

if (expression.startsWith('@')) {
  const file = expression.slice(1);
  expression = readFileSync(file, 'utf8');
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 15000);
  });
}

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

ws.addEventListener('error', (err) => {
  console.error('WebSocket 错误:', err.message || err);
  process.exit(1);
});

ws.addEventListener('open', async () => {
  try {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const result = res.result;
    if (result && result.exceptionDetails) {
      console.error('页面内异常:', JSON.stringify(result.exceptionDetails, null, 2));
      process.exit(1);
    }
    const value = result && result.result ? result.result.value : undefined;
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('执行失败:', err.message);
    process.exit(1);
  }
});
