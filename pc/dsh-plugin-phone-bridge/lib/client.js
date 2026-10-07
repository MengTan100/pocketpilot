// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:f20f647181​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
/**
 * 前端 bundle：把「手机连接」入口放到**侧栏底部、紧挨设置齿轮**的位置，
 * 点击后**居中弹出**配对二维码；设置面板里的区段作为二级入口保留。
 *
 * ─────────────────────────── 插槽契约（实测，别再踩坑）───────────────────────────
 * DSH 侧栏（dsh-client-ui-sidebar）声明了这几个槽：
 *   "sidebar.workspaces"    { kind: "single" }  ← **独占**！官方会话列表正注册在这里。
 *                                                 再注册会抛
 *                                                 "single slot sidebar.workspaces already has a
 *                                                  registration at priority 0 (registered by mf)"
 *                                                 并让整个会话列表渲染失败、从侧栏消失。
 *   "sidebar.settings"      { kind: "single" }  ← 也是独占，别碰。
 *   "sidebar.footer.action" { kind: "list"   }  ← ✅ 我们要用的：可多注册者。
 *
 * 布局位置（dsh-client-ui-sidebar 源码）：
 *   footArea = <div class="footerActions"> renderSlot("sidebar.footer.action") </div>
 *            + <div class="settingsArea">  renderSlot("sidebar.settings")       </div>
 * 也就是说 footer.action 就在设置齿轮那一片区域里 —— 正是"账号/设置旁边"。
 *
 * register() 的判定（dsh-web-frontend 里 register 的实现）：
 *   list 槽**必须带 options.id**，唯一性按 (id, priority) 判；排序字段是 **priority**（默认 0）。
 *   （早先写的 order: 1 是无效字段，其实没起作用。）
 *
 * ─────────────────────────── 安全要点（不要放松）───────────────────────────
 * 1. /pair 页面里有配对**二维码**，而二维码里就含 bridge token ——
 *    所以它**只能从回环地址加载**。一旦把 PAIR_URL 指向非回环主机，
 *    等于把令牌送到别人的服务器上。下面的 assertLoopback() 就是这个不变量的
 *    运行时断言：改错了会当场显示错误，而不是默默把令牌发出去。
 * 2. 父页面（DSH 界面）**不读取 /pair.json**：令牌只在 iframe 内部出现，
 *    不进 DSH 页面的内存/DOM。存活探测只用 /health（且 no-cors，读不到内容）。
 * 3. iframe 加 referrerPolicy="no-referrer"，不把 DSH 页面的地址/端口泄漏给桥接。
 * 4. 这里**不加 iframe sandbox**：该页面需要以自身 origin 发同源请求来渲染二维码，
 *    加 sandbox 会因变成 opaque origin 而失败。它本来就是跨源（19387 → 3080），
 *    拿不到父页面 DOM，风险可控。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-phone-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
		const React = require("react");
		const { createPortal } = require("react-dom");
		const { useState, useEffect, useCallback } = React;

		/** 桥接默认端口。桥接改端口时，这里要跟着改（见 pc/bridge.config.json）。 */
		const BRIDGE_PORT = 3080;
		const BRIDGE_ORIGIN = `http://127.0.0.1:${BRIDGE_PORT}`;
		// embed=1：配对页用紧凑排布，并会把自己的真实内容高度回报给这里，
		// 于是弹窗能"一屏展示全部、不用下拉"。
		const PAIR_URL = `${BRIDGE_ORIGIN}/pair?embed=1`;
		const HEALTH_URL = `${BRIDGE_ORIGIN}/health`;

		/**
		 * 安全不变量：配对页含令牌，只允许回环地址。
		 * 返回 null 表示通过，否则返回给用户看的错误文案。
		 */
		function assertLoopback(url) {
			try {
				const u = new URL(url);
				const okHost = u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "localhost";
				if (!okHost) {
					return `已阻止加载非本机地址：${u.hostname}。配对页含访问令牌，只允许 127.0.0.1。`;
				}
				return null;
			} catch (error) {
				return `配对地址不合法：${url}`;
			}
		}

		// ─────────────────────────────── 样式（自包含，不依赖外部 CSS）

		const RAIL_BTN = {
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			width: 32,
			height: 32,
			border: "none",
			borderRadius: 8,
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
			padding: 0,
		};
		const WIDE_BTN = Object.assign({}, RAIL_BTN, {
			width: "100%",
			justifyContent: "flex-start",
			gap: 8,
			padding: "0 10px",
			height: 34,
			fontSize: 13,
		});
		const BACKDROP = {
			position: "fixed",
			inset: 0,
			zIndex: 9999,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			background: "rgba(4,6,10,0.62)",
			backdropFilter: "blur(2px)",
			padding: 12,
		};
		const PANEL = {
			display: "flex",
			flexDirection: "column",
			width: "100%",
			maxWidth: 560,
			// 高由内容决定（iframe 已按配对页真实高度自适应）→ 一屏展示全部
			maxHeight: "100%",
			background: "#0b0d12",
			border: "1px solid #232a36",
			borderRadius: 14,
			overflow: "hidden",
			boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
		};
		const HEADER = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12,
			padding: "8px 12px",
			borderBottom: "1px solid #232a36",
			color: "#e8eaf0",
			fontSize: 13,
		};
		const CLOSE_BTN = {
			border: "none",
			background: "transparent",
			color: "#8b93a7",
			fontSize: 16,
			lineHeight: 1,
			cursor: "pointer",
			padding: 6,
			borderRadius: 6,
		};
		const HINT = {
			padding: "6px 12px",
			borderTop: "1px solid #232a36",
			color: "#8b93a7",
			fontSize: 11,
			lineHeight: 1.5,
		};
		const CENTER_BOX = {
			flex: 1,
			minHeight: 320,
			display: "flex",
			flexDirection: "column",
			alignItems: "center",
			justifyContent: "center",
			gap: 10,
			color: "#e8eaf0",
			fontSize: 14,
			textAlign: "center",
			padding: 24,
		};
		const RETRY_BTN = {
			marginTop: 4,
			padding: "7px 16px",
			borderRadius: 8,
			border: "1px solid #2d3748",
			background: "#171a21",
			color: "#e8eaf0",
			cursor: "pointer",
			fontSize: 13,
		};

		// ─────────────────────────────── 组件

		function PhoneIcon({ size = 16 }) {
			return jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				style: { flex: "0 0 auto" },
				children: [
					jsx("rect", { x: 6, y: 2.5, width: 12, height: 19, rx: 2.5 }),
					jsx("line", { x1: 10.5, y1: 18.5, x2: 13.5, y2: 18.5 }),
				],
			});
		}

		/**
		 * 探测桥接是否在跑。
		 * 用 no-cors：/health 没开 CORS，opaque 请求只判"通不通"，读不到内容也就拿不到令牌；
		 * 网络层失败（桥接没启动）会 reject，正好当"没运行"用。
		 */
		function useBridgeAlive() {
			const [alive, setAlive] = useState(null);
			const probe = useCallback(() => {
				setAlive(null);
				fetch(HEALTH_URL, { mode: "no-cors", cache: "no-store" })
					.then(() => setAlive(true))
					.catch(() => setAlive(false));
			}, []);
			useEffect(() => {
				probe();
			}, [probe]);
			return [alive, probe];
		}

		/** 配对内容本体：先探测，桥接没起来就给可操作提示，而不是甩一个浏览器错误页。 */
		function PairFrame() {
			const [alive, probe] = useBridgeAlive();
			const [contentHeight, setContentHeight] = useState(null);
			const invalid = assertLoopback(PAIR_URL);

			// 收配对页报回来的"刚好放得下"的高度。
			// 必须校验 origin：message 事件同页面里的任何来源都能发，
			// 只认本机桥接那一个来源，别的一律丢弃（否则别的页面能操纵弹窗尺寸）。
			useEffect(() => {
				const onMessage = (e) => {
					if (e.origin !== BRIDGE_ORIGIN) return;
					const data = e.data;
					if (!data || data.type !== "dsh-pair-height") return;
					if (typeof data.height !== "number" || !isFinite(data.height)) return;
					const h = Math.round(data.height);
					if (h > 80 && h < 4000) setContentHeight(h);
				};
				window.addEventListener("message", onMessage);
				return () => window.removeEventListener("message", onMessage);
			}, []);

			if (invalid) {
				return jsx("div", { style: CENTER_BOX, children: jsx("div", { children: invalid }) });
			}
			if (alive === null) {
				return jsx("div", { style: CENTER_BOX, children: jsx("div", { children: "正在检查手机桥接…" }) });
			}
			if (alive === false) {
				return jsxs("div", {
					style: CENTER_BOX,
					children: [
						jsx("div", { children: "没有检测到手机桥接。" }),
						jsx("div", {
							style: { fontSize: 13, color: "#8b93a7", maxWidth: 380, lineHeight: 1.7 },
							children: "请在电脑上运行 pc\\start-bridge.bat（首次会显示配对二维码），然后点下面的重试。",
						}),
						jsx("button", { type: "button", onClick: probe, style: RETRY_BTN, children: "重试" }),
					],
				});
			}
			return jsx("iframe", {
				src: PAIR_URL,
				title: "手机连接",
				referrerPolicy: "no-referrer",
				style: {
					width: "100%",
					// 高度取配对页回报的真实内容高度 → 一屏放得下，不出现内部滚动条；
					// 极端小屏时由 maxHeight 兜底（此时才退化成 iframe 内部滚动）。
					height: contentHeight ? `${contentHeight}px` : "460px",
					maxHeight: "calc(100vh - 150px)",
					border: "none",
					background: "#0b0d12",
					display: "block",
				},
			});
		}

		/** 居中弹窗：portal 到 body，避免被侧栏的 transform/overflow 裁掉。 */
		function PhoneBridgeDialog({ onClose }) {
			useEffect(() => {
				const onKey = (e) => {
					if (e.key === "Escape") onClose();
				};
				document.addEventListener("keydown", onKey);
				const prev = document.body.style.overflow;
				document.body.style.overflow = "hidden";
				return () => {
					document.removeEventListener("keydown", onKey);
					document.body.style.overflow = prev;
				};
			}, [onClose]);

			return createPortal(
				jsx("div", {
					style: BACKDROP,
					// 只有点在遮罩本身（不是面板内部）才关闭，避免误关
					onMouseDown: (e) => {
						if (e.target === e.currentTarget) onClose();
					},
					children: jsxs("div", {
						role: "dialog",
						"aria-modal": "true",
						"aria-label": "手机连接",
						style: PANEL,
						children: [
							jsxs("div", {
								style: HEADER,
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "center", gap: 8 },
										children: [
											jsx(PhoneIcon, { size: 16 }),
											jsx("span", { style: { fontWeight: 600 }, children: "手机连接" }),
										],
									}),
									jsx("button", {
										type: "button",
										onClick: onClose,
										style: CLOSE_BTN,
										title: "关闭（Esc）",
										"aria-label": "关闭",
										children: "✕",
									}),
								],
							}),
							jsx("div", {
								// display:block 而非 flex:1 —— iframe 已按配对页真实高度定高，
								// 不能再被 flex 压缩，否则又会切成滚动。
								style: { display: "block", minHeight: 0 },
								children: jsx(PairFrame, {}),
							}),
							jsx("div", {
								style: HINT,
								children: "用手机 App 扫这个二维码即可配对；也可以手动输入上面的配对码。此页面只在本机回环地址打开。",
							}),
						],
					}),
				}),
				document.body
			);
		}

		/**
		 * 侧栏底部入口（sidebar.footer.action）。
		 * wide=false 时侧栏处于 56px 收起态，只显示图标；wide=true 时带文字。
		 */
		function FooterAction(props) {
			const wide = Boolean(props && props.wide);
			const [open, setOpen] = useState(false);
			return jsxs(Fragment, {
				children: [
					jsx("button", {
						key: "entry",
						type: "button",
						onClick: () => setOpen(true),
						title: "手机连接",
						"aria-label": "手机连接",
						style: wide ? WIDE_BTN : RAIL_BTN,
						children: wide
							? [jsx(PhoneIcon, { key: "i", size: 16 }), jsx("span", { key: "t", children: "手机连接" })]
							: jsx(PhoneIcon, { size: 18 }),
					}),
					open
						? jsx(PhoneBridgeDialog, { key: "dialog", onClose: () => setOpen(false) })
						: null,
				],
			});
		}

		/** 设置面板里的区段（二级入口，保留原有行为）。 */
		function PhoneBridgeSection() {
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", minHeight: 480 },
				children: [
					jsx(PairFrame, {}),
					jsx("div", {
						style: { color: "#8b93a7", fontSize: 12, paddingTop: 10, lineHeight: 1.6 },
						children: "这个页面只在电脑本机（127.0.0.1）打开，二维码里的访问令牌不会离开你的电脑。",
					}),
				],
			});
		}

		/** 需要插槽注册服务。 */
		const inject = ["slots"];

		function apply(ctx) {
			// ① 主入口：侧栏底部，紧挨设置齿轮（list 槽，必须带 id）
			try {
				ctx.slots.inject("sidebar.footer.action", () =>
					ctx.slots.register(
						{
							name: "sidebar.footer.action",
							id: "phone-bridge-action",
							priority: 10,
							label: () => "手机连接",
						},
						FooterAction
					)
				);
			} catch (error) {
				console.error("[phone-bridge] 侧栏入口注册失败", error);
			}

			// ② 二级入口：设置面板区段
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "phone-bridge",
							priority: 1,
							label: () => "手机连接",
						},
						PhoneBridgeSection
					)
				);
			} catch (error) {
				console.error("[phone-bridge] 设置区段注册失败", error);
			}
		}

		// 出处指纹（水印第 4 层）：模块被整体拷走改名后，仍能据此确认来自本项目。见 WATERMARK.md。
		exports.__origin = 'dsh-phone-bridge/DSPB2026';

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
