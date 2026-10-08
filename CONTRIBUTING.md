# 贡献指南（CONTRIBUTING）

PocketPilot 是「**手机指挥 · 电脑执行**」的第三方工具：手机端 Android App（Kotlin + WebView 客户端，
包名 `com.dsh.bridge`）负责指挥与展示；电脑端 Node.js 桥接（`pc/bridge.js`）把手机的请求代理到
本机正在运行的 DeepSeek Harness（DSH）实例上执行。

> 本项目是**独立第三方项目**，与 DeepSeek（深度求索）官方没有隶属、合作或背书关系。

本文只讲"怎么搭环境、怎么改、怎么提交"。安全与隐私的铁律见 [SECURITY.md](SECURITY.md)，
使用风险见 README 的[免责声明](../README.md#免责声明)，第三方组件见[第三方组件与许可证](../README.md#第三方组件与许可证)。

---

## 1. 目录结构

```
pocketpilot/
├─ phone/app-android/             手机端 Android App（Kotlin；WebView 客户端）
│  ├─ app/src/main/java/com/dsh/bridge/
│  │   ├─ MainActivity.kt             主界面：WebView、窄屏适配、看门狗与自动重连、扫码、上传
│  │   ├─ Bridge.kt                   与电脑端桥接通信的最小客户端（握手 / 配对 / 上传）
│  │   ├─ DshStatus.kt                电脑端状态探测（读桥接的 /health）
│  │   ├─ Prefs.kt                    本地设置（桥接地址、令牌、时钟偏差）
│  │   ├─ BridgeLog.kt                手机端日志（令牌等敏感值打码）
│  │   └─ SquareCaptureActivity.kt    正方形取景框扫码（ZXing 本地解码，不依赖 Google Play 服务）
│  ├─ app/src/main/res/values/        英文文案（兜底语言）
│  ├─ app/src/main/res/values-zh/     中文文案
│  └─ tools/make-icon.py              应用图标生成脚本
├─ pc/
│  ├─ bridge.js                   电脑端桥接守护：配对 / 鉴权 / 反向代理 / 文件上传
│  ├─ lib/dsh-client.js           DSH 实例客户端（launch token、Cookie、RPC、权限预设）
│  ├─ lib/dsh-proxy.js            把只监听回环的 DSH 反向代理给手机（含 WebSocket）
│  ├─ lib/tunnel.js               Cloudflare Tunnel 集成（异地访问用）
│  ├─ lib/desktop-auth.js         为 DSH 桌面端实例自签浏览器会话 Cookie
│  ├─ dsh-plugin-phone-bridge/    DSH 前端插件：侧栏「手机连接」入口 + 配对二维码
│  │   ├─ lib/index.js                host 侧入口（零依赖、零副作用）
│  │   ├─ lib/client.js               前端面板；zh / en 两套字典，跟随系统语言
│  │   └─ cordis.patch.yml            插件 patch 层
│  ├─ start-bridge.bat            USB 模式启动
│  └─ start-bridge-lan.bat        局域网模式启动
├─ docs/index.html                发布页（GitHub Pages）
├─ .github/workflows/build.yml    CI：Android 构建 + 仓库卫生（二进制/密钥）检查
├─ .github/hygiene.py             CI 用的仓库卫生检查器（可本地跑，含正反用例自测）
├─ .gitattributes                 行尾统一（防止"整篇文件行尾 diff"）
├─ package.json                   仓库根包：让「填仓库地址安装插件」可用
└─ README.md / CHANGELOG.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md / …
```

---

## 2. 环境准备

### 2.1 手机端（Android）

| 需要 | 版本 / 说明 |
|---|---|
| JDK | **17**（`compileOptions` / `jvmTarget` 都是 17） |
| Android SDK | **35**（`compileSdk = 35`；`minSdk = 26`，即 Android 8.0+） |
| 构建工具 | AGP 8.7.3 + Kotlin 2.0.21，由 Gradle 自动拉取（仓库已配好国内镜像） |

SDK 位置二选一：设环境变量 `ANDROID_HOME`，或在 `phone/app-android/local.properties` 里写
`sdk.dir=<你的 Android SDK 路径>`（该文件已被忽略，**不要提交**）。

### 2.2 电脑端（桥接 + 插件）

只需要 **Node.js 20 或更高**（根 `package.json` 的 `engines` 写的是 `>= 20`）。
桥接依赖一个包（`qrcode`，用来生成配对二维码）：

```bash
cd pc
npm install          # 国内网络可加 --registry=https://registry.npmmirror.com
```

插件本身**没有运行时依赖**（`lib/index.js` 是空的 host 入口，前端直接读本机桥接的 `/pair.json`），
用 `dsh plugin add github:MengTan100/pocketpilot` 安装到电脑端 DSH 即可。

---

## 3. 构建与本地跑通

### 3.1 手机端

```bash
cd phone/app-android
./gradlew assembleDebug          # 产物：app/build/outputs/apk/debug/app-debug.apk
```

> Wrapper 用的是 Gradle **8.10.2**（见 `gradle/wrapper/gradle-wrapper.properties`），配合 AGP 8.7.3。
> 如果你的工作区里没有 `gradlew`（例如从压缩包导出、或很早期的 clone），用本机已安装的 Gradle
> （`gradle assembleDebug`，需 8.9 及以上），或先跑一次 `gradle wrapper` 生成。

Release 包的签名密钥从**仓库外**的 `~/.gradle/gradle.properties` 读取这四个属性：
`POCKETPILOT_STORE_FILE` / `POCKETPILOT_STORE_PASSWORD` / `POCKETPILOT_KEY_ALIAS` /
`POCKETPILOT_KEY_PASSWORD`。**没有密钥时构建不会失败**，只是产出未签名包（方便开源用户自行签名）。

### 3.2 电脑端桥接

```bash
node pc/bridge.js                # 等价于双击 pc\start-bridge.bat（USB 模式）
node pc/bridge.js --mode lan     # 局域网模式（等价于 pc\start-bridge-lan.bat）
```

首次运行会生成 `pc/bridge.config.json`（含随机 `bridgeToken`）并打印配对二维码 / 8 位配对码；
手机 App 扫码即完成配对。自检：

```bash
curl http://127.0.0.1:3080/health        # 应返回 { ok: true, mode, dshRunning, uptime, serverTime }
```

开发时的常用参数：`--mode usb|lan`、`--port <n>`、`--profile <name>`、`--workspace <path>`。

---

## 4. 提交 PR 的步骤

1. **先搜 issue**：确认没人报过同样的问题，避免重复劳动。
2. **从 `main` 开分支**，分支名说清意图：
   `fix/pair-json-origin`、`feat/upload-progress`、`docs/contributing`。
3. **只改这件事**：不要顺手重构无关代码，也不要把格式化/换行符改动混进功能改动里
   （行尾已由 `.gitattributes` 统一，见第 6 节）。
4. **跑自检**（下面的命令在仓库根目录执行）：
   ```bash
   ./gradlew -p phone/app-android assembleDebug   # 手机端必须能构建
   node --check pc/bridge.js                      # 桥接语法自检
   ```
6. **`git add` 要显式列出文件**，不要用 `git add -A` / `git add .`
   —— 本项目有过"把别人正在写的半成品一起提交、推上去编译不过"的真实事故。
   ```bash
   git add pc/bridge.js CONTRIBUTING.md
   ```
7. **提交信息写"为什么"**：一句话说清动机，必要时在正文里写清验证方式
   （例：`Fix /pair.json cross-origin token leak: only allow top-level loopback views`）。
8. **推送并开 PR**，按 `.github/pull_request_template.md` 的三个问题填写：
   改了什么 / 怎么验证的 / 是否影响安全相关的开关。

> 判断推送是否成功，**别靠模糊匹配**：push 输出必须含 `-> main` 且**不含**
> `rejected|fatal|error:`；被拒时 `git fetch` → `git reset --soft origin/main` 再重新提交
> （**不要 `reset --hard`**，会丢掉工作区改动）。

---

## 5. 代码风格

**总原则：注释解释"为什么"，而不是"是什么"。** 这个项目踩过的坑大多反直觉
（例：为什么上游 DSH 一律只绑回环、为什么 `.bat` 里不能写中文、为什么要在 `onPageStarted`
提前注入 CSS），把这些"为什么"留在代码里，比把"这里调了一个函数"写一遍有价值得多。

| 位置 | 约定 |
|---|---|
| Kotlin | 4 空格缩进；一个文件一个主要职责；可见性尽量收窄（`private fun`） |
| 手机端文案 | **不要硬编码中文**：写进 `res/values/strings.xml`（英文兜底）与 `res/values-zh/strings.xml`（中文） |
| JS（桥接 / 插件） | ESM（`"type": "module"` 或 `.mjs`）；2 空格缩进；内置模块统一 `node:` 前缀 |
| 插件界面文案 | `lib/client.js` 里的 `zh` / `en` 字典**必须同时给两套**，界面语言跟随系统（DSH locale 优先，`navigator.language` 兜底） |
| Windows 批处理 | `.bat` 一律**纯 ASCII**：cmd.exe 按当前代码页读文件，UTF-8 中文会乱码成语法错误、双击闪退 |
| 文件头 | 保留各语言的 `SPDX-License-Identifier: MIT` 与版权声明行 |
| 本地路径 | 示例一律用占位符（`<PC的局域网IP>`、`192.168.1.100`、`~/`），**不要**写自己的真实路径 |

---

## 6. 不要提交的东西（运行时状态与密钥）

下面这些**已在 `.gitignore` 里**，请不要用 `git add -f` 绕过 —— 它们含明文令牌或你的个人信息。

| 路径 | 里面有什么 |
|---|---|
| `pc/bridge.config.json` | `bridgeToken`（拿到就等于拿到你电脑的远程执行权限） |
| `pc/runtime/` | 运行状态：令牌、入口地址、本机工作区绝对路径 |
| `pc/logs/`、`*.log` | 日志：带令牌的入口 URL、配对尝试、外部访问审计 |
| `phone/app-android/local.properties` | 你的本机 SDK 路径 |
| `*.jks` / `*.keystore` / `signing.properties` | 签名密钥与口令（泄露 = 别人能冒充你发"官方"版本） |
| `security-denylist.local.txt` | 你自己的姓名 / 网段 / 序列号（写在这里，检查脚本会拦） |
| `pc/tools/bin/`、`*.apk`、`*.exe` | 第三方二进制：既是再分发许可问题，内容也无法审查 |
| 手机截图、`ui.xml`、`phone/*.png` | 隐私（界面转储里就是整段对话） |

**行尾怎么统一**：`.gitattributes` 已规定 —— 源码与文档（`.sh/.mjs/.js/.json/.md/.yml/.kt/.kts`）
在仓库里一律 **LF**，Windows 批处理（`.bat/.cmd`）检出为 **CRLF**，图片与密钥、APK 声明为
`binary`。这样任何人在 Windows 上保存一次，也**不会**产生"整篇文件行尾 diff"。
如果你改了 `.gitattributes` 之后发现某个文件仍有全文 diff，说明那个文件在索引里还是旧行尾：

```bash
git add --renormalize <文件>     # 按新的 .gitattributes 重新规范化行尾
```

---

## 7. 测试与自查

这个项目**没有单元测试框架**，自检靠"脚本 + 真实跑一遍"。请按改动范围执行：

### 必跑（任何改动）

```bash
./gradlew -p phone/app-android assembleDebug   # 手机端构建必须通过
node --check pc/bridge.js                      # 桥接语法自检
# 推送后 GitHub Actions 会自动跑两个 job：android（构建 release 并断言无 application-debuggable）、
# hygiene（git ls-files 里不得出现 *.jks/*.keystore/*.exe/*.msi/*.apk/*.zip 与密钥模式）
```

### 按改动范围

| 改了什么 | 必须做的验证 |
|---|---|
| 手机端 Kotlin / 资源 | `cd phone/app-android && ./gradlew assembleDebug` **必须通过**；再装到真机跑一次配对与打开面板 |
| WebView 注入逻辑（窄屏适配、详情页、看门狗） | 真机复验：打开面板走"复用已加载页面（不重建）"、窄屏详情页正常、IME 弹出不遮挡 |
| 桥接鉴权 / 配对 / 反向代理 | **构造正反用例实测**：该拒的必须拒（无令牌、伪造来源头、跨源请求），该放的必须放（本机顶层导航、正确令牌）。把 4 个用例的命令与结果写进 PR |
| 插件前端 / 多语言 | 装到 DSH 后切换语言看「手机连接」入口与弹窗文案；确认 `zh` 与 `en` 都完整 |
| 文档 | 通读一遍：不贴真实令牌、不写本机绝对路径、示例 IP 统一用 `192.168.1.100` |

### 日志与截图

贴到 issue / PR 前**先去掉令牌与本机地址**：`bridgeToken`、`?k=<token>`、配对码、
内网 IP、`C:\Users\<用户名>` 这类绝对路径。桥接端已把令牌打码输出（`maskSecret()`），
手机端 `BridgeLog.kt` 同理，但你自己额外打印的内容仍可能带明文 —— 提交前扫一眼。

---

## 8. 安全与行为准则

- 发现**安全漏洞**请按 [SECURITY.md](SECURITY.md) 的方式处理，不要开公开 issue 贴出可复现的利用细节。
- 参与讨论请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)（Contributor Covenant 2.1）。
- 提交即表示你同意以 **MIT 许可证**（见 [LICENSE](LICENSE)）授权你的贡献。

谢谢你的贡献 —— 这个项目让"手机指挥、电脑执行"真正能用起来，靠的就是这些细节。
