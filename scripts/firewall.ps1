# 放行 Windows 防火墙端口，让局域网内其它设备（手机）可以访问客服系统
#
# 用法（在项目根目录执行）：
#   npm run firewall          # 放行 3000（客服系统）与 3001（站点托管）
#   npm run firewall:remove   # 移除已添加的规则
#
# 为什么是两个端口：站点托管跑在独立端口上（默认 PORT+1），
# 这样才能和客服系统「不同源」，避免托管页面的 JS 读到登录令牌。
# 如果改了 KEFU_SITES_PORT，用 -SitesPort 传进来即可。
#
# 脚本会自动请求管理员权限（UAC 弹窗），因为修改防火墙必须提权。
# 若不想用脚本，也可手动执行（需以管理员身份打开 PowerShell）：
#   New-NetFirewallRule -DisplayName "云客客服系统 TCP 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private,Domain
#   New-NetFirewallRule -DisplayName "云客客服系统 TCP 3001" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow -Profile Private,Domain

param(
  [int]$Port = 3000,
  [int]$SitesPort = 0,   # 0 表示「跟随默认规则」，即 $Port + 1
  [switch]$Remove
)

if ($SitesPort -eq 0) { $SitesPort = $Port + 1 }

# 需要处理的端口列表（去重，过滤非法值）
$ports = @($Port, $SitesPort) | Where-Object { $_ -gt 0 -and $_ -lt 65536 } | Select-Object -Unique

function Get-RuleName([int]$p) { "云客客服系统 TCP $p" }

# --- 自提权 ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "需要管理员权限来修改防火墙规则，正在请求提权..." -ForegroundColor Yellow
  $argList = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$PSCommandPath`"",
    '-Port', $Port,
    '-SitesPort', $SitesPort
  )
  if ($Remove) { $argList += '-Remove' }
  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait
  } catch {
    Write-Host "提权被取消。你仍可手动以管理员身份运行本脚本，或按 README 手动添加规则。" -ForegroundColor Red
    exit 1
  }
  exit 0
}

Write-Host "以管理员身份运行，端口：$($ports -join ', ')" -ForegroundColor Green

# --- 移除模式 ---
if ($Remove) {
  $removed = 0
  foreach ($p in $ports) {
    $name = Get-RuleName $p
    $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if ($existing) {
      $existing | Remove-NetFirewallRule -ErrorAction SilentlyContinue
      Write-Host "已移除防火墙规则：$name" -ForegroundColor Green
      $removed++
    }
  }
  if ($removed -eq 0) { Write-Host "未找到相关规则（无需移除）" -ForegroundColor Yellow }
  Read-Host "按回车关闭"
  exit 0
}

# --- 添加规则 ---
# 仅对「专用网络(Domain/Private)」放行，不对「公用网络」放行，避免在咖啡馆等不可信网络暴露服务
foreach ($p in $ports) {
  $name = Get-RuleName $p
  try {
    $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if ($existing) {
      $existing | Remove-NetFirewallRule -ErrorAction SilentlyContinue
      Write-Host "已存在同名规则，先移除后重建（$p）" -ForegroundColor Yellow
    }
    New-NetFirewallRule `
      -DisplayName $name `
      -Description "允许局域网内其它设备访问云客客服系统（端口 $p）" `
      -Direction Inbound `
      -Protocol TCP `
      -LocalPort $p `
      -Action Allow `
      -Profile Domain,Private | Out-Null
    Write-Host "✓ 已放行入站 TCP $p（仅专用/域网络）" -ForegroundColor Green
  } catch {
    Write-Host "✗ 端口 $p 添加规则失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  可尝试手动执行：New-NetFirewallRule -DisplayName `"$name`" -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow -Profile Domain,Private"
  }
}

Write-Host "`n提示：若手机仍无法访问，请检查：" -ForegroundColor Cyan
Write-Host "  1. 手机与电脑是否在同一个 Wi-Fi（不要一个连 5G 一个连 2.4G 的不同 SSID）"
Write-Host "  2. 电脑当前网络是否为「专用网络」——若被识别为「公用网络」，本规则不会生效"
Write-Host "     （设置 → 网络和 Internet → 属性 → 网络配置文件改为「专用」）"
Write-Host "  3. 是否开启了第三方防火墙 / 安全软件"
Write-Host "`n查看当前局域网地址：npm run lan"

Write-Host ""
Read-Host "按回车关闭"
