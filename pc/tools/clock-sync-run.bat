@echo off
REM SPDX-License-Identifier: MIT
setlocal
set LOG=%~dp0clock-fix.log

echo ==== clock sync ==== > "%LOG%"
echo started: %date% %time% >> "%LOG%"
echo. >> "%LOG%"

echo [1/4] current status >> "%LOG%"
w32tm /query /status >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo [2/4] configure NTP peers >> "%LOG%"
w32tm /config /manualpeerlist:"ntp.aliyun.com,ntp1.aliyun.com,ntp2.aliyun.com,ntp.ntsc.ac.cn,time.windows.com" /syncfromflags:manual /reliable:yes /update >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   config failed, trying to start w32time service >> "%LOG%"
  net start w32time >> "%LOG%" 2>&1
)

echo. >> "%LOG%"
echo [3/4] resync >> "%LOG%"
w32tm /resync /force >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   first resync failed, restarting service >> "%LOG%"
  net stop w32time >> "%LOG%" 2>&1
  net start w32time >> "%LOG%" 2>&1
  timeout /t 2 /nobreak >nul
  w32tm /resync /force >> "%LOG%" 2>&1
)

echo. >> "%LOG%"
echo [4/4] status after sync >> "%LOG%"
w32tm /query /status >> "%LOG%" 2>&1
echo. >> "%LOG%"
echo local time now: %date% %time% >> "%LOG%"

echo Done. Log: %LOG%
endlocal
exit /b 0
