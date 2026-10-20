# master サーバーを止める (MS-20)。インストーラーが入れ替えの前に呼ぶ (node.exe・server.js が使用中だと差し替えられない)。
# ポートを待ち受けているのが master (node で server.js) なら、起動した文書サーバー (子プロセス) ごと止める。
# 何も動いていなければ 0。別のプログラムが使っていれば止めずに 1。
param([string]$Root = '', [int]$Port = 0)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if ($Port -eq 0) {
  $Port = [int](Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).port
}

function Test-Port($p) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); $true } catch { $false } finally { $c.Close() }
}

if (-not (Test-Port $Port)) { Write-Host "master は動いていません (port $Port)"; exit 0 }

$ids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique)
foreach ($id in $ids) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if (-not $p) { continue }
  if ($p.Name -notlike 'node*' -or $p.CommandLine -notmatch 'server\.js') {
    Write-Warning "ポート $Port は別のプログラムが使っています: $($p.Name) (PID $id)。止めません"
    exit 1
  }
  $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | Where-Object { $_.Name -like 'node*' })
  Stop-Process -Id $id -Force -Confirm:$false
  foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
}
for ($i = 0; $i -lt 20; $i++) {
  if (-not (Test-Port $Port)) { Write-Host "master を止めました (port $Port)"; exit 0 }
  Start-Sleep -Milliseconds 250
}
Write-Warning "master を止められませんでした (port $Port)"
exit 1
