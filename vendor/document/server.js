const express = require('express');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const HtmlDiff = require('htmldiff-js').default;

const ROOT = path.resolve(process.argv[2] || process.cwd());
const META_DIR = path.join(ROOT, '.mdpreview');
const VERSIONS_DIR = path.join(META_DIR, 'versions');
const PORT = process.env.PORT || 3939;
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.mdpreview']);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// MD内の相対パス画像(assets/xxx.svg等)をプレビューで表示できるように対象ディレクトリも配信する
// 図の上書き編集を即座に反映させるためキャッシュはさせない
app.use(express.static(ROOT, { etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

// ---- helpers ----

function safeResolve(rel) {
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    const err = new Error('パス指定が不正です');
    err.status = 400;
    throw err;
  }
  return abs;
}

function listMarkdownFiles(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listMarkdownFiles(path.join(dir, entry.name), base));
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      out.push(path.relative(base, path.join(dir, entry.name)).replace(/\\/g, '/'));
    }
  }
  return out;
}

// バージョン保管場所: .mdpreview/versions/<ファイル相対パス>/<タイムスタンプ>__<ラベル>.md
function versionDirFor(rel) {
  return path.join(VERSIONS_DIR, rel.replace(/\\/g, '/'));
}

function sanitizeLabel(label) {
  return (label || '').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60);
}

function renderMarkdown(md) {
  return marked.parse(md, { gfm: true, breaks: false });
}

// 改行の増減など空白だけの変更を差分として扱わないため、
// <pre> ブロック以外の空白の連続を1つに正規化してから比較する
function normalizeHtmlWhitespace(html) {
  const parts = html.split(/(<pre[\s\S]*?<\/pre>)/gi);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s+/g, ' ')))
    .join('');
}

// ---- API ----

app.get('/api/files', (req, res) => {
  res.json({ root: ROOT, files: listMarkdownFiles(ROOT, ROOT).sort() });
});

// ファイル名・本文の全文検索
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = [];
  for (const f of listMarkdownFiles(ROOT, ROOT).sort()) {
    const hits = [];
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (hits.length < 5 && line.toLowerCase().includes(q)) {
        hits.push({ line: i + 1, text: line.trim().slice(0, 80) });
      }
    });
    if (!hits.length && f.toLowerCase().includes(q)) hits.push({ line: 0, text: '(ファイル名が一致)' });
    if (hits.length) results.push({ file: f, hits });
    if (results.length >= 30) break;
  }
  res.json({ results });
});

app.get('/api/file', (req, res) => {
  const abs = safeResolve(req.query.path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'ファイルがありません' });
  res.json({ content: fs.readFileSync(abs, 'utf8'), mtime: fs.statSync(abs).mtimeMs });
});

app.post('/api/file', (req, res) => {
  const { path: rel, content, baseMtime, force } = req.body;
  const abs = safeResolve(rel);
  // 開いた時点より後に別の場所(他タブ・外部エディタ)で変更されていたら、黙って上書きせず409を返す
  if (!force && baseMtime !== undefined && fs.existsSync(abs)) {
    const cur = fs.statSync(abs).mtimeMs;
    if (Math.abs(cur - baseMtime) > 0.5) {
      return res.status(409).json({ error: 'ファイルが別の場所で変更されています', mtime: cur });
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  res.json({ ok: true, mtime: fs.statSync(abs).mtimeMs });
});

// ファイル名の変更（バージョン保管フォルダも一緒に移動する）
app.post('/api/rename', (req, res) => {
  const { from, to } = req.body;
  const a = safeResolve(from);
  const b = safeResolve(to);
  if (!fs.existsSync(a)) return res.status(404).json({ error: 'ファイルがありません' });
  if (fs.existsSync(b)) return res.status(400).json({ error: '同名のファイルが既にあります' });
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
  const va = versionDirFor(from);
  const vb = versionDirFor(to);
  if (fs.existsSync(va)) {
    fs.mkdirSync(path.dirname(vb), { recursive: true });
    fs.renameSync(va, vb);
  }
  res.json({ ok: true });
});

// ファイルの削除（バージョン保管フォルダは復元用に残す）
app.delete('/api/file', (req, res) => {
  const abs = safeResolve(req.query.path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'ファイルがありません' });
  if (!fs.statSync(abs).isFile()) return res.status(400).json({ error: 'ファイル以外は削除できません' });
  fs.rmSync(abs);
  res.json({ ok: true });
});

// 明示的なバージョン保存（現在のファイル内容をスナップショット）
app.post('/api/version', (req, res) => {
  const { path: rel, label } = req.body;
  const abs = safeResolve(rel);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'ファイルがありません' });
  const dir = versionDirFor(rel);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}__${sanitizeLabel(label) || 'no-label'}.md`;
  fs.copyFileSync(abs, path.join(dir, name));
  res.json({ ok: true, id: name });
});

// 手元の別mdファイルの内容を「比較用バージョン」として取り込む
app.post('/api/version-import', (req, res) => {
  const { path: rel, label, content } = req.body;
  const abs = safeResolve(rel);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '対象ファイルがありません' });
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: '取り込む内容が空です' });
  const dir = versionDirFor(rel);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}__${sanitizeLabel(label) || 'import'}.md`;
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  res.json({ ok: true, id: name });
});

app.get('/api/versions', (req, res) => {
  const dir = versionDirFor(safeResolve(req.query.path) && req.query.path);
  if (!fs.existsSync(dir)) return res.json({ versions: [] });
  const versions = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((f) => {
      const [stamp, labelPart] = f.replace(/\.md$/, '').split('__');
      return { id: f, stamp, label: labelPart === 'no-label' ? '' : labelPart };
    });
  res.json({ versions });
});

app.get('/api/version-content', (req, res) => {
  const dir = versionDirFor(safeResolve(req.query.path) && req.query.path);
  const file = path.join(dir, path.basename(req.query.id));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'バージョンがありません' });
  res.json({ content: fs.readFileSync(file, 'utf8') });
});

// 指定バージョンと現在の内容をそれぞれHTMLに描画して差分を返す
app.get('/api/diff', (req, res) => {
  const abs = safeResolve(req.query.path);
  const dir = versionDirFor(req.query.path);
  const verFile = path.join(dir, path.basename(req.query.id));
  if (!fs.existsSync(abs) || !fs.existsSync(verFile)) {
    return res.status(404).json({ error: 'ファイルまたはバージョンがありません' });
  }
  const oldHtml = normalizeHtmlWhitespace(renderMarkdown(fs.readFileSync(verFile, 'utf8')));
  const newHtml = normalizeHtmlWhitespace(renderMarkdown(fs.readFileSync(abs, 'utf8')));
  res.json({ html: HtmlDiff.execute(oldHtml, newHtml) });
});

// draw.io等で描いた図(SVG/PNGのdata URI)を assets/ に保存してパスを返す
// path指定があれば既存ファイルを上書き(=図の再編集)
app.post('/api/asset', (req, res) => {
  const { name, dataUri, path: relPath } = req.body;
  const m = /^data:image\/(svg\+xml|png|jpeg|gif|webp);base64,(.+)$/.exec(dataUri || '');
  if (!m) return res.status(400).json({ error: '画像データが不正です' });
  const ext = { 'svg+xml': 'svg', png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' }[m[1]];
  let rel;
  if (relPath) {
    rel = relPath.replace(/\\/g, '/');
    if (!rel.startsWith('assets/')) return res.status(400).json({ error: '上書き先はassets/配下のみ指定できます' });
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // スペース等はMarkdownの画像リンクを壊すため除去する
    const base = (sanitizeLabel(name) || 'diagram').replace(/[\s()\[\]]+/g, '_');
    rel = `assets/${stamp}_${base}.${ext}`;
  }
  const abs = safeResolve(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(m[2], 'base64'));
  res.json({ ok: true, path: rel });
});

// 改善要望・メモを feedback.md に日時付きで追記する
app.post('/api/feedback', (req, res) => {
  const { category, text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: '内容が空です' });
  const file = path.join(ROOT, 'feedback.md');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  let entry = '';
  if (!fs.existsSync(file)) {
    entry += '# 改善要望・メモ\n\nこのファイルにはアプリの「💬 改善要望」ボタンで書いた内容が記録されます。\n';
  }
  entry += `\n---\n\n## ${stamp}　${category || '💡 改善要望'}\n\n${text.trim()}\n`;
  fs.appendFileSync(file, entry, 'utf8');
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`md-preview: http://localhost:${PORT}  (対象ディレクトリ: ${ROOT})`);
});
