@echo off
rem Master の新しい版を組んで、インストーラーを起動する (MS-20)。
rem map 側で何も打たなくてよい: moviAI の画面の撮影 → SeqShelf のビルド → 同梱 → setup → インストール
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-release.ps1" -Install
if errorlevel 1 (
  echo.
  echo リリースを組めませんでした。上のメッセージを確認してください。
  pause
)
