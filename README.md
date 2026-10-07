# PocketPilot（手机指挥 · PC 执行）

把「手机端跑 Agent」改造为「**手机指挥，PC 执行**」。

> **命名说明**：`PocketPilot` 是本项目的独立名称。
> 它是**适用于 DeepSeek Harness 的第三方手机客户端**，与 DeepSeek（深度求索）官方没有隶属、
> 合作或背书关系，也不包含、不分发 DeepSeek Harness 本体；相关名称仅作指代性使用。
> （原因：直接把别人的产品名当自己的应用名，属于商标使用不当。）

> 🔐 **准备开源 / 参与开发前必读**：
> - [DISCLAIMER.md](DISCLAIMER.md) —— 免责与安全声明（**这个工具在设计上就等于给手机远程执行你电脑的能力**，请先理解再使用）
> - [SECURITY.md](SECURITY.md) —— 安全与隐私规范（这里曾有明文访问令牌、真实姓名、设备序列号、内网 IP 和整段对话的界面转储被带进仓库）
> - [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) —— 第三方组件与许可证（全部为 Apache-2.0 / MIT / ISC，**无强制开源组件**）
> - [WATERMARK.md](WATERMARK.md) —— 原创水印说明（六层水印；**规则全部公开、只写在注释里**，不是藏后门）
> - [LICENSE](LICENSE) —— MIT
>
> 提交前请跑 `node tools/security-check.mjs`（8 项检查，含水印完整性）与
> `node tools/watermark-check.mjs`；`git config core.hooksPath .githooks` 可自动执行。

---

## 1. 为什么要这样改

原方案是社区 ToolPkg `sidebar_deepseek_harness`（`com.operit.deepseek_harness` v0.7.2）：
它在**手机的 Linux 容器里**安装 Node + pnpm，装 `@deepseek-ai/dsh@latest`，再编译 `node-pty`
原生模块，然后跑一份完整的 DSH Web（`127.0.0.1:3081`），最后用 WebView 显示。

这条路在 Android 上天然脆弱，加载报错几乎必然：

| 先天短板 | 具体表现 |
|---|---|
| 原生模块无预编译包 | `node-pty@1.1.0` 没有 Android/Linux-ARM64 的 prebuild，必须现编译；容器里常缺 `build-essential` |
| 编译产物不可移植 | 容器里 `pty.node` 是悬空 symlink（指向已删除的 `obj.target`），必须再改写成实体文件 |
| 依赖树在手机上重建 | `pnpm install` 的 `allowBuilds` 审批、`ERR_PNPM_IGNORED_BUILDS` 等失败点极多 |
| 存储与内存代价 | 仅编译器就约 113 MB，加上 Node/pnpm/DSH 本体，手机不堪重负 |
| 算力与工具链缺失 | 手机端没有 PC 的编译链、项目文件、本地 MCP 与算力 |

**改造思路**：手机端不再运行任何运行时，只保留「指挥 + 展示」；真正的 Agent 跑在 PC 上，
两边通过 **USB（adb reverse）** 或 **局域网** 打通。

---

## 2. 架构

```
┌──────────────────── 手机 (Operit AI) ────────────────────┐
│  ToolPkg: com.operit.dsh_pc_bridge                       │
│    · 工具集：dsh_pc_run / dsh_pc_submit / dsh_pc_task …   │
│    · 只依赖 Tools.Net.http（QuickJS 沙箱内，无原生依赖）  │
│    · 手机浏览器可直接打开 PC 的 DSH 完整界面              │
└──────────────────────────────────────────────────────────┘
        │ ① USB: adb reverse tcp:3080 / tcp:3081
        │ ② 局域网: http://<PC-IP>:3080
        ▼
┌──────────────────── PC (Windows) ────────────────────────┐
│  dsh-phone-bridge 守护  :3080                            │
│    · 启动并守护一份 DSH Web（专用 profile: bridge）       │
│    · 从子进程 stdout 捕获进程内 launch token（不落盘）    │
│    · 换取并维持 dsh-auth 签名 Cookie                      │
│    · 自动维护 adb reverse 隧道（冲突自愈）                │
│    · 任务队列（同步 /chat、异步 /task + 轮询）            │
│    · 权限预设临时提升 + 任务结束自动恢复                  │
│                                                          │
│  DSH Web  :3081  ← 真正的 Agent 运行时                   │
│    Node 24 · 完整工具链 · 本地 MCP · 你的模型与凭据       │
└──────────────────────────────────────────────────────────┘
```

### 为什么必须由守护进程持有 token

DSH 的 Web 入口用「进程内随机 launch token」鉴权：启动时打印
`http://127.0.0.1:<port>/?token=xxxx`，**token 不写盘**，重启即变；
`GET /?token=` 会下发一个 HMAC 签名的 `dsh-auth-*` Cookie，之后 `/api/*` 凭 Cookie 放行。
所以只有「亲手启动这个进程的守护」才能稳定拿到 token —— 桥接守护正是这个角色。

---

## 3. 快速开始

### 3.1 PC 端

```bat
:: USB 模式（推荐：不占局域网、不对外监听）
<项目目录>\pc\start-bridge.bat

:: 局域网模式（拔线也能用；会监听 0.0.0.0:3080 / :3081）
<项目目录>\pc\start-bridge-lan.bat
```

启动后：
- 控制面：`http://127.0.0.1:3080`（状态页可直接浏览器打开）
- 状态文件：`pc\runtime\bridge-runtime.json`
- 日志：`pc\logs\bridge.log`

首次运行会生成 `pc\bridge.config.json`（含随机 `bridgeToken`）。

常用参数（也可直接 `node pc\bridge.js --mode lan`）：

| 参数 | 说明 |
|---|---|
| `--mode usb\|lan` | 运行模式（默认 usb） |
| `--port <n>` | 桥接控制面端口（默认 3080） |
| `--profile <name>` | DSH profile（默认 bridge） |
| `--workspace <path>` | PC 端任务默认工作目录 |

### 3.2 手机端

**已通过 root 自动部署完成**，无需在手机上手动导入。重装或换版本时，在 PC 上一条命令：

```bat
node phone\install-toolpkg.js phone\com_operit_dsh_pc_bridge-v1.2.0.toolpkg
:: 卸载：追加 --uninstall
:: 多设备并存时：追加 --serial <设备序列号>
```

#### 面板形态：把 PC 端界面直接嵌进手机

侧栏面板的主体是一个**占满屏幕的 WebView**，直接加载 PC 端 DSH 的真实界面 ——
在手机上就能用原生 UI 操作电脑（会话、文件、工具审批、Sub-Agent 全部可用），
而不是"输入任务 → 看文本回执"。

这套 UI 方案直接复用旧插件 `sidebar_deepseek_harness` 的成熟做法：

| 复用项 | 说明 |
|---|---|
| WebView 组件 | `ctx.createWebViewController()` + `UI.WebView({ useWideViewPort, loadWithOverviewMode, supportZoom:false, … })` |
| 手机端布局 CSS | 原样携带 `resource/mobile_optimize.css`，经 `controller.evaluateJavascript()` 注入，用 `html[data-dsh-compact]` 命中紧凑样式 |
| 加载地址形态 | 旧插件加载 `http://127.0.0.1:3081`（手机 Linux 容器内的 DSH）；本插件**加载同一地址**，但 `adb reverse tcp:3081 tcp:3081` 已把它指向 PC 的 DSH —— 所以 UI 代码几乎零改动 |

两处关键差异：

1. **不经过 `ctx.callTool`**：实测在面板内调用同包工具会卡死
   （日志先 `Tool not found: dsh_pc_open_ui`，随后 `Auto-activating` 成功便再无返回）。
   面板改为与工具同处一个 QuickJS 沙箱、直接用 `Tools.Net.http` 请求桥接 `/handshake`。
2. **去掉 Linux 容器时代的逻辑**：安装 / 更新 / 重置 / 进度覆盖层全部移除，
   换成"握手拿 token → 加载 PC 界面 → 刷新"。

#### 数据源：优先连桌面端实例（否则只能看到新会话）

这里有个容易踩的坑：手机若连**桥接实例**（`:3081`，`bridge` profile），它虽然与会话存储
共享、`session/list` 能列出全部会话，但**不知道"你当前在哪个会话"，也没有实时流** ——
打开就是一张新会话页，看不到正在跑的对话。

真正持有"当前会话 + 正在跑的任务 + 待审批弹窗"的是**桌面端实例**（`:19387`，`desktop` profile）。
它的 Web 入口用进程内随机 launch token 鉴权，token 不落盘、重启即变，外部拿不到。
但它的 **Cookie 签名密钥是持久化的**：

```
~/.dsh/.credentials.yaml → records["client-connection/browser-session"]
                           { kind: grant, payload: { version: 1, secret: <32 字节> } }
```

于是桥接按同样算法自签一个合法 Cookie 即可进入桌面端（`pc/lib/desktop-auth.js`）：

```
Cookie 名 = "dsh-auth-" + base64url(sha256(authority))          // authority = 127.0.0.1:19387
Cookie 值 = "v1." + base64url(payload) + "." + base64url(HMAC-SHA256(secret, body))
payload   = { version: 1, authority, issuedAt, expiresAt }
```

落地链路：

```
手机 WebView → http://127.0.0.1:3080/desktop            (免鉴权，仅 USB 模式)
             ← 302 + Set-Cookie(dsh-auth-…) + Location: http://127.0.0.1:19387/
             → 手机 127.0.0.1:19387 经 adb reverse 直达 PC 的桌面端实例
             → 看到当前对话、正在跑的任务，并可直接发消息
```

- `adb reverse` 因此额外维护 `tcp:19387`；
- 桌面端未运行（或局域网模式）时，`/desktop` 自动回退到桥接实例，面板不会白屏；
- 自签密钥只在本机读取，不出网、不写日志明文。

部署器做的事（机制均已在真机验证）：

1. 把 `.toolpkg` 投到 `/sdcard/Android/data/com.ai.assistance.operit/files/packages/`；
2. 解包到 `/data/data/com.ai.assistance.operit/files/toolpkg_cache/<容器ID>-<hash8>/`
   （`hash8` = Java `String.hashCode()` 的无符号十六进制）；
3. 写 `.toolpkg-cache-signature`：
   `external|<包手机绝对路径>|<字节数>|<毫秒时间戳>|<版本>|<入口>`（无末尾换行）；
4. 修正属主/权限/SELinux 标签（`u0_a488` / `700|600` / `app_data_file` + 应用类别）；
5. 停掉 Operit，改写 `shared_prefs/…PackageManager.xml` 的 `imported_packages` 与
   `toolpkg_subpackage_states`，再重启应用。

USB 模式下**无需配置任何环境变量**：插件会自动向 `http://127.0.0.1:3080/handshake`
取得桥接令牌并缓存。

局域网模式请在插件的环境配置里填：

- `DSH_PC_BRIDGE_URL` = `http://<PC的局域网IP>:3080`（如 `http://<PC的局域网IP>:3080`）
- `DSH_PC_BRIDGE_TOKEN` = PC 端 `bridge.config.json` 里的 `bridgeToken`

### 3.2.1 旧插件的处理（重要）

原 `com.operit.deepseek_harness` 已**解除注册并隔离**。原因不只是"加载报错"，
而是它会让 Operit 在启动时直接崩掉：

```
E/CrashReportActivity: java.lang.OutOfMemoryError: Failed to allocate a 56404528 byte allocation
   at com.ai.assistance.operit.core.tools.ToolResultData.toJson
   at ...ToolPkgToolLifecycleBridge.parseToolResultJson
```

它的 dashboard 会自动 dispatch 一个 action，工具结果高达数十 MB，序列化时 OOM。

隔离位置（文件未删除，可恢复）：

```
/sdcard/Download/dsh-bridge/quarantine-legacy/   旧插件缓存与 .toolpkg
/sdcard/Download/dsh-bridge/backup-20261007/     改动前的注册表与包副本
```

恢复：把 `quarantine-legacy/` 里两项放回原位，并用
`backup-20261007/com.ai.assistance.operit.core.tools.PackageManager.xml`
覆盖 `/data/data/com.ai.assistance.operit/shared_prefs/` 下同名文件，然后重启 Operit。


### 3.3 立刻可用（零开发）

USB 连接后，用手机浏览器打开握手返回的 `endpoints.proxyEntry`
（形如 `http://127.0.0.1:3080/dsh/`），即可在手机上操作 **PC 端的完整 DSH 界面**：

```
adb -s <设备序列号> reverse tcp:3080 tcp:3080     # 守护已自动建立
# 手机浏览器打开 proxyEntry
```

### 3.4 局域网模式（不插线也能用）

```bat
pc\start-bridge-lan.bat        :: 等价于 node pc\bridge.js --mode lan
```

#### 为什么不能"让 DSH 直接监听局域网"

DSH 明确拒绝绑定 `0.0.0.0`：

```
error: --host 0.0.0.0 is intentionally not supported yet for safety:
       it would expose remote code execution to the network; use 127.0.0.1 instead
```

这是官方有意为之（Web 界面能执行任意代码）。所以**无论哪种模式，上游 DSH 一律只绑回环**，
"对外可用"完全由桥接的**反向代理**承担（`pc/lib/dsh-proxy.js`），既尊重官方安全边界，
又实现局域网访问。

#### 代理做了什么

| 能力 | 说明 |
|---|---|
| HTTP 转发 | 手机访问 `/dsh/<path>` → 上游 `/<path>`；用 `<base href="./">` 的相对路径天然落在 `/dsh/` 之下，**无需改写 HTML** |
| **WebSocket 转发** | DSH 实时流走 HTTP Upgrade（`/api/remote.mux`），用原始 socket 双向 pipe；握手成功后上游回 `101 Switching Protocols` |
| 鉴权注入 | 桌面端实例的 `dsh-auth` Cookie 由桥接自签并注入，手机侧完全不接触 |
| Host/Origin 重写 | 统一改写为上游 authority，满足 browser-trust fence 与 Cookie 受众校验 |
| 缓存头补强 | 给主入口 `/assets/*` 补 `Cache-Control: public, max-age=31536000, immutable`（DSH 自产资源里这几项缺缓存头） |

#### 局域网下的访问控制

DSH 界面能执行任意代码，因此局域网模式**必须凭令牌访问**：

```
http://<PC的局域网IP>:3080/dsh/?k=<bridgeToken>
```

校验通过后下发 `dsh-bridge-auth` Cookie，后续请求无感。令牌取自
`pc\runtime\bridge-runtime.json` 的 `bridgeToken`，或 `pc\bridge.config.json`。
**桥接不会自动跳转补令牌** —— 那等于把令牌暴露给任何扫描者。

面板无需手工拼地址：`/handshake` 返回的 `endpoints.proxyEntry` 在局域网模式下
已是带 `?k=` 的完整地址，面板直接加载即可（`pc/bridge.js` 的 `phoneEntryUrl()`）。

#### 手机端切换配置

面板「设置」里填两项（面板会自动持久化，工具集也复用同一组环境变量）：

- `DSH_PC_BRIDGE_URL` = `http://<PC的局域网IP>:3080`
- `DSH_PC_BRIDGE_TOKEN` = 上面的 `bridgeToken`

也可用脚本一次写入（应用会被停止后改写、自动修权限与 SELinux 标签）：

```bat
node phone\set-lan-env.js http://<PC的局域网IP>:3080 <bridgeToken>
```

#### 实测结果（手机 <手机的局域网IP> → PC <PC的局域网IP>，纯 WiFi、拔掉数据线）

```
health            -> 200   20ms
dsh 无令牌        -> 401
dsh 带令牌        -> 200   35578 bytes  75ms
静态资源 633 KB   -> 200
WebSocket 握手    -> HTTP/1.1 101 Switching Protocols
```

`netstat` 可见手机直连 PC 的活动连接，桥接日志同步显示：

```
TCP  <PC的局域网IP>:3080   <手机的局域网IP>:39202
proxy POST /api/session/list   -> 200
proxy GET  /api/present.open?sessionId=… -> 200     ← 手机端加载当前对话
proxy POST /api/session/prompt -> 200               ← 手机端直接发消息
```

> 注意：USB 与局域网可同时存在（adb reverse 与 WiFi 两条路都通）。
> 局域网模式要求 Windows 防火墙放行 3080（Node.js 的入站规则通常已存在）。

---

## 4. 手机端可用工具

| 工具 | 用途 |
|---|---|
| `dsh_pc_status` | 连通性自检：DSH 状态、隧道、工作区、可用入口 |
| `dsh_pc_configure` | 持久化桥接地址与令牌（可立即验证） |
| `dsh_pc_run` | 下发任务并**同步**等待最终回复（适合 ≤2 分钟） |
| `dsh_pc_submit` | **异步**提交，立即返回 `taskId` |
| `dsh_pc_task` | 查询异步任务状态 / 结果；不传 ID 则列最近任务 |
| `dsh_pc_sessions` | 列出 PC 端最近会话 |
| `dsh_pc_history` | 读取某会话最近对话 |
| `dsh_pc_open_ui` | 取 PC 端 DSH 界面带鉴权地址 |
| `usage_advice` | 使用建议（纯提示） |

长任务请用 `dsh_pc_submit` + `dsh_pc_task` 轮询，避免手机端 HTTP 等待超时。

---

## 5. 桥接 HTTP API

除 `/health` 与 USB 模式下的 `/handshake` 外，均需 `X-Bridge-Token`（或 body/query `token`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（免鉴权） |
| GET | `/handshake` | 握手：返回 `bridgeToken`、DSH `authenticatedUrl`、隧道与入口信息 |
| GET | `/state` | 同上（需鉴权，用于状态页） |
| POST | `/chat` | `{message, sessionId?, cwd?, timeoutMs?, mode?}` → 同步等最终回复 |
| POST | `/task` | 同上但异步；`{action:"cancel", taskId}` 取消 |
| GET | `/task?id=` | 查询任务；省略 `id` 列出最近任务 |
| POST | `/sessions` | `{limit}` 列出会话 |
| POST | `/history` | `{sessionId, limit}` 读历史 |
| POST | `/rpc` | `{method, args}` 直通 DSH 原生 RPC |
| POST | `/restart` | 重启受管的 DSH 实例 |
| POST | `/tunnel/rebuild` | 重建 adb reverse 映射 |

### 附：DSH 原生 RPC（`/rpc` 直通，协议已实测）

```
POST /api/<method>
{ "type": "client-request", "rpcId": "<id>", "method": "<method>", "payload": { "args": { … } } }
→ { "type": "server-response", "rpcId": "<id>", "result": { "ok": true, "value": … } }
```

常用 method：`session/list`、`session/create`（支持 `request.cwd`）、`session/prompt`
（`request.mode` 只能是 `queue` / `steer`）、`session/page`、`settings/describe`、`settings/mutate`。

---

## 6. 关键实现要点（踩坑记录）

1. **`session/prompt` 的 `mode` 只接受 `queue` / `steer`**，传 `auto` 会得到
   `gateway/input-invalid`。
2. **`payload` 必须恰好含一个 `args` 字段**，否则 `gateway/internal: Remote payload must
   contain exactly one plain-object args field`。
3. **转发必须保持 `Origin` / `Host` 与实例一致**，否则触发 DSH 的 browser-trust fence。
4. **审批无法用纯 HTTP 代答**：`approval/request` 走的是流通道。默认预设
   `workspace-write` 的 `approval=ask` 会让无人值守的手机任务**永久挂起**。
   解决：任务期间把 `permission.defaultPreset` 临时改成 `danger-full-access`
   （其 `approval=never`），任务结束**自动恢复**原值，不影响桌面端的安全默认。
5. **不要把用户主目录当工作区**：ACL 沙箱的临时根会落在工作区内被拒，触发权限升级。
   默认工作区用 `~/dsh-phone-workspace`。
6. **不要用 `web` profile 起桥接实例**：该 profile 里 `dsh-bridges` 等本地依赖与全局核心包
   版本不一致，会让 agent loop 在 `turn/start` 后约 20 ms 抛
   `Cannot read properties of undefined (reading 'length')`。
   用干净的 `bridge` profile（仅 `dsh-base` + `dsh-web-app`，走全局一致版本）已验证稳定。
7. **隧道冲突要自愈**：若手机侧端口已指向别处（例如早期手工把 `3081` 映射到桌面端 `19387`），
   守护会检测到 `remote≠local` 并拆除重建。
8. **`.toolpkg` 就是 ZIP，且条目名必须是正斜杠**：反斜杠会被 Android 当成文件名的一部分，
   导致包加载失败。`phone\build-toolpkg.js` 用最小 ZIP 写入器保证这一点。
9. **Windows 批处理必须避开非 ASCII**：早期两个 `.bat` 用 UTF-8 无 BOM 写了中文，
   而 cmd.exe 默认按 GBK(936) 读文件 → 中文全乱码 → `if (...)` 直接语法错，
   脚本还没走到 `pause` 就崩掉，表现为**双击一闪而过**且无任何输出。
   `chcp 65001` 救不了：cmd 是**先按当前代码页把文件读进来、再执行**的。
   结论：面向前台的 `.bat` 一律写**纯 ASCII**（或存成 GBK / UTF-8 带 BOM）。
   同理**不要用 PowerShell 自提权**：`Start-Process -Verb RunAs '%~f0'`
   在含中文的路径下会因编码错位找不到文件，同样闪退。
10. **两端时钟不一致会直接表现为"用时不同步"**：DSH 前端的
   "深度求索中，用时 X" = 本机 `Date.now()` − 事件里的服务端时间戳。
   实测本机 `w32tm /query /status` 是 `源: Local CMOS Clock`、`Leap 指示符: 3(未同步)`、
   `层次: 0` —— **从未同步过网络时间**，与手机（`auto_time=1`）相差 16 秒。
   用 `pc\tools\fix-clock.bat`（需管理员）改指国内 NTP 后变成
   `层次: 3`、`源: ntp.aliyun.com,…`，两机差值 **0 秒**。
   注意：这只影响时间显示与日志对时，不影响任务执行。
11. **看门狗状态必须放模块级**：面板里 `health` 若定义在组件函数内，每次渲染都会重建，
   `timer` 永远为空 → 定时器被反复启动（日志里同一个 `probe#1` 出现 9 次）。
   同理"确保看门狗在跑"要挂在**渲染路径**上，而不是只挂 `onPageFinished` ——
   走"复用已加载页面"分支时并不会触发 `onPageFinished`，早先因此漏启看门狗。
12. **探活要用真实端点与正确方法**：`present.host` 是 **GET**，用 POST 探活会拿到 404
   而误判为"已断线"。

### 6.1 精简审计（v1.3.0）

插件一度把「面板 + 工具集」两套能力都留着，但面板已经直接内嵌 PC 端完整界面，
工具集里绝大多数能力从此没有调用者。审计后按"只留精华"处理：

| 部件 | 处理 | 原因 |
|---|---|---|
| 面板 `callTool()` | 删除 | 死代码：面板改为 `Tools.Net.http` 直连桥接后已无调用者 |
| 面板 `runtimeGlobal()` | 合并 | 与模块级 `getRuntimeGlobal()` 完全同义 |
| `main.js` lifecycle hook | 删除 | `onApplicationCreate` 只 `return {ok:true}`，不做任何事 |
| 工具 `dsh_pc_configure` | 删除 | 面板「设置」已能写桥接地址 |
| 工具 `dsh_pc_open_ui` | 删除 | 面板自己握手取入口 |
| 工具 `dsh_pc_sessions` / `dsh_pc_history` | 删除 | 内嵌的 DSH 界面自带会话列表与历史 |
| 工具 `dsh_pc_run`（同步等） | 删除 | 长任务会阻塞，统一用异步 submit + poll |
| 工具 `usage_advice` | 删除 | 纯提示，精简后不再需要 |
| **保留** `dsh_pc_status` | — | AI 派任务前的自检 |
| **保留** `dsh_pc_submit` / `dsh_pc_task` | — | 面板做不到的事：让 AI 在对话中派后台任务 |

结果：工具 9 → 3，工具包脚本 29,570 → 13,184 字节（−55%），整包 18,087 → 15,205 字节。

保留不动的部分（都有实际调用者）：
`resource/mobile_optimize.css`（手机端紧凑布局，注入 PC 端 DSH 页面）、
面板的 WebView/握手/复用/探测逻辑、局域网地址设置。

### 6.2 延迟优化（实测数据）

| 优化项 | 说明 |
|---|---|
| **避免 WebView 重建** | 原实现每次 `connect()` 都把 WebView key 换成新时间戳，导致整个 DSH 前端（index 232 KB + vendor 205 KB gzip、约 60 个客户端插件）被反复解析执行。现改为**仅当入口地址变化或用户手动刷新**才换 key，重开面板走 `reuse loaded webview (no rebuild)` |
| CSS 预热 | 在 `onPageStarted` 就并行读取手机端 CSS，不再在 `onPageFinished` 串行等待文件 IO |
| 缩短首帧等待 | 自动连接延时 300 ms → 80 ms（握手本身只要 ~10 ms） |
| 可交互探测 | `probeInteractive()` 轮询输入框出现时刻，量化体感延迟而非只看 `onPageFinished` |

真机实测（`~/dsh-phone-bridge/pc/logs/bridge.log` 与手机 operit.log 同源对照）：

```
page finished in 832ms      ← DOM 就绪
interactive in 1192ms       ← 输入框可用（SPA 插件注册 + WebSocket 建连完成）
reuse loaded webview (no rebuild)   ← 重开面板不重建
```

顺带确认：**USB 传输不是瓶颈** —— 手机侧拉取 633 KB 的 `index.js` 仅需 32 ms，
大头在手机 CPU 解析执行前端 JS。故未引入反代压缩方案（DSH 已开 gzip 且
`/plugins/??` 批次已带 `immutable` 强缓存）。

---

## 7. 故障排查

| 现象 | 处理 |
|---|---|
| `dsh_pc_status` 报握手失败 | PC 端守护没启动，或 USB 未授权调试；跑 `start-bridge.bat` 看日志 |
| 报「桥接要求令牌」 | 局域网模式：填 `DSH_PC_BRIDGE_TOKEN`；或改用 USB 模式 |
| 任务一直 `running` 不返回 | 用 `dsh_pc_task` 看是否卡在审批；确认 `permissionPreset` 已生效（见 §6.4） |
| DSH UI 打开是 401 | token 已随实例重启变化；重新调用 `dsh_pc_open_ui` / `/handshake` |
| 局域网访问 `/api` 被拒 | 用 `start-bridge-lan.bat` 启动（会把各网卡地址加入 `--trusted-host`），并放行防火墙 3080/3081 |
| agent 一提交就报 `reading 'length'` | 检查 `dshProfile` 是否为 `bridge`（见 §6.6） |

---

## 8. 目录结构

```
dsh-phone-bridge/
├─ pc/
│  ├─ bridge.js                桥接守护（控制面 + 隧道 + 任务队列）
│  ├─ lib/dsh-client.js        DSH 实例客户端（token/Cookie/RPC/权限预设）
│  ├─ tools/rpc-probe.js       独立诊断：对任意实例跑一次完整会话往返
│  ├─ bridge.config.json       运行配置（含 bridgeToken）
│  ├─ start-bridge.bat         USB 模式启动
│  ├─ start-bridge-lan.bat     局域网模式启动
│  ├─ runtime/ logs/           状态文件与日志
├─ phone/
│  ├─ toolpkg-src/             手机端 ToolPkg 源码（manifest + dist）
│  ├─ build-toolpkg.js         打包器（正斜杠 ZIP）
│  ├─ test-toolpkg.js          PC 端仿真宿主单测（导入手机前自检）
│  ├─ install-toolpkg.js       root 直装/卸载部署器（本次安装即用它）
│  ├─ patch-registry.js        注册表：注册新包 + 停用旧插件
│  ├─ purge-legacy.js          注册表：彻底移除旧插件条目
│  ├─ install-step1..3.sh      本次安装的分步脚本（保留备查）
│  ├─ PackageManager.xml.*     注册表原件 / 各阶段产物
│  └─ com_operit_dsh_pc_bridge-v1.0.0.toolpkg
└─ README.md
```

## 9. 已回滚的试验痕迹

为定位根因做过的临时改动均已复原或隔离：

- `~/.dsh/profiles/web/package.json` 曾临时精简 bundles，已从 `.bak-bridge` 恢复原状。
- 归因实验用的 `~/.dsh/profiles/probe`（headless 模板）可随时删除。

## 10. 安全与隐私（开源前必读）

**规则全文见 [SECURITY.md](SECURITY.md)；本节只讲怎么执行。**

一次真实审计发现并已修复：明文访问令牌（在 `bridge.config.json` / `bridge-runtime.json` / 日志里）、
真实姓名 18 处、设备序列号、内网 IP、整段对话的界面转储（`ui.xml`）、近百张手机截图、
以及约 500MB 第三方二进制（含一个 385MB 的第三方 APK）。

### 提交前必跑

```bash
node tools/security-check.mjs          # 退出码非 0 即不可提交
git config core.hooksPath .githooks    # 一次性：让每次 commit 自动跑上面的检查
```

检查 6 类：明文凭据、个人信息（绝对路径/姓名/序列号/私有网段）、禁止入仓的产物类型、
Android 安全基线（调试开关/备份/混合内容/WebView 文件访问/启动状态恢复）、
桥接端安全基线（令牌强度/常量时间比较/日志打码/`execFile`）、`.gitignore` 关键项。

### 自己的值要永久拦住？写这里

`security-denylist.local.txt`（**已被忽略，不会入库**）——把姓名、网段、序列号、
令牌等真实值一行一个写进去，检查脚本会逐行比对，以后再被写进代码就会被当场拦下。

### 已按基线加固的项

| 项 | 现状 |
|---|---|
| WebView 远程调试 | 只在 `BuildConfig.DEBUG` 打开（原先硬编码 `true`，正式包会泄露令牌与对话） |
| 应用备份 | `allowBackup="false"`（原先 `true`，令牌可被 `adb backup` 导出） |
| 混合内容 | `MIXED_CONTENT_NEVER_ALLOW` |
| WebView 文件/内容访问 | 全部关闭 |
| 启动状态 | WebView `saveEnabled="false"` + `onRestoreInstanceState` 重新摆正入口页（原先会被系统恢复成"上次的对话页"，造成"一打开就自动进去"的假象） |
| 桥接令牌日志 | 改为 `maskSecret()` 打码 |

### 已知待办

- 桥接端 URL/cookie 那条令牌比较仍是字符串比较，**建议统一到 `timingSafeEqual`**。
- Cookie 建议补 `Secure` 标志。
- 本 README 仍以**已废弃的 Operit ToolPkg 方案**为主线（第 3.2.1、8、9 节及其目录树里的
  `PackageManager.xml.*`、`*.toolpkg` 均已删除），开源前应重写为当前独立 App 方案。

- 桥接专用 profile 为 `~/.dsh/profiles/bridge`，**与桌面端 profile 隔离**，桌面端行为不变。

<!-- wm:5df33da04b​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​ · PocketPilot 原创项目 · 见 WATERMARK.md -->

---

## 许可证（MIT）与免责

本项目采用 **MIT 许可证**（全文见 [LICENSE](LICENSE)）。简单说：

- 你可以自由使用、修改、分发本项目，**包括商业用途**，也可以合并进闭源项目；
- 需要做的是：**保留版权声明与许可证原文**，且**不得**用作者名义为你的衍生品背书。

本项目**不提供任何担保**。它让手机能远程指挥你电脑上的 DSH（等于远程执行能力），
请务必阅读 [DISCLAIMER.md](DISCLAIMER.md)（免责与安全声明）与 [SECURITY.md](SECURITY.md)（安全与隐私规范），
自行评估并承担暴露风险。