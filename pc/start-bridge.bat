@echo off
REM SPDX-License-Identifier: MIT
chcp 65001 >nul
title DSH 手机桥接 - USB 模式
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node 18 或更高版本。
  pause
  exit /b 1
)

echo ============================================================
echo   DSH 手机桥接守护（USB / adb reverse 模式）
echo ------------------------------------------------------------
echo   PC 端会在 127.0.0.1:3080 提供控制面，
echo   并自动用 adb reverse 把手机 127.0.0.1:3080 / :3081 映射过来。
echo   手机需已连接 USB 并授权调试。
echo ============================================================
echo.

node "%~dp0bridge.js" --mode usb

echo.
echo 桥接已退出。
pause
