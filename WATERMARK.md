<!--
  本文件由 tools/watermark-apply.mjs 自动加水印，请勿手工删除末尾注释。
-->

# 水印说明（Watermark）

本项目的源码与产物带有**多层、可验证**的原创水印。本文件把水印的**形式、位置、算法、解码方式**
全部公开——这是刻意的：水印的目的在于**证明出处、便于溯源**，而不是藏后门。
偷偷埋东西（尤其是隐形字符）会被安全社区合理地当成恶意代码（参见 CVE-2021-42574 "trojan source"），
所以我们把规则写在这里，任何人都能复算与校验。

## 一、先说清楚：水印能做什么、不能做什么

| 能做 | 不能做 |
|---|---|
| 证明某段代码/某个构建来自本项目 | 阻止别人复制代码（本项目是 MIT，**允许**复制、修改、商用） |
| 被搬运后仍可识别出处（可见码由路径哈希得出，可复算） | 阻止别人**删掉**水印后再分发（删了也只是失去出处标记，不违法） |
| 发现"水印被精确剔除"这一事实，提示代码可能被刻意洗过 | 提供任何法律效力上的保证（许可证才是法律依据） |

> 结论：水印是**溯源与威慑**手段，配合 [LICENSE](LICENSE)（MIT）与 [DISCLAIMER.md](DISCLAIMER.md) 使用。

## 二、六层水印

| 层 | 形式 | 位置 | 可见性 |
|---|---|---|---|
| ① 源码水印行 | `SPDX-License-Identifier: MIT` + 版权行 + `wm:<10位码>` | 每个源码文件头部（注释内） | 打开源码可见 |
| ② 文件专属码 | `wm:` 后的 10 位十六进制 | 同上 | 可见，**可复算**（见第三节） |
| ③ 隐形载荷 | 64 个零宽字符（U+200B/U+200C）编码 `DSPB2026` | 紧跟在 `wm:<码>` 之后，**只在注释里** | 肉眼不可见 |
| ④ 文档水印 | 尾部 HTML 注释 `<!-- wm:... -->` | `.md` 文档末尾 | 渲染后不可见，源码可见 |
| ⑤ JSON 字段水印 | `"_watermark": { project, origin, license, notice }` | `pc/package.json`、插件 `package.json` | 可见 |
| ⑥ 构建/运行时指纹 | `dsh-phone-bridge/DSPB2026` | APK 资源表、App 日志、桥接启动日志、`runtime/bridge-runtime.json`、状态页 HTML 注释、插件 `exports.__origin` | 需查产物 |

覆盖范围：**134 个文件**（`.js/.mjs/.kt/.kts/.gradle/.py/.sh/.ps1/.bat/.xml/.yml/.md`）。
不覆盖：`node_modules/`、`build/`、`.gradle/`、日志、运行时配置、`icon-out/`、已废弃的 toolpkg 脚本。

### 第三层的编码规则（精确）

- 载荷明文固定为 `DSPB2026`（UTF-8 共 8 字节 = 64 位）。
- 每位：`0` → U+200B（ZERO WIDTH SPACE），`1` → U+200C（ZERO WIDTH NON-JOINER），高位在前。
- 因此每个文件头部的 `wm:` 行末尾都挂着**恰好 64 个**零宽字符。

## 三、怎么验证 / 怎么解码

```bash
# 全量校验：缺水印、码不符、载荷被删，一律报错并非 0 退出
node tools/watermark-check.mjs

# 拿到一份疑似被抄走的文件时，解码确认出处
node tools/watermark-check.mjs --decode path/to/suspect-file.kt
```

校验两件事：

1. **可见码 = sha256(`dsh-phone-bridge|<相对路径>`) 的前 10 位**（十六进制）。
   任何人可复算：把文件放回原路径，算出来应当一致；路径被改过就对不上。
2. **隐形载荷解码后必须等于 `DSPB2026`**。

给新增文件补水印（幂等，已打过的会跳过）：

```bash
node tools/watermark-apply.mjs
node tools/watermark-apply.mjs --force   # 改了常量后重写全部
```

## 四、维护须知

- **常量只在一处**：`tools/watermark-lib.mjs` 的 `PROJECT_ID` 与 `PAYLOAD_TEXT`。
  改它们会让所有既有水印校验失败，必须随后跑 `--force` 重打，并同步更新
  `MainActivity` 的 `project_origin_marker` 字符串与桥接的 `ORIGIN_MARK`。
- **新增源文件**：跑一次 `watermark-apply.mjs`；`security-check.mjs` 的第 ⑧ 项会在提交时提醒你。
- **只动注释**：水印永远不进入代码、字符串字面量或数据。
  插入位置也做了保护：shebang、`<?xml?>` 声明、Python 编码声明、`@echo off` 之后。
- **构建兼容性**：Kotlin/Java/Node/Python/Shell/XML/Markdown 均已实测可正常编译解析
  （零宽字符位于注释内，词法分析器会整行跳过）。

## 五、如果你不喜欢隐形字符

有些编辑器或 lint 会对零宽字符告警（这是好事，说明工具在防 trojan source）。
若你想去掉第 ③ 层只保留可见水印，把 `tools/watermark-lib.mjs` 里的
`encodePayload()` 改成返回空串，再跑 `node tools/watermark-apply.mjs --force` 即可；
其余五层不受影响。

<!-- wm:644846366e​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​ · PocketPilot 原创项目 · 见 WATERMARK.md -->
