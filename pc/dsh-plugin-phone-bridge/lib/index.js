// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:0844071de0​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
/**
 * Host 侧入口。
 *
 * 这个插件的前端部分（lib/client.js）直接向本机桥接的 /pair.json 取配对信息，
 * 因此 host 侧无需注册任何服务或 RPC —— 保持零依赖、零副作用，
 * 万一桥接没运行也只是那一块显示提示，不会影响 DSH 本身启动。
 */
function apply() {}

export { apply };
