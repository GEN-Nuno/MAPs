# 配布版を組む (MS-20): release\Master-<版>\ に、Master のフォルダだけで動く一式を作り、Inno Setup で release\Master-Setup-<版>.exe にする。
#   -Version x.y.z : 版 (package.json の version を書き換える。正本)
#   -Force         : 同じ版の setup が既にあっても作り直す
#   -NoSetup       : フォルダだけ組む (Inno Setup を使わない)
#   -MapRepo / -DocRepo : SeqShelf と document のリポジトリ (既定は開発機の場所)
# 同梱する物: server.js・public・scripts・package*.json・master.ico・起動.bat・config.json (配布用: vendor を指す)・
#   node_modules (prod)・node.exe (いま使っている Node)・vendor/seqshelf (dist)・vendor/shelves (本棚 JSON の写し)・
#   vendor/document (文書サーバー + prod の依存)・version.json (版・組んだ時刻・各リポジトリのハッシュ)
# 材料が無ければ止める (半端なリリースを作らない)。
param(
  [string]$Version = '',
  [switch]$Force,
  [switch]$NoSetup,
  [switch]$SkipBuild,
  [switch]$Install,
  [string]$MapRepo = 'C:\map\map',
  [string]$DocRepo = 'C:\実務\document',
  [string]$MoviRepo = 'C:\Users\potet\moviAI'
)
#   -Version 省略 : package.json の版の末尾 (patch) を 1 つ上げる (リリース.bat はこれ)
#   -SkipBuild    : SeqShelf のビルドと moviAI の画面の撮影を飛ばす (材料がもうある時)
#   -Install      : 組んだ setup をそのまま起動する (リリース.bat)
$ErrorActionPreference = 'Stop'
$t0 = Get-Date
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $cur = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $parts = $cur.Split('.')
  $parts[2] = [string]([int]$parts[2] + 1)
  $Version = $parts -join '.'
  Write-Host "版: $cur → $Version (package.json の patch を上げる)"
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版は x.y.z の形で: $Version" }

# --- 0) 材料を作る: moviAI の画面の撮影 → SeqShelf のビルド (map 側でコマンドを打たなくて済むように、ここで全部やる) ---
if (-not $SkipBuild) {
  if ((Test-Path (Join-Path $MoviRepo 'app\main.py')) -and (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host 'moviAI の画面を撮影しています (offscreen)...'
    Push-Location $MoviRepo
    try {
      $env:QT_QPA_PLATFORM = 'offscreen'
      $env:PYTHONIOENCODING = 'utf-8'  # report の絵文字で落ちない (実際に落ちた)
      & python (Join-Path $MapRepo 'scripts\capture_moviai_screens.py') | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'moviAI の画面の撮影に失敗しました' }
    } finally { Pop-Location; Remove-Item Env:QT_QPA_PLATFORM -ErrorAction SilentlyContinue; Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue }
  } else {
    Write-Warning "moviAI のリポジトリか python が無いので画面の撮影を飛ばします ($MoviRepo)"
  }
  Write-Host 'SeqShelf をビルドしています (build:standalone)...'
  Push-Location $MapRepo
  try { cmd /c "npm run build:standalone" | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'SeqShelf のビルドに失敗しました' } } finally { Pop-Location }
}

# --- 1) 材料の確認 ---
$distHtml = Join-Path $MapRepo 'dist\SeqShelf.html'
$screensHtml = Join-Path $MapRepo 'dist\screens.html'
$shelvesDir = Join-Path $MapRepo 'src\shelves'
$docServer = Join-Path $DocRepo 'server.js'
foreach ($f in @($distHtml, $screensHtml, $docServer)) {
  if (-not (Test-Path $f)) { throw "材料がありません: $f (SeqShelf は npm run build:standalone を先に)" }
}
if (-not (Get-ChildItem $shelvesDir -Filter *.json)) { throw "本棚 JSON がありません: $shelvesDir" }
$nodeSrc = (Get-Command node).Source
$iscc = @(
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $NoSetup -and -not $iscc) { Write-Warning "Inno Setup がありません (winget install JRSoftware.InnoSetup)。フォルダだけ組みます"; $NoSetup = $true }
$releaseDir = Join-Path $root 'release'
$setup = Join-Path $releaseDir "Master-Setup-$Version.exe"
if (-not $Force -and -not $NoSetup -and (Test-Path $setup)) { throw "同じ版の setup が既にあります: $setup (-Force で作り直し、または版を上げる)" }

# --- 2) 版 (package.json が正本) ---
& $nodeSrc -e "const fs=require('fs');const p='$($root -replace '\\','/')/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='$Version';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
if ($LASTEXITCODE -ne 0) { throw 'package.json の版を書けませんでした' }

# --- 3) フォルダを組む ---
$out = Join-Path $releaseDir "Master-$Version"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null
foreach ($f in @('server.js', 'package.json', 'package-lock.json', 'master.ico', '起動.bat')) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src $out }
}
Copy-Item (Join-Path $root 'public') (Join-Path $out 'public') -Recurse
Copy-Item (Join-Path $root 'scripts') (Join-Path $out 'scripts') -Recurse
# 配布用の config: vendor を相対で指す。document の正本は利用者のフォルダ (他の機械は %APPDATA%\Master\config.json で上書き)
$base = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg = [ordered]@{
  port = $base.port
  document = [ordered]@{ serverJs = 'vendor/document/server.js'; root = $base.document.root; port = $base.document.port }
  map = [ordered]@{ distHtml = 'vendor/seqshelf/SeqShelf.html'; shelvesDir = 'vendor/shelves' }
}
[IO.File]::WriteAllText((Join-Path $out 'config.json'), (($cfg | ConvertTo-Json -Depth 5) + "`n"), (New-Object Text.UTF8Encoding $false))

# --- 4) 依存 (prod だけ) ---
Push-Location $out
try { cmd /c "npm ci --omit=dev --ignore-scripts --no-audit --no-fund" | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'npm ci に失敗しました' } } finally { Pop-Location }

# --- 5) node.exe ---
Copy-Item $nodeSrc (Join-Path $out 'node.exe')

# --- 6) vendor ---
$vendor = Join-Path $out 'vendor'
New-Item -ItemType Directory -Force (Join-Path $vendor 'seqshelf') | Out-Null
Copy-Item $distHtml (Join-Path $vendor 'seqshelf')
Copy-Item $screensHtml (Join-Path $vendor 'seqshelf')
$screensDir = Join-Path $MapRepo 'dist\screens'
if (Test-Path $screensDir) { Copy-Item $screensDir (Join-Path $vendor 'seqshelf\screens') -Recurse }  # 実物の画面 (S-42)
New-Item -ItemType Directory -Force (Join-Path $vendor 'shelves') | Out-Null
Copy-Item (Join-Path $shelvesDir '*.json') (Join-Path $vendor 'shelves')
$vdoc = Join-Path $vendor 'document'
New-Item -ItemType Directory -Force $vdoc | Out-Null
foreach ($f in @('server.js', 'package.json', 'package-lock.json')) { Copy-Item (Join-Path $DocRepo $f) $vdoc }
Copy-Item (Join-Path $DocRepo 'public') (Join-Path $vdoc 'public') -Recurse
Push-Location $vdoc
try { cmd /c "npm ci --omit=dev --ignore-scripts --no-audit --no-fund" | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'document の npm ci に失敗しました' } } finally { Pop-Location }

# --- 7) version.json ---
function Get-GitState($repo) {
  try {
    $h = (git -C $repo rev-parse --short HEAD 2>$null)
    $dirty = [bool](git -C $repo status --porcelain 2>$null)
    return [ordered]@{ commit = $h; dirty = $dirty }
  } catch { return [ordered]@{ commit = $null; dirty = $null } }
}
$ver = [ordered]@{
  version = $Version
  builtAt = (Get-Date).ToString('o')
  node = (& $nodeSrc -v)
  master = Get-GitState $root
  seqshelf = Get-GitState $MapRepo
  document = Get-GitState $DocRepo
}
[IO.File]::WriteAllText((Join-Path $out 'version.json'), (($ver | ConvertTo-Json -Depth 5) + "`n"), (New-Object Text.UTF8Encoding $false))

$size = [math]::Round((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "リリースのフォルダ: $out ($size MB)"

# --- 8) Inno Setup ---
if (-not $NoSetup) {
  & $iscc "/DAppVersion=$Version" "/DSourceDir=$out" "/DOutputDir=$releaseDir" '/Q' (Join-Path $root 'packaging\installer.iss')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $setup)) { throw 'Inno Setup が失敗しました' }
  $ssize = [math]::Round((Get-Item $setup).Length / 1MB, 1)
  Write-Host "インストーラー: $setup ($ssize MB)"
}
$sec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 0)
Write-Host "所要 $sec 秒"
if ($Install -and -not $NoSetup) {
  Write-Host 'インストーラーを起動します (画面の指示に従ってください)'
  Start-Process -FilePath $setup
}
