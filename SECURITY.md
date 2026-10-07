# 安全与隐私规范（本仓库的强制约束）

> 这份文档不是"建议"，是**提交门槛**。
> 它来自一次真实审计：在准备开源时，仓库里被发现**明文访问令牌**、**本机绝对路径与真实姓名**、
> **整段对话的界面转储**、**近百张手机截图**、以及 **500MB 第三方二进制**。
> 每一条下面都写了"为什么会犯"和"怎么防"，请照着做，别重新踩一遍。

配套的自动检查：`node tools/security-check.mjs`（**退出码非 0 即不可提交**）。
建议装上钩子，让它每次提交自动跑：

```bash
git config core.hooksPath .githooks
```

**相关文档**：[DISCLAIMER.md](DISCLAIMER.md)（免责与安全声明）、
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（依赖许可证，结论：全部宽松许可证，无 copyleft）、
[LICENSE](LICENSE)（MIT）。

---

## 七、许可证合规（开源前已审）

| 范围 | 结论 |
|---|---|
| Android 依赖（8 个直接依赖 + AndroidX/Kotlin 传递依赖） | 全部 **Apache-2.0** |
| Node 依赖（29 个包） | 22 **MIT** + 7 **ISC** |
| 是否含 GPL/LGPL/AGPL/SSPL 等强制开源组件 | **无** |
| 是否复制了第三方源码 | **无**（`SquareCaptureActivity.kt` 仅调用 zxing 公开 API） |
| 是否含 DeepSeek 官方素材 | **无**（图标由自有源图生成；官方文档副本已删除） |
| 二次分发（发 APK）时 | 需随包附 Apache-2.0 / MIT / ISC 许可证文本，见 THIRD-PARTY-NOTICES 第四节 |

---

## 八、风险代码清单（人工复核过的）

| 位置 | 判定 |
|---|---|
| `bridge.js` 的 `/fs/pick` | ✅ 安全：`execFile` + 固定脚本，不插值用户输入 |
| `bridge.js` 的 `/fs/upload` | ✅ 安全：文件名已剥离路径分隔符与控制字符 |
| `bridge.js` 状态页 `innerHTML` 拼接 | 🟡 已加固：加 `esc()` 转义（原先直接拼字符串，属低危注入面） |
| `pc/tools/setup-remote-access.ps1` 公网 IP 探测 | 🟡 已加固：去掉明文 HTTP 端点，改为仅 HTTPS |
| `phone/` 下的 Operit 时代脚本（`install-toolpkg.js`、`patch-registry.js`、`purge-legacy.js` 等） | ⚠️ **已排除出发布范围**：它们通过 root 读写第三方 App 私有数据，公开易被误读为篡改他人 App，且该方案已废弃 |
| `pc/tools/*.mjs`、`phone/*.js` 等调试工具 | ✅ 仅本地使用；`execFile` 传参数组，不走 shell |

---

## 一、铁律（MUST / MUST NOT）

### 1. 绝不提交任何"运行时状态"文件
**必须忽略**：`pc/bridge.config.json`、`pc/runtime/`、`pc/logs/`、`phone/*.log`、`local.properties`、`build/`、`.gradle/`、`node_modules/`。

**为什么**：`bridge-runtime.json` 里存着带 `?k=<token>` 的完整入口 URL 和你的内网 IP；
`bridge.config.json` 存着 `bridgeToken` 与本机工作区绝对路径。
**拿到这个令牌 = 能在你的电脑上执行任意代码**，这不是"配置"，是凭据。

### 2. 绝不把令牌/密钥写进日志或代码
**必须**用 `maskSecret()` 之类的打码函数；**禁止** `log(\`token: ${token}\`)` 这种写法。
**为什么**：日志会被复制、发给别人排查、被压缩上传、被打包带走。打码后仍能比对"是不是同一个令牌"，但泄露日志不再等于交出权限。

### 3. 绝不写本机绝对路径、真实姓名、设备序列号、内网 IP
**必须**用占位符：`<项目目录>`、`<用户目录>`、`<设备序列号>`、`<PC的局域网IP>`。
**为什么**：这些是**个人可识别信息**。示例地址请用 `192.168.1.100` 这类通用值，别用你真实网段。

### 4. 绝不留截图、界面转储、对话内容在仓库里
**必须忽略**：`pc/tools/ui.xml`、`shot-*.png`、`phone/*.png`、任何 `screencap`/`uiautomator dump` 产物。
**为什么**：`uiautomator dump` 的 `ui.xml` 内容是**当前屏幕上的全部文字**——也就是整段对话全文；
截图同理。调试完立刻删，或放到被忽略的目录。

### 5. 绝不把第三方二进制/安装包入仓
**必须忽略**：`apk/`、`pc/tools/bin/`（cloudflared）、`phone/toolpkg_cache/`、`*.apk`、`*.toolpkg`。
**为什么**：一是版权（那是别人的软件，不是你分发的东西），二是体积（这里曾堆到 500MB）。
第三方工具请在 README 里写"如何自行获取"，或用一个下载脚本。

### 6. 只提交你自己的产出
**禁止**把第三方 npm 包自带的文档、`package.json` 复制进仓库（例如 `@deepseek-ai/*` 的说明文件）。
**为什么**：那不是你的作品，开源会带来版权问题与误导（读者以为是你写的）。

---

## 二、Android 端安全基线

| 项 | 要求 | 为什么 |
|---|---|---|
| WebView 远程调试 | `setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` —— **绝不能硬编码 true** | 开着它，任何能插数据线跑 adb 的人都能附着 WebView，读到 URL 里的令牌和整段对话 |
| 应用备份 | `android:allowBackup="false"` | 令牌存在 `shared_prefs/dsh_bridge.xml`，`allowBackup=true` 时能被 `adb backup` 导出 |
| 混合内容 | `MIXED_CONTENT_NEVER_ALLOW` | 隧道是 HTTPS，允许 HTTP 子资源等于给中间人留口子 |
| 文件/内容访问 | `allowFileAccess=false`、`allowContentAccess=false`、两个 `allow*FromFileURLs=false` | 页面完全不需要读本机文件（选文件走 App 自己的选择器），关掉可防注入后读本地文件 |
| 导出组件 | 只让 launcher Activity `exported=true`，其余一律 `false` | 减少攻击面 |
| 启动状态 | WebView 必须 `saveEnabled="false"`，且 `onRestoreInstanceState` 里重新摆正入口页 | 系统的状态恢复发生在 `onCreate` **之后**，会把"入口页"覆盖成"上次的对话页"，造成"一打开就自动进去"的假象（且并未真正连接） |

---

## 三、PC 桥接端安全基线

| 项 | 要求 | 现状 |
|---|---|---|
| 令牌强度 | `crypto.randomBytes(24).toString('base64url')`（192 位） | ✅ 已达标 |
| 令牌比较 | `crypto.timingSafeEqual` 常量时间，先比长度 | ✅ `/fs/*` 路径已用；**URL/cookie 那条仍是字符串比较，待统一** |
| 配对码 | 8 位 × 32 字符表（≈1.1e12）+ **按来源 IP** 限速（不能全局计数，否则攻击者能挤掉真人） | ✅ 已达标 |
| 子进程 | 用 `execFile`（不走 shell），且**参数里绝不插入用户输入** | ✅ `/fs/pick` 的 PowerShell 脚本是固定字符串 |
| 上传落盘 | 文件名剥离 `\ / : * ? " < > \|` 与控制字符后再拼路径 | ✅ 已达标 |
| 隧道来源判定 | 不能只看 `remoteAddress === 127.0.0.1`：**cloudflared 就在本机，公网请求来源也是回环**，必须额外排除隧道请求（CF 头/隧道 Host），否则公网能直接读 `/pair.json`（含令牌） | ✅ 已达标 |
| 公开路由 | 只放行 `/health`、`/`、`/pair/claim`；且 `/health` 对**外部请求**只回 `{ok,service}`、`/` 的状态页不得含令牌 | ✅ 已验证 |
| Cookie | `HttpOnly; SameSite=Lax`；**建议补 `Secure`** | ⚠️ 待补 |

---

## 四、提交前必做

```bash
node tools/security-check.mjs      # 必须通过（退出码 0）
git status --short                 # 人工扫一眼：有没有多出不该有的文件
```

检查项涵盖：明文密钥/令牌、本机绝对路径与姓名、设备序列号、内网 IP、第三方大文件、
截图/转储残留、以及上表里的 Android 安全开关是否被改回危险值。

## 五、万一已经泄露了

1. **先轮换凭据**（不是先删文件）：删掉 `pc/runtime/` 让桥接重新生成令牌，然后在手机上**重新配对**。
   因为只要令牌可能被别人拿到过，它就已经失效了。
2. 若是推到了公开仓库：删掉文件不够，历史里还有 —— 需要重写历史
   （`git filter-repo`）或**直接删库重建**（推荐，最省事、最彻底）。
3. 检查 `pc/logs/`、`~/.dsh/.credentials.yaml` 是否也被同步到了别处。

## 六、明确接受的风险（知情的取舍，不是遗漏）

- **`usesCleartextTraffic="true"`**：桥接在本机/局域网走 HTTP，Android 的网络安全配置**不支持按 IP 段**放行明文，
  因此只能全局放开。缓解：令牌 192 位 + 仅在同一局域网暴露 + 异地走 HTTPS 隧道。
- **`/` 状态页对外可见**：只暴露"这里有个桥接"和版本号，不含令牌。
  若你介意，可在 `PUBLIC_PATHS` 里去掉 `/`（代价是浏览器直接访问会 401）。

<!-- wm:769e360128​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​ · PocketPilot 原创项目 · 见 WATERMARK.md -->
