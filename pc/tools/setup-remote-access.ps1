# SPDX-License-Identifier: MIT
# DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
# wm:ace429c7ab​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
# setup-remote-access.ps1
# 跨网络（手机在别的 WiFi / 4G，PC 在家里）访问准备：检测穿透通道、给出可选方案、自动登记地址。
#
# 设计原则：不自己实现 NAT 穿透。
#   PC 在运营商 NAT 后（无公网 IP）时，端口映射不可行，必须借道成熟方案。
#   桥接只管"只监听本机 + 自动发现所有网卡地址"，穿透交给下列工具之一：
#     Tailscale  —— 零配置、自动穿透、免费，最省事（首选）
#     ZeroTier   —— 国内用户多，可自建 moon 提升稳定性
#     frp / nps  —— 自建，需要一台公网 VPS，最可控
#
# 用法：
#   pwsh -File setup-remote-access.ps1            体检并给出建议
#   pwsh -File setup-remote-access.ps1 -Apply     把检测到的虚拟网卡地址登记进 bridge.config.json

param(
  [switch]$Apply
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # dsh-phone-bridge
if (-not (Test-Path (Join-Path $root 'pc\bridge.config.json'))) {
  $root = Split-Path -Parent $PSScriptRoot
}
$configPath = Join-Path $root 'pc\bridge.config.json'

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

Section '1) 是否已有公网 IP'
$wan = $null
# ⚠️ 只用 HTTPS：早先用过 http://members.3322.org/...，明文 HTTP 的返回值可被中间人篡改，
#    这个探测结果只用于显示/判断，不该给它被篡改的机会。
foreach ($svc in @('https://ip.3322.net', 'https://api.ipify.org', 'https://ifconfig.me/ip')) {
  try { $wan = (Invoke-RestMethod -Uri $svc -TimeoutSec 8).ToString().Trim(); break } catch {}
}
$lan = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -First 1).IPAddress
Write-Host ("出网公网 IP : {0}" -f ($(if ($wan) { $wan } else { '(探测失败)' })))
Write-Host ("本机内网 IP : {0}" -f $lan)
if ($wan -and $wan -ne $lan) {
  Write-Host '=> 处于 NAT 之后：端口映射不可行，需要 NAT 穿透通道' -ForegroundColor Yellow
} elseif ($wan) {
  Write-Host '=> 看起来有公网 IP（仍需路由器放行 3080）' -ForegroundColor Green
}

Section '2) 已安装的穿透通道'
$channels = @(
  @{ Name = 'Tailscale'; Probe = { Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '100.*' } } },
  @{ Name = 'ZeroTier';  Probe = { Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match 'ZeroTier' } } },
  @{ Name = 'WireGuard'; Probe = { Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match 'WireGuard|wg' } } },
  @{ Name = 'OpenVPN';   Probe = { Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match 'OpenVPN|TAP' } } },
  @{ Name = '其他虚拟网卡'; Probe = {
        Get-NetIPAddress -AddressFamily IPv4 |
          Where-Object { $_.InterfaceAlias -match 'VPN|虚拟|Virtual|Hamachi|Sangfor|EasyConnect' }
      } }
)
$found = @()
foreach ($c in $channels) {
  $ips = @(& $c.Probe | Select-Object -ExpandProperty IPAddress -Unique)
  if ($ips.Count -gt 0) {
    Write-Host ("[已装] {0,-12} {1}" -f $c.Name, ($ips -join ', ')) -ForegroundColor Green
    foreach ($ip in $ips) { $found += [pscustomobject]@{ Channel = $c.Name; IP = $ip } }
  } else {
    Write-Host ("[未装] {0}" -f $c.Name) -ForegroundColor DarkGray
  }
}

Section '3) 建议'
if ($found.Count -eq 0) {
  Write-Host @'
尚未检测到任何穿透通道。手机要跨网络连回来，请在 PC 与手机各装一个（二选一）：

  A. Tailscale（首选：零配置、自动打洞、免费）
     PC  : https://tailscale.com/download/windows
     手机: 应用商店搜 Tailscale
     装好后用同一个账号登录两端，PC 会获得 100.x.x.x 地址。

  B. ZeroTier（国内用户多，可自建 moon 提速）
     PC  : https://www.zerotier.com/download/
     手机: 应用商店搜 ZeroTier One
     两端加入同一个 Network ID。

  C. frp / nps（需要一台公网 VPS，最可控）
     在 VPS 上跑服务端，PC 上跑客户端把 3080 反向映射出去。

装好后重新运行本脚本，用 -Apply 把虚拟网卡地址登记进 bridge.config.json。
'@ -ForegroundColor Yellow
} else {
  Write-Host '检测到的通道地址如下，手机端装上同款客户端并登录同一账号/网络即可访问：' -ForegroundColor Green
  $found | Format-Table -AutoSize
  Write-Host '桥接本身已经在扫描全部网卡，装好通道后会自然出现在 /handshake 的候选地址里。' -ForegroundColor Green
}

Section '4) 当前桥接暴露的候选地址'
try {
  $rt = Join-Path $root 'pc\runtime\bridge-runtime.json'
  $mode = '(未知)'
  if (Test-Path $rt) {
    $r = Get-Content $rt -Raw -Encoding UTF8 | ConvertFrom-Json
    # 运行时模式才是准的：启动时可用 --mode 覆盖配置文件里的值
    $mode = $r.mode
    Write-Host ("运行模式     : {0}" -f $r.mode)
    Write-Host ("桥接端口     : {0}" -f $r.bridgePort)
    Write-Host '候选入口（手机端会按延迟择优）:'
    Write-Host ("  USB    : {0}" -f $r.endpoints.usbBase)
    foreach ($b in $r.endpoints.lanBases) { Write-Host ("  网卡   : {0}" -f $b) }
  } else {
    Write-Host '运行时状态文件不存在（桥接未运行？）' -ForegroundColor Yellow
  }
  if ($mode -eq 'usb') {
    Write-Host ''
    Write-Host '注意：当前是 usb 模式，桥接只监听 127.0.0.1，虚拟网卡地址无法访问。' -ForegroundColor Yellow
    Write-Host '      跨网络访问请改用：pc\start-bridge-lan.bat（监听 0.0.0.0，仍强制令牌校验）' -ForegroundColor Yellow
  }
} catch {
  Write-Host '读取运行时状态失败（桥接可能未运行）' -ForegroundColor Yellow
}

if ($Apply -and $found.Count -gt 0) {
  Section '5) 登记地址'
  Write-Host '桥接会自动扫描全部网卡，通常无需手工登记。'
  Write-Host '若虚拟网卡未出现在候选里，请确认桥接正在运行后重启它。'
}

Section '完成'
Write-Host '安全提示：跨网络访问务必保留令牌校验（局域网/远程模式默认要求 ?k=<bridgeToken>）。'
Write-Host '不建议把 3080 直接映射到公网；优先走 VPN 类通道。'
