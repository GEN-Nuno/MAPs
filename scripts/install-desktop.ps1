# デスクトップアプリとしてのセットアップを行う:
#  1. アイコン (master.ico) を生成
#  2. デスクトップ / スタートメニューに「Master」ショートカット（Edge アプリモード起動）を作成
#  3. スタートアップに「Master Server」（ログオン時にサーバーを裏で起動）を登録
#  4. サーバーを今すぐ起動
# タスクバーへのピン留めは Windows がプログラムからの操作を禁止しているため、
# 作成したショートカットを右クリック →「タスクバーにピン留めする」で行う。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = (Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json).port
$url = "http://localhost:$port/"
$icoPath = Join-Path $root 'master.ico'

# ---- 1. アイコン生成（紺地に白の M） ----
Add-Type -AssemblyName System.Drawing
$bmp = New-Object Drawing.Bitmap 64, 64
$g = [Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAlias'
$g.Clear([Drawing.Color]::Transparent)
$brush = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(43, 58, 85))
$path = New-Object Drawing.Drawing2D.GraphicsPath
$r = 14
$path.AddArc(0, 0, $r*2, $r*2, 180, 90)
$path.AddArc(63-$r*2, 0, $r*2, $r*2, 270, 90)
$path.AddArc(63-$r*2, 63-$r*2, $r*2, $r*2, 0, 90)
$path.AddArc(0, 63-$r*2, $r*2, $r*2, 90, 90)
$path.CloseFigure()
$g.FillPath($brush, $path)
$font = New-Object Drawing.Font('Segoe UI', 32, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object Drawing.StringFormat
$fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
$g.DrawString('M', $font, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF 0, 0, 64, 62), $fmt)
$g.Dispose()
$icon = [Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [IO.File]::Create($icoPath)
$icon.Save($fs)
$fs.Close()
$bmp.Dispose()
Write-Host "アイコン生成: $icoPath"

# ---- 2. Master ショートカット（Edge アプリモード） ----
$edge = @(
  "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge が見つかりません' }

$wsh = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) ''

foreach ($dir in @($desktop, $startMenu)) {
  $lnk = $wsh.CreateShortcut((Join-Path $dir 'Master.lnk'))
  $lnk.TargetPath = $edge
  $lnk.Arguments = "--app=$url"
  $lnk.IconLocation = $icoPath
  $lnk.Description = 'Master — Map / Document / Schedule'
  $lnk.Save()
  Write-Host "ショートカット作成: $(Join-Path $dir 'Master.lnk')"
}

# ---- 3. スタートアップ登録（ログオン時にトレイ常駐 = サーバーも確保される） ----
$startup = [Environment]::GetFolderPath('Startup')
# 旧登録 (サーバー単体) が残っていれば置き換える
$old = Join-Path $startup 'Master Server.lnk'
if (Test-Path $old) { Remove-Item $old -Force }
$lnk = $wsh.CreateShortcut((Join-Path $startup 'Master Tray.lnk'))
$lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'tray.ps1')`""
$lnk.WindowStyle = 7
$lnk.IconLocation = $icoPath
$lnk.Description = 'Master のトレイ常駐 (サーバーも起動)'
$lnk.Save()
Write-Host "スタートアップ登録: $(Join-Path $startup 'Master Tray.lnk')"

# ---- 4. サーバーを今すぐ起動 ----
& (Join-Path $PSScriptRoot 'start-server.ps1')

Write-Host ''
Write-Host '完了。タスクバーに置くには: デスクトップの「Master」を右クリック →「タスクバーにピン留めする」'
