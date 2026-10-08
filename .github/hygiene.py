#!/usr/bin/env python3
"""仓库卫生检查（CI 的 hygiene job 也直接跑这个脚本）。

两类检查，任一命中即 exit 1：
  1) 禁止入仓的二进制 / 安装包：只允许 Gradle Wrapper 的 gradle-wrapper.jar；
  2) 明显密钥形态：GitHub 令牌、PEM 私钥头、storePassword 字面量口令。

设计要点（避免"检查器误伤自己与正常配置"）：
  · 正则按真实密钥形态收紧：令牌前缀后必须跟 20 位以上字符；
  · storePassword 只拦字面量赋值（= "xxx" / = 'xxx' / = xxx），
    `storePassword = props["X"]` 这类从属性取值属正常配置，放行；
  · 私钥头与 storePassword 的正则在本文件里是**拆开拼接**的，
    因此这个脚本自身不会被自己的规则命中。

用法：
    python .github/hygiene.py           # 检查（命中即非 0 退出）
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# ── 1) 禁止入仓的文件类型 ────────────────────────────────────────────────
BANNED_SUFFIXES = (
    ".jks", ".keystore", ".exe", ".msi", ".apk", ".zip",
    ".dmg", ".pkg", ".deb", ".rpm", ".so", ".aar", ".jar",
)
# 唯一白名单：Gradle Wrapper 的 jar 必须入库，否则构建不可复现
ALLOWED_PATHS = {"gradle/wrapper/gradle-wrapper.jar"}

# ── 2) 明显密钥形态（拼接构造，避免本文件自我命中）──────────────────────
GITHUB_TOKEN = "ghp_" + r"[A-Za-z0-9]{20,}"
GITHUB_FINE_GRAINED = "github_pat_" + r"[A-Za-z0-9_]{20,}"
PEM_PRIVATE_KEY = "BEGIN " + r"[A-Z ]*" + "PRIVATE KEY"
# 单独匹配"密钥形态"的三个正则；storePassword 走下面的形态判定函数
SECRET_PATTERNS = (GITHUB_TOKEN, GITHUB_FINE_GRAINED, PEM_PRIVATE_KEY)
STORE_PASSWORD_PROBE = re.compile("storePassword" + r"\s*[:=]\s*(\S+)")
STORE_PASSWORD_VALUE = re.compile(r"^(?:\"[^\"]{4,}\"|'[^']{4,}'|[A-Za-z0-9+/=_-]{4,})$")


def is_literal_password(value: str) -> bool:
    """判断 storePassword 的取值是不是"硬编码口令"。

    放行：从变量/属性/配置读取（props.storePassword、signingProps["..."].toString()、
          ${env.X}、System.getenv(...)）—— 取值里含 `.`/`[`/`$` 即视为代码引用；
    拦截：字面量（"hunter2secret"、'hunter2secret'、hunter2secret）。
    """
    if not STORE_PASSWORD_VALUE.match(value):
        return False
    # 含 . [ $ 的取值是代码引用（属性/下标/模板），不是硬编码口令
    if any(ch in value for ch in ".[$"):
        return False
    return True


def find_store_password_secret(line: str) -> bool:
    m = STORE_PASSWORD_PROBE.search(line)
    return bool(m and is_literal_password(m.group(1)))


def line_has_secret(line: str) -> bool:
    if any(re.search(p, line) for p in SECRET_PATTERNS):
        return True
    return find_store_password_secret(line)


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"],
        check=True, capture_output=True, text=True,
    ).stdout
    return [p for p in out.split("\0") if p]


def selftest() -> int:
    """正反用例自测：真实密钥必须被抓到，正常签名代码与文档举例不得误伤。"""
    cases = [
        ("正常签名配置（属性取值）", '                storePassword = signingProps["POCKETPILOT_STORE_PASSWORD"]', False),
        ("正常签名配置（点号属性）", "storePassword = props.storePassword", False),
        ("正常签名配置（读环境变量）", "storePassword = System.getenv('PW')", False),
        ("字面量口令（双引号）", 'storePassword = "hunter2secret"', True),
        ("字面量口令（单引号）", "storePassword: 'hunter2secret'", True),
        ("字面量口令（裸值）", "storePassword=hunter2secret", True),
        ("文档里提到前缀（不应命中）", "以 ghp_ 开头的 GitHub 令牌、github_pat_ 开头的细粒度令牌", False),
        ("真 GitHub 令牌", "token = " + "ghp_" + "A" * 36, True),
        ("真 GitHub 细粒度令牌", "github_pat_" + "B" * 22, True),
        ("PEM 私钥头", "-----BEGIN RSA " + "PRIVATE KEY" + "-----", True),
        ("普通注释（不应命中）", "signing.properties", False),
    ]
    bad = 0
    print("--- hygiene.py 自测（正反用例）---")
    for name, line, want in cases:
        got = line_has_secret(line)
        ok = got == want
        bad += 0 if ok else 1
        print(f"  [{'OK ' if ok else 'FAIL'}] 期望={'命中' if want else '放过'} 实际={'命中' if got else '放过'}  {name}")

    # 自检：本文件自身不得被自己的规则命中
    own = Path(__file__).read_text("utf-8").splitlines()
    self_hits = [i for i, ln in enumerate(own, 1) if line_has_secret(ln)]
    if self_hits:
        bad += 1
        print(f"  [FAIL] hygiene.py 被自己的规则命中，行号 {self_hits}")
    else:
        print("  [OK ] hygiene.py 自身不被自己的规则命中")

    print("自测结论：" + ("全部通过" if bad == 0 else f"{bad} 条不通过"))
    return 0 if bad == 0 else 1


def check_binaries(files: list[str]) -> list[str]:
    hits = []
    for f in files:
        if f in ALLOWED_PATHS:
            continue
        if f.lower().endswith(BANNED_SUFFIXES):
            hits.append(f)
    return hits


def check_secrets(files: list[str]) -> list[tuple[str, int, str]]:
    hits: list[tuple[str, int, str]] = []
    for f in files:
        path = Path(f)
        if not path.is_file():
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:4096]:          # 二进制跳过
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if line_has_secret(line):
                hits.append((f, i, line.strip()[:160]))
    return hits


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()

    files = tracked_files()
    print(f"扫描 git ls-files 中 {len(files)} 个已跟踪文件")

    bad_bin = check_binaries(files)
    print("--- 1) 禁止入仓的二进制 / 安装包 ---")
    if bad_bin:
        print("::error::仓库里出现了不该入库的二进制/安装包：")
        for f in bad_bin:
            print("  " + f)
    else:
        print("OK：没有 *.jks/*.keystore/*.exe/*.msi/*.apk/*.zip 等二进制")
        print("    （唯一白名单：" + ", ".join(sorted(ALLOWED_PATHS)) + "）")

    secrets = check_secrets(files)
    print("--- 2) 明显密钥形态 ---")
    if secrets:
        print("::error::发现疑似密钥：")
        for f, i, line in secrets:
            print(f"  {f}:{i}: {line}")
    else:
        print("OK：没有 GitHub 令牌 / PEM 私钥头 / storePassword 字面量口令")

    ok = not bad_bin and not secrets
    print("\n结论：" + ("通过" if ok else "不通过（命中即不可提交）"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
