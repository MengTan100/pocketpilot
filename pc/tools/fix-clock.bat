@echo off
REM SPDX-License-Identifier: MIT
title Fix System Clock
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   Administrator rights are required.
  echo.
  echo   Right-click this file and pick "Run as administrator".
  echo.
  echo   Or use: Settings - Time and language - Date and time
  echo           turn "Set time automatically" off and on, then "Sync now".
  echo.
  pause
  exit /b 1
)

echo Running clock sync...
call "%~dp0clock-sync-run.bat"

echo.
echo ============================================================
echo   Result
echo ============================================================
if exist "%~dp0clock-fix.log" type "%~dp0clock-fix.log"
echo.
echo Local time now: %date% %time%
echo.
pause
