@echo off
rem Master を起動する（初回は部品のインストールが自動で走ります）
cd /d "%~dp0"
if not exist node_modules (
  echo 初回セットアップ中です。しばらくお待ちください...
  call npm install
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"
