# master サーバーを起動する。スタートアップ登録・起動.bat・トレイから呼ばれる。
# 既に動いているサーバーのコードがディスク上のコードと同じなら何もしない。違えば入れ替える (MS-19)。
#   -Force : コードが同じでも入れ替える (トレイの「サーバー再起動」)
#   -Root / -Port : 試験用。別のフォルダ・別のポートで動かす
param([string]$Root = '', [int]$Port = 0, [switch]$Force)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$config = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Port -eq 0) { $Port = [int]$config.port } else { $env:PORT = "$Port" }

function Test-Port($p) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); $true } catch { $false } finally { $c.Close() }
}

# server.js の codeSignature() と同じ作り方 (SHA-1 の先頭)
function Get-DiskSignature {
  $a = (Get-FileHash -Algorithm SHA1 -Path (Join-Path $Root 'server.js')).Hash.ToLower().Substring(0, 10)
  $b = (Get-FileHash -Algorithm SHA1 -Path (Join-Path $Root 'config.json')).Hash.ToLower().Substring(0, 6)
  "$a.$b"
}

# MS-19 より前のサーバーは /api/version を持たない (404) — $null を返し、古いものとして扱う
function Get-RunningVersion {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/version" -TimeoutSec 2 } catch { $null }
}

# ポートを待ち受けているのが master のサーバーなら止める。別のプログラムなら止めずに $false
function Stop-OldServer {
  $ids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique)
  foreach ($id in $ids) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    if (-not $p) { continue }
    if ($p.Name -notlike 'node*' -or $p.CommandLine -notmatch 'server\.js') {
      Write-Warning "ポート $Port は別のプログラムが使っています: $($p.Name) (PID $id)。止めません"
      return $false
    }
    # 止めるサーバーが起動した文書サーバー (子プロセス) も止める。強制終了では子が残り、
    # 新しいサーバーが古い文書サーバーを使い続ける。利用者が単体で起動したもの (親が違う) は触らない
    $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | Where-Object { $_.Name -like 'node*' })
    Stop-Process -Id $id -Force -Confirm:$false
    foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
  }
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Test-Port $Port)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

$disk = Get-DiskSignature

if (Test-Port $Port) {
  $v = Get-RunningVersion
  if (-not $Force -and $v -and $v.app -eq 'master' -and $v.signature -eq $disk) { exit 0 }
  $running = if ($v) { "コード $($v.signature)" } else { 'コード不明 (古いサーバー)' }
  Write-Host "動いているサーバー ($running) を止めて、ディスク上のコード ($disk) で起動します"
  if (-not (Stop-OldServer)) {
    Write-Warning "古いサーバーを止められませんでした (port $Port)"
    exit 1
  }
}

# 配布版 (MS-20) はアプリのフォルダに node.exe を同梱する。無ければ PATH の node (開発版)
$nodeExe = Join-Path $Root 'node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }
Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden

# 起動完了（ポートが開く）まで最大10秒待つ
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  if (Test-Port $Port) { $up = $true; break }
  Start-Sleep -Milliseconds 250
}
if (-not $up) {
  Write-Warning "master サーバーの起動を確認できませんでした (port $Port)"
  exit 1
}

# 起動したものが、いまディスクにあるコードであることを確かめる
$v = $null
for ($i = 0; $i -lt 8 -and -not $v; $i++) { $v = Get-RunningVersion; if (-not $v) { Start-Sleep -Milliseconds 250 } }
if (-not $v -or $v.signature -ne $disk) {
  Write-Warning "起動したサーバーのコードがディスクと一致しません (動作中: $($v.signature) / ディスク: $disk)"
  exit 1
}
exit 0
