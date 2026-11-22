// Accès aux données : SQLite (un simple fichier) + dossier d'envois (photos/vidéos) à côté.
// Base SQLite : on utilise celle intégrée à Node (22.13 ou plus), sans module natif à compiler.
// Si elle n'est pas disponible (vieux Node), on essaie le module better-sqlite3 s'il est installé.
const ew = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : ew.call(process, w, ...a));
function openDb(file) {
  let DatabaseSync = null;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { /* Node trop ancien */ }
  if (DatabaseSync) {
    const d = new DatabaseSync(file), cache = new Map();
    const st = sql => { let s = cache.get(sql); if (!s) { s = d.prepare(sql); cache.set(sql, s); } return s; };
    return {
      pragma: s => d.exec('PRAGMA ' + s), exec: s => d.exec(s),
      prepare: sql => { const s = st(sql); return { get: (...a) => s.get(...a), all: (...a) => s.all(...a),
        run: (...a) => { const r = s.run(...a); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; } }; },
      transaction: fn => (...a) => { d.exec('BEGIN'); try { const r = fn(...a); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; } },
    };
  }
  try { const B = require('better-sqlite3'); return new B(file); }
  catch (e) { console.error('Erreur : installez Node.js 22.13 ou plus (https://nodejs.org), puis relancez.'); process.exit(1); }
}
const fs = require('fs');
const path = require('path');

const dbFile = process.env.DB_PATH || path.join(__dirname, 'data', 'site.db');
const uploadDir = path.join(path.dirname(dbFile), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const db = openDb(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'reader', banned INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, icon TEXT);
CREATE TABLE IF NOT EXISTS guides(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, intro TEXT, steps TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'approved', difficulty TEXT DEFAULT 'Moyen',
  duration INTEGER DEFAULT 0, image TEXT, views INTEGER DEFAULT 0, reject_note TEXT, tools TEXT, tags TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS steps(id INTEGER PRIMARY KEY AUTOINCREMENT, guide_id INTEGER NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  pos INTEGER DEFAULT 0, title TEXT, body TEXT);
CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY AUTOINCREMENT, step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  file TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, size INTEGER, url TEXT);
CREATE TABLE IF NOT EXISTS diags(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, intro TEXT, tree TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'approved', views INTEGER DEFAULT 0, reject_note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY AUTOINCREMENT, guide_id INTEGER REFERENCES guides(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
// Anciennes versions du site : on ajoute les colonnes manquantes
for (const a of [
  'ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL',
  'ALTER TABLE categories ADD COLUMN icon TEXT',
  "ALTER TABLE guides ADD COLUMN status TEXT DEFAULT 'approved'",
  "ALTER TABLE guides ADD COLUMN difficulty TEXT DEFAULT 'Moyen'",
  'ALTER TABLE guides ADD COLUMN duration INTEGER DEFAULT 0',
  'ALTER TABLE guides ADD COLUMN image TEXT',
  'ALTER TABLE guides ADD COLUMN views INTEGER DEFAULT 0',
  'ALTER TABLE guides ADD COLUMN reject_note TEXT',
  'ALTER TABLE guides ADD COLUMN tools TEXT',
  'ALTER TABLE media ADD COLUMN name TEXT',
  'ALTER TABLE media ADD COLUMN size INTEGER',
  'ALTER TABLE media ADD COLUMN url TEXT',
  "ALTER TABLE guides ADD COLUMN tags TEXT DEFAULT ''"]) { try { db.exec(a); } catch (e) { /* déjà présente */ } }

const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const { slug } = require('./diag');
const marks = a => a.map(() => '?').join(',');
const hasUsers = () => !!one('SELECT 1 FROM users LIMIT 1');
const coverFile = img => (img && img.startsWith('/uploads/')) ? path.basename(img) : null;

// Anciens guides : le texte "une étape par ligne" devient de vraies étapes
for (const g of all(`SELECT id,steps FROM guides WHERE steps IS NOT NULL AND steps<>''`)) {
  if (!one('SELECT 1 FROM steps WHERE guide_id=?', g.id))
    g.steps.split('\n').filter(x => x.trim()).forEach((t, i) => run('INSERT INTO steps(guide_id,pos,title,body) VALUES(?,?,?,?)', g.id, i, '', t.trim()));
  run(`UPDATE guides SET steps='' WHERE id=?`, g.id);
}

// ---------- Catégories ----------
const catRows = () => all('SELECT * FROM categories ORDER BY name');
const catList = () => {
  const rows = catRows(), out = [];
  const walk = (pid, prefix, d) => rows.filter(c => (c.parent_id || null) === pid).forEach(c => {
    out.push({ ...c, label: prefix + c.name, depth: d }); walk(c.id, prefix + c.name + ' › ', d + 1); });
  walk(null, '', 0); return out;
};
const descendants = id => {
  const rows = all('SELECT id,parent_id FROM categories'), ids = [+id];
  for (let i = 0; i < ids.length; i++) rows.forEach(r => { if (r.parent_id === ids[i] && !ids.includes(r.id)) ids.push(r.id); });
  return ids;
};
const countIn = id => { const ids = descendants(id); return one(`SELECT COUNT(*) n FROM guides WHERE status='approved' AND category_id IN (${marks(ids)})`, ...ids).n; };
const crumbs = id => {
  const rows = catRows(), out = []; let c = rows.find(r => r.id === +id);
  while (c && out.length < 10) { out.unshift(c); const p = c.parent_id; c = rows.find(r => r.id === p); }
  return out;
};

// ---------- Guides ----------
const GUIDE_SQL = `SELECT g.*, c.name AS cat, c.icon AS cat_icon, u.name AS author,
  (SELECT m.file FROM media m JOIN steps s ON s.id=m.step_id WHERE s.guide_id=g.id AND m.kind='image' ORDER BY s.pos, m.id LIMIT 1) AS thumb
  FROM guides g LEFT JOIN categories c ON c.id=g.category_id JOIN users u ON u.id=g.author_id`;
const getGuide = id => one(GUIDE_SQL + ' WHERE g.id=?', id);
function listGuides({ q, tag, tags, catIds, authorId, status = 'approved', sort = 'recent', limit = 60 } = {}) {
  const w = [], p = [];
  if (status) { w.push('g.status=?'); p.push(status); }
  if (q) {
    const sq = slug(q), parts = [];
    if (q[0] !== '#') { parts.push(`g.title LIKE '%'||?||'%'`, `g.intro LIKE '%'||?||'%'`); p.push(q, q); }
    if (sq) { parts.push(`g.tags LIKE '%'||?||'%'`); p.push(sq); }
    w.push(parts.length ? '(' + parts.join(' OR ') + ')' : '0');
  }
  if (tag) { w.push(`g.tags LIKE '%,'||?||',%'`); p.push(slug(tag)); }
  if (tags && tags.length) { w.push('(' + tags.map(() => `g.tags LIKE '%,'||?||',%'`).join(' OR ') + ')'); p.push(...tags.map(slug)); }
  if (catIds) { w.push(`g.category_id IN (${marks(catIds)})`); p.push(...catIds); }
  if (authorId) { w.push('g.author_id=?'); p.push(authorId); }
  const order = sort === 'popular' ? 'g.views DESC, g.id DESC' : 'g.id DESC';
  return all(`${GUIDE_SQL} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${order} LIMIT ${Math.max(1, +limit | 0)}`, ...p);
}
// Hashtags les plus utilisés par les guides publiés
function popularTags(limit = 24) {
  const n = {};
  all(`SELECT tags FROM guides WHERE status='approved' AND tags IS NOT NULL AND tags<>''`).forEach(r => r.tags.split(',').filter(Boolean).forEach(t => { n[t] = (n[t] || 0) + 1; }));
  return Object.keys(n).map(t => ({ tag: t, n: n[t] })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).slice(0, limit);
}
function getSteps(gid) {
  const steps = all('SELECT * FROM steps WHERE guide_id=? ORDER BY pos,id', gid);
  if (!steps.length) return steps;
  const ids = steps.map(s => s.id);
  const media = all(`SELECT * FROM media WHERE step_id IN (${marks(ids)}) ORDER BY id`, ...ids);
  steps.forEach(s => { s.media = media.filter(m => m.step_id === s.id); });
  return steps;
}
// g : {id?, title, intro, tools, category_id, difficulty, duration, image, author_id?, status}
// steps : [{id|null, title, body, files:[{file, kind}]}]   → retourne {id, removed:[fichiers à effacer du disque]}
function saveGuide(g, steps, delMedia = []) {
  const removed = [];
  const tx = db.transaction(() => {
    let id = g.id;
    if (id) {
      const old = one('SELECT image FROM guides WHERE id=?', id);
      if (old && old.image !== g.image && coverFile(old.image)) removed.push(coverFile(old.image));
      run('UPDATE guides SET title=?,intro=?,tools=?,tags=?,category_id=?,difficulty=?,duration=?,image=?,status=?,reject_note=NULL WHERE id=?',
        g.title, g.intro, g.tools, g.tags || '', g.category_id, g.difficulty, g.duration, g.image, g.status, id);
    } else {
      id = Number(run('INSERT INTO guides(title,intro,tools,tags,category_id,difficulty,duration,image,author_id,status) VALUES(?,?,?,?,?,?,?,?,?,?)',
        g.title, g.intro, g.tools, g.tags || '', g.category_id, g.difficulty, g.duration, g.image, g.author_id, g.status).lastInsertRowid);
    }
    const keep = steps.filter(s => s.id).map(s => s.id);
    for (const o of all('SELECT id FROM steps WHERE guide_id=?', id)) if (!keep.includes(o.id)) {
      all('SELECT file FROM media WHERE step_id=?', o.id).forEach(m => removed.push(m.file));
      run('DELETE FROM steps WHERE id=?', o.id);
    }
    for (const mid of delMedia) {
      const m = one('SELECT m.id,m.file FROM media m JOIN steps s ON s.id=m.step_id WHERE m.id=? AND s.guide_id=?', mid, id);
      if (m) { removed.push(m.file); run('DELETE FROM media WHERE id=?', m.id); }
    }
    steps.forEach((s, i) => {
      const ex = s.id ? one('SELECT id FROM steps WHERE id=? AND guide_id=?', s.id, id) : null;
      let sid;
      if (ex) { sid = ex.id; run('UPDATE steps SET pos=?,title=?,body=? WHERE id=?', i, s.title, s.body, sid); }
      else sid = Number(run('INSERT INTO steps(guide_id,pos,title,body) VALUES(?,?,?,?)', id, i, s.title, s.body).lastInsertRowid);
      (s.files || []).forEach(f => run('INSERT INTO media(step_id,file,kind,name,size,url) VALUES(?,?,?,?,?,?)', sid, f.file || '', f.kind, f.name || null, f.size || 0, f.url || null));
    });
    return id;
  });
  const id = tx();
  return { id, removed };
}
function deleteGuide(id) {
  const g = one('SELECT image FROM guides WHERE id=?', id);
  if (!g) return [];
  const files = all('SELECT m.file FROM media m JOIN steps s ON s.id=m.step_id WHERE s.guide_id=?', id).map(m => m.file);
  if (coverFile(g.image)) files.push(coverFile(g.image));
  run('DELETE FROM guides WHERE id=?', id);
  return files;
}

module.exports = { db, one, all, run, uploadDir, hasUsers, catRows, catList, descendants, countIn, crumbs,
  listGuides, popularTags, getGuide, getSteps, saveGuide, deleteGuide, coverFile };
