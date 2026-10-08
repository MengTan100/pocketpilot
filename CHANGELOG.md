# 更新日志

本项目的所有重要变更都记录在这个文件里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。
发布包见 [Releases](https://github.com/MengTan100/pocketpilot/releases)，
图形化发布页见 <https://mengtan100.github.io/pocketpilot/>。

## [未发布]

### 变更

- 补齐 GitHub 社区标准文件：`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、
  `.github/ISSUE_TEMPLATE/`（bug 报告 / 功能建议表单）、`.github/pull_request_template.md`、
  `CHANGELOG.md` 与 `.gitattributes`（统一行尾，防止"整篇文件行尾 diff"）。
  本次**未改动任何源码与功能**。

## [0.4.0] - 2026-10-08

首个公开版本：把「手机端跑 Agent」改造为「**手机指挥，电脑执行**」。

### 新增

- **手机端 App（PocketPilot）**：Kotlin + WebView 客户端，包名 `com.dsh.bridge`，
  最低支持 Android 8.0（`minSdk 26`）。手机端不再运行任何 Node / DSH 运行时，
  只负责指挥与展示，真正的 Agent 跑在电脑上。
- **电脑端 DSH 插件**（`pc/dsh-plugin-phone-bridge/`）：在 DSH 侧栏底部加入
  「手机连接」入口，点击弹出配对二维码；host 侧零依赖、零副作用，桥接没运行时
  只影响那一块提示，不会拖累 DSH 启动。插件可从仓库地址直接安装：
  `dsh plugin add github:MengTan100/pocketpilot`。
- **电脑端桥接守护**（`pc/bridge.js`）：把手机的请求代理到本机 DSH 实例，
  负责配对、鉴权、反向代理（含 WebSocket）与文件上传；配套启动脚本
  `pc\start-bridge.bat`（USB）与 `pc\start-bridge-lan.bat`（局域网）。
- **扫码配对**：电脑端显示配对二维码与 8 位配对码，手机 App 扫码即拿到桥接地址与令牌，
  无需手工填地址。配对码尝试按来源 IP 分别限速，连续输错 5 次锁定 60 秒。
- **两种连接方式**：局域网（明文 HTTP，仅限可信网络）与隧道（HTTPS，异地访问）。
- **自动重连**：连接失败达阈值后自动重连，并带冷却与"用户正在操作"闸门，
  避免网络抖动时反复重载页面打断用户。
- **时钟偏差校正**：按电脑端返回的 `serverTime` 记录本机与电脑端的时差，
  修正"用时不同步"的显示问题。
- **文件上传**：手机端文件可上传到电脑，再把电脑上的路径以 `@路径` 写进对话框。
- 图形化发布页（GitHub Pages）：<https://mengtan100.github.io/pocketpilot/>，
  一键下载 APK、复制插件安装命令、查看免责声明。
- 仓库根 `package.json`：让"填仓库地址安装插件"这种安装方式可用。

### 变更

- **插件多语言（中文 / 英文）**：界面文字跟随系统（或 DSH）语言，
  语言切换后自动重渲染；所在 DSH 版本没有 locale 服务时按浏览器 / 系统语言兜底。
- **应用图标更新**：换用 PocketPilot 自己的图标；debug 构建不再加包名后缀，
  避免 MIUI 按包名缓存图标导致"换了图标却还显示旧的"。
- Release 签名改为从**仓库外**的 `~/.gradle/gradle.properties` 读取密钥；
  没有密钥时构建不失败，只是产出未签名包（开源用户可自行签名）。
- 补充校验与许可证说明：保持 `LICENSE` 为纯 MIT 文本以便被正确识别，
  并在 README 里说明许可条款与发布包签名核对方法。

### 修复

- **手机端会话详情页**：窄屏下 DSH 的右栏详情页会被挤成"左右重复、像镜面"的样子，
  现改为覆盖式详情页，并顺带隐藏侧栏收起后残留的图标条，让对话真正铺满屏幕。

### 安全

- 修复 `/pair.json`（与 `/pair` 页面）**可被跨源读取**的问题：这两处内容含 bridge token
  与入口地址。原先只判断"请求来自本机回环"就放行，而回环地址上的任意网页都能
  `fetch('http://127.0.0.1:<port>/pair.json')` 把令牌读走；现在只放行
  "来自回环 + 顶层导航（不带 `Origin`）+ 非隧道来源"的请求。
- 免鉴权路由改为**按来源判断**：`/handshake`、`/desktop`、`/pair` 仅在 USB 模式免鉴权，
  局域网模式一律校验 bridge token；同时排除隧道来源的请求 —— cloudflared 就跑在本机，
  只凭回环地址会把公网用户误判成本机。
- 日志里的令牌统一经 `maskSecret()` 打码输出，不再明文落盘。

[未发布]: https://github.com/MengTan100/pocketpilot/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/MengTan100/pocketpilot/releases/tag/v0.4.0
