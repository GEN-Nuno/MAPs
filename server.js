// master: map(SeqShelf)・document(docment)・スケジュールを束ねるシェルサーバー。
// - document は既存の server.js を子プロセスとして起動する（コードには手を入れない）
// - map は SeqShelf の standalone ビルドを直接配信する（再ビルドが即反映される）
// - スケジュールは本アプリ内蔵のモジュール（data/schedule.json に永続化）
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

// 設定の層 (MS-20): アプリの config.json に、利用者の %APPDATA%\Master\config.json を深く重ねる。
// パスは相対 (アプリのフォルダ基準) でも絶対でもよい。配布版は vendor/ を相対で指し、開発版は C:\map\map を絶対で指す。
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
}
function resolvePath(p) {
  return p && !path.isAbsolute(p) ? path.join(__dirname, p) : p;
}
const USER_CONFIG_FILE = path.join(process.env.APPDATA || __dirname, 'Master', 'config.json');
function loadConfig() {
  let c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  if (fs.existsSync(USER_CONFIG_FILE)) {
    try {
      c = deepMerge(c, JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8')));
      console.log(`利用者の設定を重ねました: ${USER_CONFIG_FILE}`);
    } catch (e) {
      console.warn(`利用者の設定が読めないので無視します: ${USER_CONFIG_FILE} (${e.message})`);
    }
  }
  c.map = { ...c.map, distHtml: resolvePath(c.map.distHtml), shelvesDir: resolvePath(c.map.shelvesDir) };
  c.document = { ...c.document, serverJs: resolvePath(c.document.serverJs), root: resolvePath(c.document.root) };
  for (const [label, p] of [['map.distHtml', c.map.distHtml], ['map.shelvesDir', c.map.shelvesDir], ['document.serverJs', c.document.serverJs], ['document.root', c.document.root]]) {
    if (p && !fs.existsSync(p)) console.warn(`設定の場所が見つかりません: ${label} = ${p}`);
  }
  return c;
}
const config = loadConfig();
const PORT = process.env.PORT || config.port;
// 版 (MS-20): package.json の version が正本。配布版は build-release.ps1 が version.json (builtAt・各リポジトリのハッシュ) を置く
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
let BUILD = {};
try {
  BUILD = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8'));
} catch {
  /* 開発版には無い */
}

// 動いているコードの署名 (MS-19)。起動スクリプトがディスク上のコードと比べ、違えば入れ替える。
// server.js と config.json の内容から作る (git のハッシュだと、コミット前の変更を見分けられない)。
// 起動時に 1 回だけ読む — 起動後にファイルが変わっても、動いているコードの署名は変わらない
function codeSignature() {
  const sha = (file) => crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, file))).digest('hex');
  return `${sha('server.js').slice(0, 10)}.${sha('config.json').slice(0, 6)}`;
}
const CODE_SIGNATURE = codeSignature();
const STARTED_AT = new Date().toISOString();

// データ置き場: 既定は %APPDATA%\Master\data (config.dataDir で上書き可)。
// コードとデータを分離し、リポジトリの差し替え・git 管理がデータに触れないようにする
// MASTER_DATA_DIR は試験用 (test-release.ps1 が仮のフォルダを渡す。本物のデータに版の引き継ぎを書かないため)
const DATA_DIR =
  process.env.MASTER_DATA_DIR || config.dataDir || path.join(process.env.APPDATA || __dirname, 'Master', 'data');

// 旧 data (リポジトリ内) からの自動移行。copy 方式 (失敗しても旧が残る)・
// 新側優先 (上書きしない)・.migrated 印で二重移行を防ぐ。毎回の起動で走っても安全
function migrateLegacyData() {
  const legacy = path.join(__dirname, 'data');
  if (path.resolve(legacy) === path.resolve(DATA_DIR)) return;
  const marker = path.join(legacy, '.migrated');
  if (!fs.existsSync(legacy) || fs.existsSync(marker)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.cpSync(legacy, DATA_DIR, { recursive: true, force: false, errorOnExist: false });
  fs.writeFileSync(
    marker,
    `moved to ${DATA_DIR} at ${new Date().toISOString()}\nこのフォルダは移行時のバックアップとして残しています。\n`,
    'utf8'
  );
  console.log(`データを移行しました: ${legacy} → ${DATA_DIR} (旧フォルダはバックアップとして残置)`);
}
migrateLegacyData();

// 版の引き継ぎ (MS-20): 版が変わった最初の起動で plan / schedule を backups/upgrade に写してから、新しい版を記録する。
// 失敗しても起動は続ける (データは触っていない)
function handoverVersion() {
  const file = path.join(DATA_DIR, 'version.json');
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8')).version || null;
  } catch {
    /* 初回 */
  }
  if (prev === PKG.version) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const dir = path.join(DATA_DIR, 'backups', 'upgrade', `${prev || 'none'}-to-${PKG.version}-${stamp}`);
    let n = 0;
    for (const f of ['plan.json', 'schedule.json']) {
      const src = path.join(DATA_DIR, f);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(src, path.join(dir, f));
      n++;
    }
    fs.writeFileSync(file, JSON.stringify({ version: PKG.version, previous: prev, at: new Date().toISOString() }, null, 2), 'utf8');
    console.log(`版が変わりました: ${prev || '(初回)'} → ${PKG.version}。${n} ファイルを ${dir} に写しました`);
  } catch (e) {
    console.warn(`版の引き継ぎに失敗しました (起動は続けます): ${e.message}`);
  }
}
handoverVersion();

const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

const app = express();
// SeqShelf の全データバックアップ (本棚 + ライブラリ) は数 MB になりうるため大きめに取る
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- map (SeqShelf standalone) ----

app.get('/map', (req, res, next) => {
  // 末尾の / を付けて開き直す (S-43): SeqShelf の中の相対 URL (screens/moviAI/home.html・SeqShelf.html#map) が
  // /map/ の下に解決されるように。/map のままだと /screens/... になり 404 だった
  const [p, q] = req.originalUrl.split('?');
  if (!p.endsWith('/')) return res.redirect(302, `${p}/${q !== undefined ? `?${q}` : ''}`);
  next();
}, (req, res) => {
  if (!fs.existsSync(config.map.distHtml)) {
    return res
      .status(503)
      .send('SeqShelf のビルドが見つかりません。C:\\map\\map で npm run build:standalone を実行してください。');
  }
  // 再ビルドを即反映させるためキャッシュさせない
  res.set('Cache-Control', 'no-store');
  res.sendFile(config.map.distHtml);
});

// /map 配下の本番同等 HTML (MS-1 追記、2026-10-14): 画面の一覧 (screens.html) と本体 (SeqShelf.html)。
// 一覧のリンクは SeqShelf.html#map のような相対参照なので、同じ階層で両方を配る。dist の他のファイルは配らない。
const MAP_FILES = new Set(['SeqShelf.html', 'screens.html']); // Express 5 (path-to-regexp v8) は :file(a|b) の書き方を受けないので許可表で絞る
app.get('/map/:file', (req, res, next) => {
  if (!MAP_FILES.has(req.params.file)) return next();
  const file = path.join(path.dirname(config.map.distHtml), req.params.file);
  if (!fs.existsSync(file)) {
    return res.status(503).send('SeqShelf のビルドが見つかりません。C:\\map\\map で npm run build:standalone を実行してください。');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(file);
});
// 実物の画面の HTML (S-42): dist/screens/<pj>/<画面>.html (+ png)。PySide のアプリは撮った画像 + クラスの領域
app.use('/map/screens', express.static(path.join(path.dirname(config.map.distHtml), 'screens'), { cacheControl: false, etag: false }));

// ---- PJ 本棚カタログ (shelves フォルダ = 正本 から自動収集) ----

// version:2 かつ diagrams が配列のものだけを本棚と認める (package 用 JSON 等の紛れ込みを除外)
function readShelfFile(file) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(config.map.shelvesDir, file), 'utf8'));
    if (d.version === 2 && Array.isArray(d.diagrams)) return d;
  } catch {}
  return null;
}

app.get('/api/shelves', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(config.map.shelvesDir).filter((f) => f.endsWith('.json'));
  } catch {
    return res.json({ shelves: [] }); // フォルダが読めない環境では空 (シェル側が同梱一覧で代替)
  }
  const shelves = [];
  for (const f of files) {
    const d = readShelfFile(f);
    if (d) shelves.push({ id: f.slice(0, -5), name: d.name || f.slice(0, -5) });
  }
  shelves.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  res.json({ shelves });
});

app.get('/api/shelves/:id', (req, res) => {
  // ID はファイル名の英数・-_. のみ。パス区切りや .. でフォルダ外に出さない
  if (!/^[\w.-]+$/.test(req.params.id) || req.params.id.includes('..')) {
    return res.status(400).json({ error: 'ID が不正です' });
  }
  const d = readShelfFile(req.params.id + '.json');
  if (!d) return res.status(404).json({ error: '本棚が見つかりません' });
  res.set('Cache-Control', 'no-store'); // 正本の編集を即反映させる
  res.json(d);
});

// 期日付き設計チケットの一覧。ガントの読み取り専用レーンが使う。
// 読むのは git 正本 (shelvesDir) のみ — Map 上の未コミット編集 (localStorage) は出ない
app.get('/api/shelf-deadlines', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(config.map.shelvesDir).filter((f) => f.endsWith('.json'));
  } catch {
    return res.json({ deadlines: [] });
  }
  const out = [];
  for (const f of files) {
    const d = readShelfFile(f);
    if (!d) continue;
    for (const t of d.tickets || []) {
      if (!t.due || !/^\d{4}-\d{2}-\d{2}$/.test(t.due)) continue;
      const states = Object.values(t.stages || {});
      const done = states.length > 0 && states.every((v) => v === 'done' || v === 'na');
      out.push({ shelf: d.name || f.slice(0, -5), pj: f.slice(0, -5), key: t.key, title: t.title, due: t.due, done });
    }
  }
  out.sort((a, b) => a.due.localeCompare(b.due));
  res.json({ deadlines: out });
});

// ---- 開発文書 (L1/L2/L3) と本棚の突き合わせ検査 ----
// 開発文書 = document ルート配下 <PJ>/L1_機能説明.md / L2_要件.md / L3_詳細.md。
// 検査するのは「L2 のチケット参照 (#XX-n) と本棚チケットの突き合わせ」のみ。
// 文面の正しさは as-built レビューの責務 (自動生成・自動修正はしない)。

const DOC_LAYERS = ['L1_機能説明.md', 'L2_要件.md', 'L3_詳細.md'];

// 1 PJ ぶんの検査本体。単体 (?pj=) と一括 (pj なし) の両方から呼び、判定をずらさない
function checkDocs(pj) {
  const docDir = path.join(config.document.root, pj);
  if (!fs.existsSync(docDir)) return { status: 'no-docs', findings: [], refs: 0 };
  const findings = [];
  for (const f of DOC_LAYERS) {
    if (!fs.existsSync(path.join(docDir, f))) findings.push(`層ファイルがありません: ${pj}/${f}`);
  }
  // L2 の参照 (#MS-1 形式) を抽出
  let refs = new Set();
  const l2Path = path.join(docDir, 'L2_要件.md');
  if (fs.existsSync(l2Path)) {
    const text = fs.readFileSync(l2Path, 'utf8');
    refs = new Set([...text.matchAll(/#([A-Z]+-\d+)/g)].map((m) => m[1]));
  }
  // 本棚のチケット key と両方向で突き合わせ
  const shelf = readShelfFile(pj + '.json');
  if (!shelf) {
    findings.push(`本棚が読めません: ${pj}.json (差集合の検査は行っていません)`);
  } else {
    const keys = new Set((shelf.tickets || []).map((t) => t.key));
    for (const k of keys) if (!refs.has(k)) findings.push(`本棚チケット #${k} が L2_要件.md に現れません`);
    for (const r of refs) if (!keys.has(r)) findings.push(`L2_要件.md の参照 #${r} が本棚にありません`);
  }
  return { status: findings.length === 0 ? 'ok' : 'ng', findings, refs: refs.size };
}

const DOC_CHECK_NOTE = '検査は参照の突き合わせのみ。文面の正しさはレビューで見る';

app.get('/api/doc-map-check', (req, res) => {
  const pj = String(req.query.pj || '');
  // pj なし = 全 PJ 一括。本棚を持つ PJ を列挙し、文書の無いものは no-docs として区別する
  if (!pj) {
    let files = [];
    try {
      files = fs.readdirSync(config.map.shelvesDir).filter((f) => f.endsWith('.json'));
    } catch {
      return res.json({ ok: true, projects: [], note: DOC_CHECK_NOTE });
    }
    const projects = [];
    for (const f of files) {
      if (!readShelfFile(f)) continue;
      const id = f.slice(0, -5);
      const r = checkDocs(id);
      projects.push({ pj: id, status: r.status, refs: r.refs, findings: r.findings });
    }
    return res.json({ ok: projects.every((p) => p.status !== 'ng'), projects, note: DOC_CHECK_NOTE });
  }
  if (!/^[\w.-]+$/.test(pj) || pj.includes('..')) return res.status(400).json({ error: 'pj が不正です' });
  const r = checkDocs(pj);
  if (r.status === 'no-docs') {
    return res.status(404).json({
      error: `開発文書がありません: ${path.join(config.document.root, pj)}`,
      hint: `POST /api/doc-scaffold?pj=${pj} で雛形 (${DOC_LAYERS.join(' / ')}) を作れます`,
    });
  }
  res.json({ ok: r.status === 'ok', findings: r.findings, checked: { refs: r.refs, note: DOC_CHECK_NOTE } });
});

// 開発文書の雛形生成。無い層ファイルだけ作り、既存には一切触れない (何度呼んでも安全)
app.post('/api/doc-scaffold', (req, res) => {
  const pj = String(req.query.pj || '');
  if (!/^[\w.-]+$/.test(pj) || pj.includes('..')) return res.status(400).json({ error: 'pj が不正です' });
  const docDir = path.join(config.document.root, pj);
  const templates = {
    'L1_機能説明.md': `# ${pj} — L1 機能説明

> この文書は ${pj} の「今」を書く（履歴ではなく常に現在形。更新は開発標準の as-built 工程）。
> 層: **L1 = おおまかな機能説明**（この文書） / L2 = 要件ベース / L3 = 詳細説明

## ${pj} とは

（何ができるアプリかを 2〜3 行で）

## できること

- （利用者から見える機能を箇条書きで）
`,
    'L2_要件.md': `# ${pj} — L2 要件

> 層: L1 = おおまかな機能説明 / **L2 = 要件ベース**（この文書） / L3 = 詳細説明
> 各要件には対応する本棚チケット（#XX-n）を必ず書く。
> 参照のズレは \`GET /api/doc-map-check?pj=${pj}\` が機械検査する。

## 要件一覧

| 要件 | 実現のかたち・現状 | チケット |
|---|---|---|
| （なぜ必要かが分かる書き方で） | （どう実現したか・進行中か） | #XX-1 |
`,
    'L3_詳細.md': `# ${pj} — L3 詳細

> 層: L1 = おおまかな機能説明 / L2 = 要件ベース / **L3 = 詳細説明**（この文書）
> クラス・関数レベルの正本は本棚の図。二重管理しない。

## 構成の要点

（構成・API・データ・決めごと・復旧手順など）

## 開発の入口

- 設計・チケット: Master の Map → 本棚 / 計画: ガント（PJ: ${pj}）
- この文書の検査: \`GET http://localhost:3945/api/doc-map-check?pj=${pj}\`
`,
  };
  fs.mkdirSync(docDir, { recursive: true });
  const created = [];
  const skipped = [];
  for (const [name, body] of Object.entries(templates)) {
    const p = path.join(docDir, name);
    if (fs.existsSync(p)) {
      skipped.push(name);
    } else {
      fs.writeFileSync(p, body, 'utf8');
      created.push(name);
    }
  }
  res.json({ ok: true, dir: docDir, created, skipped });
});

// ---- document (docment) 子プロセス ----

let docChild = null;

async function portInUse(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    await fetch(`http://localhost:${port}/`, { signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

async function startDocument() {
  if (!fs.existsSync(config.document.serverJs)) {
    console.warn(`document サーバーが見つからないので起動しません: ${config.document.serverJs}`);
    return;
  }
  // 利用者が単体でも起動している場合があるので、既に動いていればそれをそのまま使う
  if (await portInUse(config.document.port)) {
    console.log(`document: port ${config.document.port} は既に稼働中のためそれを使います`);
    return;
  }
  docChild = spawn(process.execPath, [config.document.serverJs, config.document.root], {
    env: { ...process.env, PORT: String(config.document.port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  docChild.on('exit', (code) => {
    console.log(`document: 子プロセスが終了しました (code=${code})`);
    docChild = null;
  });
}

function stopDocument() {
  if (docChild) {
    docChild.kill();
    docChild = null;
  }
}

// ---- JSON ストア共通ヘルパ (schedule.json / plan.json) ----

// key: データを入れる配列のキー (items / tasks)。壊れたファイルは空扱いで上書きすると
// 全データを失うため、必ず .broken-<時刻> へ退避してから空で始める
function jsonStore(file, key) {
  return {
    read() {
      if (!fs.existsSync(file)) return { [key]: [] };
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(data[key])) throw new Error(`${key} が配列ではない`);
        return data;
      } catch (e) {
        const backup = file + '.broken-' + new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(file, backup);
        console.warn(`${path.basename(file)} が壊れていたため退避しました: ${backup} (${e.message})`);
        return { [key]: [] };
      }
    },
    // 書き込み途中のクラッシュでファイルが壊れないよう、一時ファイル経由で置き換える
    write(data) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    },
  };
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---- スケジュール API ----

const scheduleStore = jsonStore(SCHEDULE_FILE, 'items');
const readSchedule = () => scheduleStore.read();
const writeSchedule = (d) => scheduleStore.write(d);

app.get('/api/schedule', (req, res) => {
  res.json(readSchedule());
});

app.post('/api/schedule', (req, res) => {
  const { date, title, time, memo } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日付が不正です' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'タイトルが空です' });
  const data = readSchedule();
  const item = {
    id: newId(),
    date,
    time: (time || '').trim(),
    title: title.trim(),
    memo: (memo || '').trim(),
  };
  data.items.push(item);
  writeSchedule(data);
  res.json({ ok: true, item });
});

app.put('/api/schedule/:id', (req, res) => {
  const data = readSchedule();
  const item = data.items.find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '見つかりません' });
  const { date, title, time, memo } = req.body || {};
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日付が不正です' });
    item.date = date;
  }
  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: 'タイトルが空です' });
    item.title = title.trim();
  }
  if (time !== undefined) item.time = time.trim();
  if (memo !== undefined) item.memo = memo.trim();
  writeSchedule(data);
  res.json({ ok: true, item });
});

app.delete('/api/schedule/:id', (req, res) => {
  const data = readSchedule();
  const before = data.items.length;
  data.items = data.items.filter((x) => x.id !== req.params.id);
  if (data.items.length === before) return res.status(404).json({ error: '見つかりません' });
  writeSchedule(data);
  res.json({ ok: true });
});

// ---- 開発計画 (ガント) API ----

const PLAN_FILE = path.join(DATA_DIR, 'plan.json');
const planStore = jsonStore(PLAN_FILE, 'tasks');
const ASSIGNEES = ['human', 'ai', 'both'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// 妥当なら null、駄目なら理由を返す
function validateTask(t) {
  if (!t.title || !t.title.trim()) return 'タイトルが空です';
  if (!ASSIGNEES.includes(t.assignee)) return '担当は human / ai / both のいずれかです';
  if (!isDate(t.start) || !isDate(t.end)) return '日付が不正です';
  if (t.start > t.end) return '開始日が終了日より後です';
  // pj は本棚のファイル名 id と同じ語彙 (英数-_.)。空 = PJ なし
  if (t.pj && !/^[\w.-]{1,40}$/.test(t.pj)) return 'pj が不正です (英数と -_. のみ)';
  return null;
}

app.get('/api/plan', (req, res) => {
  res.json(planStore.read());
});

app.post('/api/plan', (req, res) => {
  const { title, assignee, start, end, memo, done, pj } = req.body || {};
  const task = {
    id: newId(),
    title: (title || '').trim(),
    assignee,
    start,
    end,
    done: !!done,
    memo: (memo || '').trim(),
    pj: (pj || '').trim(),
  };
  const err = validateTask(task);
  if (err) return res.status(400).json({ error: err });
  const data = planStore.read();
  data.tasks.push(task);
  planStore.write(data);
  res.json({ ok: true, task });
});

app.put('/api/plan/:id', (req, res) => {
  const data = planStore.read();
  const task = data.tasks.find((x) => x.id === req.params.id);
  if (!task) return res.status(404).json({ error: '見つかりません' });
  const { title, assignee, start, end, memo, done, pj } = req.body || {};
  const next = {
    ...task,
    ...(title !== undefined && { title: title.trim() }),
    ...(assignee !== undefined && { assignee }),
    ...(start !== undefined && { start }),
    ...(end !== undefined && { end }),
    ...(memo !== undefined && { memo: memo.trim() }),
    ...(done !== undefined && { done: !!done }),
    ...(pj !== undefined && { pj: pj.trim() }),
  };
  const err = validateTask(next);
  if (err) return res.status(400).json({ error: err });
  Object.assign(task, next);
  planStore.write(data);
  res.json({ ok: true, task });
});

app.delete('/api/plan/:id', (req, res) => {
  const data = planStore.read();
  const before = data.tasks.length;
  data.tasks = data.tasks.filter((x) => x.id !== req.params.id);
  if (data.tasks.length === before) return res.status(404).json({ error: '見つかりません' });
  planStore.write(data);
  res.json({ ok: true });
});


// 非機能要件の集計 (MS-18)。全本棚の 懸念×状態・試験結果・期日超過・文書検査を PJ ごとに返す。
// 読めない本棚はスキップせず status: broken で出す (黙って消すと赤が見えなくなる)
app.get('/api/nfr', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(config.map.shelvesDir).filter((f) => f.endsWith('.json'));
  } catch {
    return res.json({ projects: [] });
  }
  const today = (() => {
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  })();
  const CATS = ['availability', 'reliability', 'performance', 'security', 'operability'];
  const projects = [];
  for (const f of files) {
    const id = f.slice(0, -5);
    const d = readShelfFile(f);
    if (!d) {
      projects.push({ pj: id, name: id, status: 'broken' });
      continue;
    }
    const concerns = { open: [], covered: 0, dismissed: 0, byCat: {} };
    for (const c of CATS) concerns.byCat[c] = { open: 0, covered: 0, dismissed: 0 };
    for (const c of d.concerns || []) {
      if (c.draft) continue;
      const cat = concerns.byCat[c.category] || (concerns.byCat[c.category] = { open: 0, covered: 0, dismissed: 0 });
      if (c.status === 'open') {
        concerns.open.push({ title: c.title, category: c.category });
        cat.open++;
      } else if (c.status === 'covered') { concerns.covered++; cat.covered++; }
      else { concerns.dismissed++; cat.dismissed++; }
    }
    const tests = { pass: 0, fail: [], none: 0, blocked: 0 };
    for (const t of d.testItems || []) {
      if (t.draft) continue;
      if (t.result === 'pass') tests.pass++;
      else if (t.result === 'fail') tests.fail.push(t.title);
      else if (t.result === 'blocked') tests.blocked++;
      else tests.none++;
    }
    const overdue = [];
    for (const t of d.tickets || []) {
      const st = Object.values(t.stages || {});
      const done = st.length > 0 && st.every((v) => v === 'done' || v === 'na');
      if (t.due && !done && t.due < today) overdue.push({ key: t.key, title: t.title, due: t.due });
    }
    const doc = checkDocs(id);
    const totalConcerns = concerns.open.length + concerns.covered + concerns.dismissed;
    const ok = concerns.open.length === 0 && tests.fail.length === 0 && doc.status !== 'ng';
    projects.push({
      pj: id, name: d.name || id,
      status: totalConcerns === 0 && tests.pass + tests.none + tests.blocked === 0 ? 'unexamined' : (ok ? 'ok' : 'ng'),
      concerns, tests, overdue, docs: doc.status,
    });
  }
  res.json({ projects, note: '本棚 (正本) の集計。書いていない懸念は見えない — 洗い出しは R ビューの責務' });
});

// ---- SeqShelf 自動バックアップ ----
// 正本は SeqShelf 側の localStorage。ここはその保険 (latest + 日次 14 世代)

const BACKUP_DIR = path.join(DATA_DIR, 'backups', 'seqshelf');
const BACKUP_KEEP_DAYS = 14;

app.post('/api/seqshelf-backup', (req, res) => {
  const b = req.body;
  if (!b || b.kind !== 'seqshelf.backup' || (!b.current && !b.library)) {
    return res.status(400).json({ error: 'バックアップ形式ではありません' });
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const json = JSON.stringify(b);
  // 書き込み途中のクラッシュで latest が壊れないよう tmp+rename
  const writeTo = (file) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, file);
  };
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const daily = `seqshelf-${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.json`;
  writeTo(path.join(BACKUP_DIR, 'latest.json'));
  writeTo(path.join(BACKUP_DIR, daily));
  // 日次のローテーション (ファイル名の日付順で新しい 14 件だけ残す)
  const dailies = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^seqshelf-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  for (const f of dailies.slice(BACKUP_KEEP_DAYS)) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
  res.json({ ok: true });
});

// 最新バックアップのダウンロード。SeqShelf の「📦 復元」にそのまま読ませる
app.get('/api/seqshelf-backup', (req, res) => {
  const latest = path.join(BACKUP_DIR, 'latest.json');
  if (!fs.existsSync(latest)) return res.status(404).json({ error: 'バックアップはまだありません' });
  res.download(latest, 'seqshelf-backup-latest.json');
});

// ---- 相談メモ (S-47) ----
// 正本 (shelvesDir の *.json) と端末の最新バックアップ (backups/seqshelf/latest.json の current) の notes を合わせ、
// open の物を返す。AI が作業の入口で /api/plan と一緒に見る。同じ id は端末 (新しい) を優先。
app.get('/api/consults', (req, res) => {
  const errors = [];
  const shelves = new Map(); // name → { source, shelf }
  let files = [];
  try {
    files = fs.readdirSync(config.map.shelvesDir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    errors.push(`正本が読めない: ${config.map.shelvesDir} (${e.message})`);
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(config.map.shelvesDir, f), 'utf8'));
      shelves.set(d.name || f, { source: '正本', shelf: d });
    } catch (e) {
      errors.push(`${f}: ${e.message}`);
    }
  }
  const latest = path.join(BACKUP_DIR, 'latest.json');
  if (fs.existsSync(latest)) {
    try {
      const b = JSON.parse(fs.readFileSync(latest, 'utf8'));
      const cur = b.current;
      if (cur && cur.name) {
        const base = shelves.get(cur.name);
        if (base) {
          const merged = new Map((base.shelf.notes || []).map((n) => [n.id, n]));
          for (const n of cur.notes || []) merged.set(n.id, n); // 端末を優先
          base.shelf = { ...base.shelf, notes: [...merged.values()] };
          base.source = '正本 + 端末';
        } else {
          shelves.set(cur.name, { source: '端末', shelf: cur });
        }
      }
    } catch (e) {
      errors.push(`latest.json: ${e.message}`);
    }
  }
  const pathOf = (s, n) => {
    const phases = s.phases || [], screens = s.screens || [], classes = s.classes || [];
    const ph = (id) => (phases.find((p) => p.id === id) || {}).name;
    const sc = (id) => { const x = screens.find((y) => y.id === id); return x ? [ph(x.phaseId), x.name].filter(Boolean).join(' › ') : undefined; };
    if (n.targetKind === 'phase') return ph(n.targetId) || `(消えた要素) ${n.targetId}`;
    if (n.targetKind === 'screen') return sc(n.targetId) || `(消えた要素) ${n.targetId}`;
    if (n.targetKind === 'diagram') { const d = (s.diagrams || []).find((x) => x.id === n.targetId); return d ? `図 ${d.title}` : `(消えた要素) ${n.targetId}`; }
    const c = classes.find((x) => x.id === n.targetId);
    if (!c) return `(消えた要素) ${n.targetId}`;
    const base = [sc(c.screenId) || '共通', c.name].join(' › ');
    if (n.targetKind === 'member') { const m = (c.members || []).find((x) => x.id === n.memberId); return `${base}.${m ? m.name : `(消えた関数) ${n.memberId}`}`; }
    return base;
  };
  const consults = [];
  for (const [name, { source, shelf }] of shelves) {
    for (const n of shelf.notes || []) {
      if (n.status !== 'open') continue;
      consults.push({ shelf: name, source, id: n.id, path: pathOf(shelf, n), text: n.text, by: n.by, createdAt: n.createdAt, targetKind: n.targetKind, targetId: n.targetId, memberId: n.memberId });
    }
  }
  consults.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.set('Cache-Control', 'no-store');
  res.json({ consults, errors });
});

// ---- シェル用 ----

app.get('/api/config', (req, res) => {
  res.json({ documentPort: config.document.port });
});

// 動いているコードと起動時刻 (MS-19)。画面の右上に出し、起動スクリプトが入れ替えの判断に使う
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ app: 'master', version: PKG.version, builtAt: BUILD.builtAt || null, bundled: !!BUILD.builtAt, signature: CODE_SIGNATURE, startedAt: STARTED_AT, pid: process.pid });
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});

// ---- 起動・終了 ----

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopDocument();
    process.exit(0);
  });
}
process.on('exit', stopDocument);

app.listen(PORT, () => {
  console.log(`master: http://localhost:${PORT}`);
  startDocument();
});
