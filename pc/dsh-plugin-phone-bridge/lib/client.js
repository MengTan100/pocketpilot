// SPDX-License-Identifier: MIT
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

		// ─────────────────────────── 多语言（跟随系统 / DSH 的语言设置）
		//
		// 机制（读 DSH 源码 dsh-client-locale 得到，非猜测）：
		//   ctx.locale.register(NS, { zh, en })  注册字典
		//   ctx.locale.bind(NS)                  取翻译函数 t(key, params)
		//   槽位注册里带 locale: NS              DSH 会把 t 作为 props.t 传给组件
		//
		// 这里**不把 t 一层层往下传 props**，而是解析一次存到模块级的 T：
		// 组件直接调 T('key') 即可，且 T 在调用时读取当前语言，
		// 语言切换后 DSH 的 LocaleFace 会让界面重渲染，取到的就是新语言。
		//
		// 另配**兜底**：万一所在 DSH 版本没有 locale 服务（或注册失败），
		// 就按浏览器/系统语言（navigator.languages → navigator.language → <html lang>）选内置字典，
		// 保证"跟随系统语言"这件事在任何情况下都成立，而不是退化成英文或中文写死。
		const NS = "phoneBridge";
		const DICTS = {
			zh: {
				entry: "手机连接",
				title: T("entry"),
				close: "关闭",
				checking: "正在检查手机桥接…",
				notRunning: "没有检测到手机桥接。",
				notRunningHint: "请在电脑上运行 pc\\start-bridge.bat（首次会显示配对二维码），然后点下面的重试。",
				retry: "重试",
				hint: "用手机 App 扫这个二维码即可配对；也可以手动输入上面的配对码。此页面只在本机回环地址打开。",
				sectionHint: "这个页面只在电脑本机（127.0.0.1）打开，二维码里的访问令牌不会离开你的电脑。",
			},
			en: {
				entry: "Phone link",
				title: "Phone link",
				close: "Close",
				checking: "Checking the phone bridge…",
				notRunning: "Phone bridge not detected.",
				notRunningHint: "Run pc\\start-bridge.bat on your computer (it shows the pairing QR code on first run), then tap Retry.",
				retry: "Retry",
				hint: "Scan this QR code with the phone app to pair; you can also type the pairing code above. This page only opens on the local loopback address.",
				sectionHint: "This page is only served on the computer itself (127.0.0.1); the access token inside the QR code never leaves your computer.",
			},
		};

		/** 按系统/浏览器语言挑字典（zh 开头→中文，其余→英文）。 */
		function detectLang() {
			try {
				const candidates = [].concat(
					navigator.languages || [], navigator.language || [], document.documentElement.lang || ""
				);
				for (const l of candidates) {
					const s = String(l || "").toLowerCase();
					if (s.startsWith("zh")) return "zh";
					if (s.startsWith("en")) return "en";
				}
			} catch (e) { /* 非浏览器环境 */ }
			return "en";
		}

		/** 当前翻译函数；先给个按系统语言查内置字典的兜底。 */
		let T = (key) => (DICTS[detectLang()] || DICTS.en)[key] || DICTS.en[key] || key;

		/** 用 DSH 的翻译函数替换兜底（查不到时仍回落内置字典，避免露出原始 key）。 */
		function useTranslator(fn) {
			if (typeof fn !== "function") return;
			T = (key, params) => {
				let out;
				try { out = fn(key, params); } catch (e) { out = undefined; }
				if (out === undefined || out === null || out === key) {
					const dict = DICTS[detectLang()] || DICTS.en;
					return dict[key] || DICTS.en[key] || key;
				}
				return out;
			};
		}


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
				return jsx("div", { style: CENTER_BOX, children: jsx("div", { children: T("checking") }) });
			}
			if (alive === false) {
				return jsxs("div", {
					style: CENTER_BOX,
					children: [
						jsx("div", { children: T("notRunning") }),
						jsx("div", {
							style: { fontSize: 13, color: "#8b93a7", maxWidth: 380, lineHeight: 1.7 },
							children: T("notRunningHint"),
						}),
						jsx("button", { type: "button", onClick: probe, style: RETRY_BTN, children: T("retry") }),
					],
				});
			}
			return jsx("iframe", {
				src: PAIR_URL,
				title: T("entry"),
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
						"aria-label": T("entry"),
						style: PANEL,
						children: [
							jsxs("div", {
								style: HEADER,
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "center", gap: 8 },
										children: [
											jsx(PhoneIcon, { size: 16 }),
											jsx("span", { style: { fontWeight: 600 }, children: T("title") }),
										],
									}),
									jsx("button", {
										type: "button",
										onClick: onClose,
										style: CLOSE_BTN,
										title: T("close"),
										"aria-label": T("close"),
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
								children: T("hint"),
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
						title: T("entry"),
						"aria-label": T("entry"),
						style: wide ? WIDE_BTN : RAIL_BTN,
						children: wide
							? [jsx(PhoneIcon, { key: "i", size: 16 }), jsx("span", { key: "t", children: T("title") })]
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
						children: T("sectionHint"),
					}),
				],
			});
		}

		/** 需要插槽注册服务。 */
		const inject = ["slots"];

		function apply(ctx) {
			// ③ 多语言：注册中英字典并接上 DSH 的翻译函数，界面文字跟随系统/DSH 语言设置。
			//    用 ctx.effect 包住注册 —— DSH 官方插件都这么写，插件卸载/热更新时会自动注销字典，
			//    不会在反复热加载后残留重复注册。
			try {
				if (ctx.locale && typeof ctx.locale.register === "function") {
					ctx.effect(
						() => ctx.locale.register(NS, { zh: DICTS.zh, en: DICTS.en }),
						"phone-bridge: dictionaries"
					);
				}
				if (ctx.locale && typeof ctx.locale.bind === "function") {
					useTranslator(ctx.locale.bind(NS));
				}
			} catch (error) {
				// 所在 DSH 版本没有 locale 服务也不影响使用：T 会自动回退到按系统语言选内置字典
				console.error("[phone-bridge] 多语言注册失败，回退内置字典", error);
			}
			// ① 主入口：侧栏底部，紧挨设置齿轮（list 槽，必须带 id）
			try {
				ctx.slots.inject("sidebar.footer.action", () =>
					ctx.slots.register(
						{
							name: "sidebar.footer.action",
							id: "phone-bridge-action",
							priority: 10,
							label: () => T("entry"),
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
							label: () => T("entry"),
						},
						PhoneBridgeSection
					)
				);
			} catch (error) {
				console.error("[phone-bridge] 设置区段注册失败", error);
			}
		}

		// 出处指纹（水印第 4 层）：模块被整体拷走改名后，仍能据此确认来自本项目。见 README.md。
		exports.__origin = 'dsh-phone-bridge/DSPB2026';

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
