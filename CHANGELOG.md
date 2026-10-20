# 更新日志

本项目的所有重要变更都记录在这个文件里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。
发布包见 [Releases](https://github.com/MengTan100/pocketpilot/releases)，
图形化发布页见 <https://mengtan100.github.io/pocketpilot/>。

## [0.5.1] - 2026-10-20

本次为「可更新」版本：插件与 App 各自带上升级入口，并把版本号校准到与发布一致，
以后的版本才能真正被检测到并提示升级。

### 新增

- **插件面板的升级入口**：显示「插件 vX · 已是最新 / 有新版本 vY」；
  有新版本时直接给出「复制升级命令」（`dsh plugin add github:MengTan100/pocketpilot`）
  与「下载新版插件」按钮，不用去翻发布页。
- **App 的升级入口**：入口页底部常驻 `vX · 检查更新`，点一下向电脑端询问；
  有新版本时弹「发现新版本 vY」→「下载并安装」（打开浏览器下载，由系统确认安装）。
  还没连上电脑时不硬撑，直接打开发布页。
- **`GET /version`（电脑端唯一判断处）**：`pc/lib/version-check.js` 四路探测
  —— `api.github.com` → `ghfast.top` 镜像 → Pages 的 `version.json` → 镜像 raw；
  10 分钟缓存；**全部失败时明确回"查不到"，不谎报"已是最新"**。
- 发布页与 `docs/version.json`：静态版本清单，作为最后的兜底通道。

### 变更

- **发布资产改用稳定名**：电脑端插件包固定为 `dsh-plugin-phone-bridge.zip`
  （不再随版本号变化），页面与面板里的链接从此不用每版都改。
- 版本号校准：App `versionCode 6 / versionName 0.5.1`，插件包与仓库根包 `0.5.1`，
  与 tag / Release 完全一致 —— 这是升级检测能工作的前提。

## [0.5.0] - 2026-10-20

本次为「异地登录 + 稳定性」版本：双通道并存、公网隧道可用、侧栏抽屉、返回键逐层退出，
并修掉了白屏、切换不刷新、隧道重复（地址乱变）与公网 handshake 泄露 token 等问题。

### 新增

- **异地通道（公网登录）已打通**：桥接默认配置现在会启动 Cloudflare 快速隧道，
  `/handshake` 的 `remoteBases` 会下发公网地址，App 每 ~5 分钟重学一次，
  出门（蜂窝网络 / 异地 Wi-Fi）时自动改走隧道。
  ⚠️ 快速隧道地址在隧道重启后会变；要"永远同一个地址"，请用 Tailscale（两端登录）
  或自备域名（配置 `remoteBase`）。
- **USB + 局域网双通道并存**：桥接不再按模式二选一，始终监听 `0.0.0.0` ——
  USB（adb reverse，回环，免令牌）与局域网（真实网卡，需 `?k=<bridgeToken>`）同时可用。
  拔掉数据线后手机能在 ~3 秒内自动改走局域网，不需要手动切换或重启桥接。
  实测：LAN `/health` 200；无令牌 `/dsh/` 与 `/handshake` 均 401，带令牌 200；
  断开 USB 通道后 App 日志依次出现"探活失败 → 选中局域网 192.168.0.4 → 页面加载完成"。
- **手机端侧栏改为覆盖式抽屉**：DSH 在窄屏把侧栏排进 0 高度行（展开也看不见），
  改为展开时固定定位的抽屉 + 遮罩，点遮罩/再点把手即可收起。
- **返回键逐层退出**：页面浮层 → 页面历史 → 入口页 → 再按一次退到后台，
  不再一按就结束 App。

### 修复

- **设置/账户面板改为铺满全屏**（按用户要求）：之前为了「打开后关得掉」做成居中小窗，
  现在对话框自带右上角 ×，铺满更好用；标签条改为横向可滚动，不再挤成一团。
  实测手机视口 394×759 上面板为 378×743。
- **侧栏里的「设置 / 账户」点不开**：抽屉的 `z-index` 曾写成 2147482000，
  而 DSH 自己的账号菜单实测是 **1100** —— 菜单被抽屉整个盖住，点了像没反应。
  现在抽屉降到 1000（仍高于对话内容），并加了一层兜底：抽屉开着时若出现
  `[role=dialog]`（设置面板等），自动把抽屉收起，避免对话框正好落在抽屉下方。
- **自测里写死了真实 bridge token（高危）**：`LinkSelfTest` 把本机真实令牌当字面量，
  仓库一旦公开就等于公开远程执行权限。已改为假值，并**重写历史**确保没有任何提交包含它
  （逐提交校验 0 命中），因此无需轮换令牌、手机也不用重新配对。
- 新增 `pc/tools/privacy-scan.mjs`：发布前统一扫描**仓库 / 解包后的 APK / 插件 zip**，
  查真实令牌、姓名、设备序列号、API key 形态、Windows 用户目录与签名口令字面量。
- **异地地址乱变（3 条隧道并存）**：桥接的启动流程、`/health`、5 秒轮询都会调用隧道启动，
  而 cloudflared 拿到地址前的几秒里记录还没有 URL，于是每次调用都判为"没隧道" →
  同时拉起 3 个守护进程 / 3 条隧道，`tunnel.json` 被最后写入者覆盖。
  现在守护进程用 pidfile 单实例、`start()` 单飞；实测只重启桥接时地址不变
  （日志 `复用已存在的隧道 … pid=…`）。这也顺带解释了之前频繁的 Cloudflare 429。
- **公网 `/handshake` 泄露 bridge token（高危）**：cloudflared 把公网请求落成本机
  `127.0.0.1`，只判"回环"等于把整个互联网当本机 —— 实测无令牌就能拿到 token。
  现在免鉴权同时要求「非隧道来源 + 回环 + usb 模式」，公网无令牌一律 401。
- **切换到局域网后页面不刷新**（表现为"选了局域网但局域网不可用"）：
  - 加载判据写错：比较的是 `loadedEntry`（上次想加载的地址）而不是 WebView **当前**地址。
    WebView 已经漂回 `127.0.0.1` 时，切到局域网的这次调用会跳过 `loadUrl` ——
    选路成功、握手成功，页面却还停在死掉的 USB 页面上。
  - 主文档加载失败时 `pageLoading` 不复位：`onPageFinished` 不会触发，加载态永久为 true，
    `allowRecovery` 之后拒绝所有恢复，看门狗一声不吭。
  - 新增 15 秒页面加载看门狗：仍卡在加载态就复位并重新选路。

- **白屏**（手机 WebView 打开 `/dsh/` 一片空白）：
  - 根因：手机 WebView 发 `Accept-Encoding: gzip, br`，桌面端 DSH 因此压缩返回 HTML；
    代理为改写 `<base href="/">` → `/dsh/` 先缓存响应体，却把**压缩字节**当 UTF-8 改写，
    改完仍带 `content-encoding: gzip` 发回 —— Chromium 报 `net::ERR_CONTENT_DECODING_FAILED`，整页空白。
  - 修复：改写前按 `Content-Encoding` 解压（gzip / deflate / br），解压后移除该响应头并重算长度；
    解压失败则**原样透传**（宁可丢掉 `<base>` 改写，也不能把损坏正文交给手机）。
  - 新增 `cdp-screen.mjs`：连手机 WebView 重载并抓「页面现状 + 全部请求状态码 + console + 失败加载」，
    白屏这类问题不再靠猜。
  - `test-upstream-auth.js` 增加 gzip 用例（假桌面端会按 `Accept-Encoding` 压缩 HTML），共 15 项。
- **上游鉴权**（手机端偶发 `dsh web authentication required`）：
  - 探活改为**带鉴权探测**：`/state` 里 `desktop.status=200` / `authenticated=true` 才表示上游真能用。
    以前探测不带 Cookie，日志里永远是 401，既分不清"端口不对"和"鉴权没过"，也把真问题淹没了。
  - 新增 `POST /upstream/desktop-session`：桌面端插件把「`connection.authenticatedUrl()` 给的
    带 launch token 地址」交给桥接（回环 + bridge token），桥接访问一次换取 DSH 自己下发的
    `dsh-auth-*` Cookie —— 不再依赖"猜签名密钥"。
  - 代理层 401 改为**等重新鉴权完成后再重试**（旧实现发起后立刻重试，拿到的还是同一份失效凭据，
    必然再 401）；WebSocket 升级同样自愈。重试后仍 401 会明确记录 authority，便于排查。
  - 端口候选里把"已持有会话的端口"排到发现值之前，避免刚换好的会话被端口启发式打断。
  - 新增回归测试 `pc/tools/test-upstream-auth.js`：用假桌面端覆盖交接、代理、401 自愈、
    鉴权入口正反用例，共 14 项，不需要真机、不需要真实桌面端。

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
