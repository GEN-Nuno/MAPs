# 配布版の確認 (MS-20): リリースのフォルダを別ポートで起動し、主な URL を叩いて止める。
#   -Root <release\Master-x.y.z>  -Port 3999 (既定)
# 開発版 (3945) は動いたままでよい。文書サーバー (3939) が動いていればそれを使う。
param([Parameter(Mandatory = $true)][string]$Root, [int]$Port = 3999)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path
# 本物のデータ (%APPDATA%) に触れない: 仮のデータ置き場で起動する (版の引き継ぎのバックアップが本物に書かれた事故から)
$env:MASTER_DATA_DIR = Join-Path $env:TEMP ('master-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $env:MASTER_DATA_DIR | Out-Null
& (Join-Path $Root 'scripts\start-server.ps1') -Root $Root -Port $Port
if ($LASTEXITCODE -ne 0) { throw "配布版を起動できませんでした ($Root, port $Port)" }
$ok = $true
try {
  $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/version" -TimeoutSec 5
  Write-Host ("version: v{0} bundled={1} builtAt={2} signature={3}" -f $v.version, $v.bundled, $v.builtAt, $v.signature)
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($v.pid)"
  Write-Host ("process: {0}" -f $proc.ExecutablePath)
  if ($proc.ExecutablePath -ne (Join-Path $Root 'node.exe')) { Write-Warning '同梱の node.exe で動いていません'; $ok = $false }
  foreach ($u in @('/', '/map', '/map/screens.html', '/schedule.html', '/quality.html', '/api/shelves', '/api/plan', '/api/config')) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$u" -TimeoutSec 10 -UseBasicParsing
      Write-Host ("{0,-22} {1} {2} bytes" -f $u, $r.StatusCode, $r.RawContentLength)
      if ($u -eq '/api/shelves') { $n = ($r.Content | ConvertFrom-Json).shelves.Count; Write-Host ("  本棚 {0} 冊 (vendor/shelves)" -f $n); if ($n -lt 1) { $ok = $false } }
    } catch { Write-Warning ("{0} が失敗: {1}" -f $u, $_.Exception.Message); $ok = $false }
  }
} finally {
  & (Join-Path $Root 'scripts\stop-server.ps1') -Root $Root -Port $Port | Out-Null
  Remove-Item -Recurse -Force $env:MASTER_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:MASTER_DATA_DIR -ErrorAction SilentlyContinue
}
if ($ok) { Write-Host '配布版の確認: OK' } else { Write-Warning '配布版の確認: 失敗あり'; exit 1 }
