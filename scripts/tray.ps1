# Master のタスクトレイ常駐。
# メニュー: 開く (ダブルクリックも) / サーバー再起動 (改修の反映) / 終了。
# 多重起動は Mutex で 1 本に抑える。常駐開始時にサーバーも確保する。
$ErrorActionPreference = 'SilentlyContinue'

# --- 多重起動防止 ---
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\MasterTrayMutex', [ref]$created)
if (-not $created) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$port = (Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json).port
$url = "http://localhost:$port/"

function Start-MasterServer {
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start-server.ps1') | Out-Null
}
function Open-MasterWindow {
  $edge = @(
    "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($edge) { Start-Process -FilePath $edge -ArgumentList "--app=$url" }
  else { Start-Process $url }
}
function Stop-MasterServer {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false }
}

Start-MasterServer

$icon = New-Object System.Windows.Forms.NotifyIcon
$icoPath = Join-Path $root 'master.ico'
if (Test-Path $icoPath) { $icon.Icon = New-Object System.Drawing.Icon($icoPath) }
else { $icon.Icon = [System.Drawing.SystemIcons]::Application }
$ver = try { (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { '' }
$icon.Text = if ($ver) { "Master v$ver" } else { 'Master' }
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('開く')
$miRestart = $menu.Items.Add('サーバー再起動 (改修の反映)')
$menu.Items.Add('-') | Out-Null
$miExit = $menu.Items.Add('終了')
$icon.ContextMenuStrip = $menu

$miOpen.add_Click({ Start-MasterServer; Open-MasterWindow })
$icon.add_DoubleClick({ Start-MasterServer; Open-MasterWindow })
$miRestart.add_Click({
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\restart-server.ps1') | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $icon.ShowBalloonTip(3000, 'Master', 'サーバーを再起動しました', [System.Windows.Forms.ToolTipIcon]::Info)
  } else {
    $icon.ShowBalloonTip(5000, 'Master', 'サーバーの再起動に失敗しました (起動.bat で確認してください)', [System.Windows.Forms.ToolTipIcon]::Error)
  }
})
$miExit.add_Click({
  Stop-MasterServer
  $icon.Visible = $false
  $icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
$mutex.ReleaseMutex()
