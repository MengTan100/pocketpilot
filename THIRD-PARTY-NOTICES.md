# 第三方组件与许可证声明

本文件记录本项目使用的第三方组件及其许可证，供合规审查与二次分发时使用。

**审查结论（2026-10）**：本项目的全部第三方依赖均为**宽松许可证**
（Apache-2.0 / MIT / ISC）。**未使用任何 GPL / LGPL / AGPL / SSPL 等强制开源（copyleft）组件**，
因此本项目可以按 [LICENSE](LICENSE)（MIT）自由分发，不会因依赖而被迫改变许可证。

---

## 一、手机端（Android / Kotlin）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| androidx.core:core-ktx | 1.13.1 | Apache-2.0 | Kotlin 扩展 |
| androidx.appcompat:appcompat | 1.7.0 | Apache-2.0 | 兼容性支持、语言切换（`AppCompatDelegate.setApplicationLocales`） |
| androidx.activity:activity-ktx | 1.9.3 | Apache-2.0 | Activity 结果回调（文件选择） |
| androidx.webkit:webkit | 1.12.1 | Apache-2.0 | `addDocumentStartJavaScript`（同步探针需文档开始注入） |
| androidx.constraintlayout:constraintlayout | 2.1.4 | Apache-2.0 | 布局 |
| androidx.lifecycle:lifecycle-runtime-ktx | 2.8.7 | Apache-2.0 | 生命周期协程 |
| org.jetbrains.kotlinx:kotlinx-coroutines-android | 1.8.1 | Apache-2.0 | 协程 |
| com.journeyapps:zxing-android-embedded | 4.3.0 | Apache-2.0 | 扫码配对 |
| com.google.zxing:core（由上一项引入） | 3.4.x | Apache-2.0 | 二维码解码 |
| Kotlin 标准库（由 Kotlin 插件引入） | 2.0.21 | Apache-2.0 | 语言运行时 |

构建工具链（不随产物分发）：Android Gradle Plugin 8.7.3、Gradle 8.10.2、JDK 17 —— 均为 Apache-2.0 / GPL-2.0-with-classpath-exception（**仅作为构建工具使用，不构成衍生作品**）。

> 说明：`SquareCaptureActivity.kt` 是 68 行自有代码，仅调用 zxing-android-embedded 的
> **公开 API**（`CaptureManager`、`DecoratedBarcodeView`），**未复制其源码**，
> 因此不产生额外的源码级署名义务；但**分发 APK 时该库被打包在内**，
> 需随包提供其许可证文本（见第四节）。

## 二、电脑端（Node.js）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| qrcode | ^1.5.4 | MIT | 生成配对二维码 |
| pngjs | （传递） | MIT | `qrcode` 依赖 |
| yargs / yargs-parser / cliui / escalade | （传递） | MIT | `qrcode` CLI 依赖 |
| dijkstrajs / encode-utf8 / isarray / require-directory / string-width / strip-ansi / wrap-ansi / ansi-regex / ansi-styles / color-convert / color-name / emoji-regex / is-fullwidth-code-point | （传递） | MIT | 同上 |
| get-caller-file / require-main-filename / set-blocking / which-module / y18n | （传递） | ISC | 同上 |

**合计 29 个包：22 个 MIT + 7 个 ISC**（由 `pc/package-lock.json` 实际枚举得出）。

## 三、可选的外部程序（**不包含在本仓库内**）

| 程序 | 许可证 | 说明 |
|---|---|---|
| cloudflared | Apache-2.0（Cloudflare） | 异地通道用。**未提交进仓库**（`.gitignore` 已忽略 `pc/tools/bin/`），需自行下载 |
| DSH（DeepSeek Harness） | 归其权利人所有 | 本项目**不分发**它，只连接你本机已运行的实例 |
| adb（Android Platform Tools） | Apache-2.0 | USB 通道用，系统级工具 |

## 四、二次分发（发布 APK / 打包发行）时你需要补做的事

源码仓库里依赖是"按需拉取"的，**不构成再分发**；但如果你发布 **APK 或绿色包**，
就把这些库一起分发了，此时需遵守它们的许可证：

1. **Apache-2.0 组件**：随发行包提供其 `LICENSE` 文本，并保留其中的 `NOTICE` 文件内容（若有）；
   若你修改过其源码，需说明修改。
2. **MIT / ISC 组件**：随发行包保留版权声明与许可证文本。
3. 建议做法：在应用内加一个「开源许可」页面，或随包附一个 `licenses/` 目录。
   Android 可用 `com.google.android.gms:play-services-oss-licenses` 或
   Gradle 的 `licenseReport` 类插件自动生成。

生成完整依赖清单（含传递依赖）的命令：

```bash
# Android：完整依赖树
cd phone/app-android && gradle :app:dependencies --configuration releaseRuntimeClasspath

# Node：当前 lock 里全部包及其许可证
node -e "const l=require('./pc/package-lock.json').packages;for(const[k,v]of Object.entries(l))if(k.startsWith('node_modules/'))console.log(k.replace('node_modules/',''),'|',v.license||'UNKNOWN')"
```

## 五、名称与商标

"DeepSeek"、"DeepSeek Harness" 等名称与标识归其权利人所有。
本项目与 DeepSeek 官方**无隶属或背书关系**，对这些名称仅作**指代性使用**
（说明与哪个软件配合工作）。详见 [DISCLAIMER.md](DISCLAIMER.md) 第三节。

<!-- wm:a6be6567cd​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​ · PocketPilot 原创项目 · 见 WATERMARK.md -->
