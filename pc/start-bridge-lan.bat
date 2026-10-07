@echo off
REM SPDX-License-Identifier: MIT
REM DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
REM wm:32d12453cc​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
chcp 65001 >nul
title DSH 手机桥接 - 局域网模式
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node 18 或更高版本。
  pause
  exit /b 1
)

echo ============================================================
echo   DSH 手机桥接守护（局域网模式）
echo ------------------------------------------------------------
echo   PC 端会监听 0.0.0.0:3080（控制面），DSH 监听 0.0.0.0:3081。
echo   手机与 PC 需在同一局域网，且 Windows 防火墙放行这两个端口。
echo   首次运行后，请在手机端插件里填入本机局域网 IP 与桥接令牌。
echo ============================================================
echo.

node "%~dp0bridge.js" --mode lan

echo.
echo 桥接已退出。
pause
