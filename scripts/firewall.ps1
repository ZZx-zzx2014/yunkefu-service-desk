# 放行 Windows 防火墙端口，让局域网内其它设备（手机）可以访问客服系统
#
# 用法（在项目根目录执行）：
#   npm run firewall          # 放行默认端口 3000
#   npm run firewall:remove   # 移除已添加的规则
#
# 脚本会自动请求管理员权限（UAC 弹窗），因为修改防火墙必须提权。
# 若不想用脚本，也可手动执行下面这条命令（需以管理员身份打开 PowerShell）：
#   New-NetFirewallRule -DisplayName "Kefu 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private,Domain

param(
  [int]$Port = 3000,
  [switch]$Remove
)

$RuleName = "云客客服系统 TCP $Port"

# --- 自提权 ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "需要管理员权限来修改防火墙规则，正在请求提权..." -ForegroundColor Yellow
  $argList = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$PSCommandPath`"",
    '-Port', $Port
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

Write-Host "以管理员身份运行，端口：$Port" -ForegroundColor Green

# --- 移除模式 ---
if ($Remove) {
  $existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  if ($existing) {
    $existing | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Host "已移除防火墙规则：$RuleName" -ForegroundColor Green
  } else {
    Write-Host "未找到规则：$RuleName（无需移除）" -ForegroundColor Yellow
  }
  Read-Host "按回车关闭"
  exit 0
}

# --- 检查是否已存在 ---
$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
  $existing | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Write-Host "已存在同名规则，先移除后重建。" -ForegroundColor Yellow
}

# --- 添加规则 ---
# 仅对「专用网络(Domain/Private)」放行，不对「公用网络」放行，避免在咖啡馆等不可信网络暴露服务
try {
  New-NetFirewallRule `
    -DisplayName $RuleName `
    -Description "允许局域网内其它设备访问云客客服系统（端口 $Port）" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow `
    -Profile Domain,Private | Out-Null

  Write-Host "`n✓ 已放行入站 TCP $Port（仅专用/域网络）" -ForegroundColor Green
  Write-Host "`n提示：若手机仍无法访问，请检查：" -ForegroundColor Cyan
  Write-Host "  1. 手机与电脑是否在同一个 Wi-Fi（不要一个连 5G 一个连 2.4G 的不同 SSID）"
  Write-Host "  2. 电脑当前网络是否为「专用网络」——若被识别为「公用网络」，本规则不会生效"
  Write-Host "     （设置 → 网络和 Internet → 属性 → 网络配置文件改为「专用」）"
  Write-Host "  3. 是否开启了第三方防火墙 / 安全软件"
  Write-Host "`n查看当前局域网地址：npm run lan"
} catch {
  Write-Host "`n✗ 添加规则失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  可尝试手动执行：New-NetFirewallRule -DisplayName `"$RuleName`" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Domain,Private"
}

Write-Host ""
Read-Host "按回车关闭"
