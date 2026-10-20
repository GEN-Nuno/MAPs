# master を「デスクトップアプリ」として開く: サーバーを確保してから Edge アプリモードの窓を開く。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = (Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json).port
$url = "http://localhost:$port/"

# トレイ常駐も確保する (Mutex により多重起動しない)
Start-Process -FilePath 'powershell' -WindowStyle Hidden -ArgumentList @(
  '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $PSScriptRoot 'tray.ps1')
)
& (Join-Path $PSScriptRoot 'start-server.ps1')

$edge = @(
  "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
  # --app でアドレスバー無しの単独ウィンドウになり、タスクバーにも独立して並ぶ
  Start-Process -FilePath $edge -ArgumentList "--app=$url"
} else {
  Start-Process $url  # Edge が無ければ既定ブラウザで開く
}
