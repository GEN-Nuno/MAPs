# master サーバーを再起動する (トレイの「サーバー再起動」)。
# コードが同じでも入れ替える。止める対象の見分けと、文書サーバー (子プロセス) の扱いは start-server.ps1 と共通。
# server.js / config.json の改修は、起動し直すだけで反映される (MS-19)。ここは node_modules の更新や、
# 動きがおかしい時に使う。
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'start-server.ps1') -Force
exit $LASTEXITCODE
