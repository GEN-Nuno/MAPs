# Master

map（SeqShelf）・document（docment）・スケジュールを 1 つに束ねるシェルアプリ。

## 構成

```
シェル (Express, port 3945)
├── /            … ハンバーガーメニュー + iframe 切替（隠すだけで破棄しない = 並行動作・状態保持）
├── /map         … C:\map\map\dist\SeqShelf.html を直接配信（再ビルドが即反映）
├── /schedule.html + /api/schedule … 内蔵スケジュール（data/schedule.json に永続化、破損時は .broken-<時刻> へ退避）
│     月間カレンダー。日付クリックで追加、予定クリックで編集・削除、ドラッグで別の日へ移動。
│     右の「今後の予定」パネルに今日以降が時系列で並び、クリックで編集できる。
└── document     … C:\実務\document\server.js を子プロセスとして起動 (port 3939) し iframe で表示
```

既存 2 アプリのコードには一切手を入れていない。パスやポートは `config.json` で変更できる。

## 起動

- ふだん: **タスクトレイの Master アイコン**（ログオン時に常駐）をダブルクリック、
  またはデスクトップ/スタートメニューの **Master** ショートカット
- 手動: `起動.bat` をダブルクリック（初回は npm install が走る。トレイ常駐も立ち上がる）
- 開発: `npm start` → http://localhost:3945

## データの場所と改修の反映

- データは **`%APPDATA%\Master\data`**（予定・計画・SeqShelf バックアップ。`config.json` の
  `dataDir` で変更可）。初回起動時に旧 `data\` から自動移行し、旧フォルダはバックアップとして残る
- 改修の反映: `public/` の変更は**画面の再読み込み**だけ、`server.js` の変更は
  **トレイ右クリック →「サーバー再起動」**。データはコードと分離されているので影響を受けない

## デスクトップアプリ化

```
powershell -ExecutionPolicy Bypass -File scripts\install-desktop.ps1
```

- アイコン生成・ショートカット作成（デスクトップ / スタートメニュー）
- スタートアップ登録（ログオン時にサーバーを裏で起動 → ショートカット即起動）
- タスクバーへは、作成された「Master」を右クリック →「タスクバーにピン留めする」（Windows の制約でここだけ手動）

## 注意

- SeqShelf のデータは localStorage 単位（オリジン別）。Master 経由で初めて開くと初期バナーが出るので、
  そこからバックアップを読み込む。
- SeqShelf を更新したら `C:\map\map` で `npm run build:standalone` すれば Master 側にも反映される。
