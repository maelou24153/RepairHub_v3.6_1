const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./db');
const Diag = require('./diag');
const { one, all, run } = D;

const app = express();
app.set('view engine', 'ejs');
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' });
  next();
});
// Protection : un POST venant d'un autre site est refusé
app.use((req, res, next) => {
  const o = req.get('origin');
  if (req.method === 'POST' && o) {
    try { if (new URL(o).host !== (req.get('x-forwarded-host') || req.get('host'))) return res.status(403).send('Requête refusée.'); }
    catch (e) { return res.status(403).send('Requête refusée.'); }
  }
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
// /uploads ne sert que les photos et vidéos ; les fichiers joints passent par /download (contrôle d'accès)
app.use('/uploads', (req, res, next) => /\.(jpe?g|png|webp|gif|mp4|webm)$/i.test(req.path) ? next() : res.status(404).send('Introuvable'));
app.use('/uploads', express.static(D.uploadDir, { maxAge: '7d' }));
app.use(cookieSession({
  name: 's', keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  maxAge: 30 * 864e5, sameSite: 'lax', httpOnly: true,
}));

const ROLES = { reader: 'Lecteur', creator: 'Créateur', moderator: 'Modérateur', admin: 'Administrateur' };
const isStaff = u => !!u && ['admin', 'moderator'].includes(u.role);
const WRITERS = ['creator', 'moderator', 'admin'];
const validEmail = e => /^\S+@\S+\.\S+$/.test(e);
const flash = (req, m) => { req.session.msg = m; };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const notFound = (res, text) => res.status(404).render('error', { text });
process.on('unhandledRejection', e => console.error('Erreur non gérée :', e));

// Option : créer l'admin au démarrage (utile sur Render gratuit où les données sont effacées au redémarrage)
if (!D.hasUsers() && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  run('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)', process.env.ADMIN_EMAIL.trim().toLowerCase(),
    process.env.ADMIN_NAME || 'Admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), 'admin');
  console.log('Administrateur créé depuis ADMIN_EMAIL / ADMIN_PASSWORD');
}
// Les 3 outils de diagnostic d'exemple sont ajoutés une seule fois (modifiables ou supprimables ensuite)
function seedDiags() {
  if (one(`SELECT 1 FROM meta WHERE k='diag_seeded'`)) return;
  const a = one(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`);
  if (!a) return;
  Diag.SEEDS.forEach(s => run('INSERT INTO diags(title,intro,tree,author_id,status) VALUES(?,?,?,?,?)', s.title, s.intro, s.tree, a.id, 'approved'));
  run(`INSERT INTO meta(k,v) VALUES('diag_seeded','1')`);
}
seedDiags();
const DIAG_SQL = `SELECT d.*, c.name AS cat, u.name AS author FROM diags d LEFT JOIN categories c ON c.id=d.category_id JOIN users u ON u.id=d.author_id`;
const getDiag = id => one(DIAG_SQL + ' WHERE d.id=?', id);

app.use((req, res, next) => {
  const u = req.session.uid && one('SELECT id,name,role,banned FROM users WHERE id=?', req.session.uid);
  req.user = u && !u.banned ? u : null;
  res.locals.user = req.user;
  res.locals.roles = ROLES;
  res.locals.linkKind = u => { try { const e = extOf(new URL(u).pathname); return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(e) ? 'image' : ['mp4', 'webm'].includes(e) ? 'video' : 'link'; } catch (x) { return 'link'; } };
  res.locals.linkHost = u => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return h.endsWith('archive.org') ? 'archive.org' : h; } catch (x) { return 'lien'; } };
  res.locals.fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round((n || 0) / 1024)) + ' Ko';
  res.locals.pending = isStaff(req.user) ? one(`SELECT COUNT(*) n FROM guides WHERE status='pending'`).n + one(`SELECT COUNT(*) n FROM diags WHERE status='pending'`).n : 0;
  res.locals.msg = req.session.msg; req.session.msg = null;
  next();
});
app.use((req, res, next) => (!D.hasUsers() && req.path !== '/setup') ? res.redirect('/setup') : next());

const need = (...roles) => (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (roles.length && !roles.includes(req.user.role)) return res.status(403).render('error', { text: 'Accès refusé.' });
  next();
};
const hits = new Map();
const limit = (max, ms) => (req, res, next) => {
  const k = req.ip + req.path, now = Date.now(), h = (hits.get(k) || []).filter(t => now - t < ms);
  if (h.length >= max) { flash(req, 'Trop de tentatives, réessayez dans quelques minutes.'); return res.redirect(req.path); }
  h.push(now); hits.set(k, h); next();
};

// ---------- Envoi de photos et vidéos ----------
const TYPES = { 'image/jpeg': ['jpg', 'image'], 'image/png': ['png', 'image'], 'image/webp': ['webp', 'image'],
  'image/gif': ['gif', 'image'], 'video/mp4': ['mp4', 'video'], 'video/webm': ['webm', 'video'] };
const MAX_MB = +process.env.MAX_UPLOAD_MB || 60;
const DOC_EXT = ['pdf', 'zip', '7z', 'txt', 'csv', 'md', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'stl', '3mf', 'step', 'stp', 'dxf'];
const DOC_MAGIC = { pdf: '%PDF', zip: 'PK', docx: 'PK', xlsx: 'PK', pptx: 'PK', odt: 'PK', ods: 'PK', odp: 'PK', '3mf': 'PK', '7z': '7z' };
const isDoc = f => f.fieldname.indexOf('f_') === 0;
const extOf = n => path.extname(n || '').slice(1).toLowerCase();
const up = multer({
  storage: multer.diskStorage({ destination: D.uploadDir,
    filename: (req, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + '.' + (isDoc(f) ? extOf(f.originalname) : TYPES[f.mimetype][0])) }),
  fileFilter: (req, f, cb) => (isDoc(f) ? DOC_EXT.includes(extOf(f.originalname)) : !!TYPES[f.mimetype]) ? cb(null, true)
    : cb(new Error(isDoc(f) ? 'Fichier joint refusé. Formats acceptés : ' + DOC_EXT.join(', ') + '.' : 'Format refusé : utilisez JPG, PNG, WebP, GIF, MP4 ou WebM.')),
  limits: { fileSize: MAX_MB * 1048576, files: 120, fields: 600 },
}).any();
const upload = (req, res, next) => up(req, res, err => {
  if (!err) return next();
  flash(req, err.code === 'LIMIT_FILE_SIZE' ? `Fichier trop lourd (maximum ${MAX_MB} Mo par fichier).` : (err.message || 'Envoi impossible.'));
  res.redirect(req.get('referer') || '/');
});
// Vérifie que le contenu du fichier correspond bien à son type (et pas seulement son nom)
const sniff = f => {
  try {
    const fd = fs.openSync(f.path, 'r'), b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
    if (isDoc(f)) { const m = DOC_MAGIC[extOf(f.filename)]; return !m || b.slice(0, m.length).toString('latin1') === m; }
    const t = f.mimetype;
    if (t === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
    if (t === 'image/png') return b.slice(0, 4).toString('hex') === '89504e47';
    if (t === 'image/gif') return b.slice(0, 3).toString() === 'GIF';
    if (t === 'image/webp') return b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP';
    if (t === 'video/mp4') return b.slice(4, 8).toString() === 'ftyp';
    if (t === 'video/webm') return b.slice(0, 4).toString('hex') === '1a45dfa3';
  } catch (e) { /* illisible */ }
  return false;
};
const cleanName = n => { let s = String(n || 'fichier');
  try { const u = Buffer.from(s, 'latin1').toString('utf8'); if (u.indexOf('\ufffd') < 0) s = u; } catch (e) { /* garde le nom */ }
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120) || 'fichier'; };
// Liens externes : uniquement en https vers archive.org (et les sites listés dans ALLOWED_LINK_HOSTS)
const LINK_HOSTS = ['archive.org'].concat((process.env.ALLOWED_LINK_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const cleanLink = raw => { try { const u = new URL(String(raw || '').trim()); const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || !LINK_HOSTS.some(a => h === a || h.endsWith('.' + a))) return null;
  return u.toString().slice(0, 500); } catch (e) { return null; } };
const linkLabel = u => { try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '').slice(0, 120) || new URL(u).hostname; } catch (e) { return String(u).slice(0, 120); } };
const delFiles = list => (list || []).filter(Boolean).forEach(n => fs.unlink(path.join(D.uploadDir, path.basename(n)), () => {}));

// ---------- Première installation ----------
app.get('/setup', (req, res) => D.hasUsers() ? res.redirect('/') : res.render('setup', { needCode: !!process.env.SETUP_CODE }));
app.post('/setup', limit(15, 36e5), wrap(async (req, res) => {
  if (D.hasUsers()) return res.redirect('/');
  const fail = m => res.status(400).render('setup', { needCode: !!process.env.SETUP_CODE, msg: m });
  const code = (process.env.SETUP_CODE || '').trim();
  if (code && (req.body.code || '').trim() !== code) return fail("Code d'installation incorrect.");
  const email = (req.body.email || '').trim().toLowerCase(), name = (req.body.name || '').trim().slice(0, 40), pw = req.body.password || '';
  if (!validEmail(email) || !name || pw.length < 8) return fail('Email valide, pseudo et mot de passe (8 caractères min.) requis.');
  try {
    const r = run('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)', email, name, await bcrypt.hash(pw, 10), 'admin');
    req.session.uid = Number(r.lastInsertRowid); seedDiags();
    flash(req, 'Administrateur créé. Commencez par ajouter des catégories.');
    res.redirect('/admin');
  } catch (err) { console.error('Erreur /setup :', err); fail('Erreur technique : ' + err.message); }
}));

// ---------- Pages publiques ----------
app.get('/', (req, res) => {
  const s = (req.query.s || '').trim().slice(0, 80);
  const stats = { guides: one(`SELECT COUNT(*) n FROM guides WHERE status='approved'`).n, members: one('SELECT COUNT(*) n FROM users').n, cats: one('SELECT COUNT(*) n FROM categories').n };
  if (s) return res.render('home', { hero: true, s, stats, tops: [], latest: [], popular: [], tags: [], results: D.listGuides({ q: s }) });
  const rows = D.catRows();
  const tops = rows.filter(c => !c.parent_id).map(c => ({ ...c, n: D.countIn(c.id), subs: rows.filter(x => x.parent_id === c.id) }));
  res.render('home', { hero: true, s: '', stats, tops, results: null, tags: D.popularTags(20), latest: D.listGuides({ limit: 8 }), popular: D.listGuides({ sort: 'popular', limit: 4 }) });
});
app.get('/cat/:id', (req, res) => {
  const c = one('SELECT * FROM categories WHERE id=?', req.params.id);
  if (!c) return notFound(res, 'Catégorie introuvable.');
  const sort = req.query.sort === 'popular' ? 'popular' : 'recent';
  res.render('category', { c, sort, crumbs: D.crumbs(c.id),
    subs: D.catRows().filter(x => x.parent_id === c.id).map(x => ({ ...x, n: D.countIn(x.id) })),
    guides: D.listGuides({ catIds: D.descendants(c.id), sort }) });
});
app.get('/guide/:id', (req, res) => {
  const g = D.getGuide(req.params.id), u = req.user;
  if (!g || (g.status !== 'approved' && !isStaff(u) && !(u && u.id === g.author_id))) return notFound(res, 'Guide introuvable.');
  if (g.status === 'approved') run('UPDATE guides SET views=views+1 WHERE id=?', g.id);
  res.render('guide', { g, title: g.title, steps: D.getSteps(g.id), crumbs: g.category_id ? D.crumbs(g.category_id) : [],
    tools: (g.tools || '').split('\n').map(x => x.trim()).filter(Boolean),
    comments: all('SELECT m.*, u.name FROM comments m JOIN users u ON u.id=m.user_id WHERE guide_id=? ORDER BY m.id', g.id) });
});
app.get('/download/:id', (req, res) => {
  const m = one(`SELECT m.file, m.name, g.status, g.author_id FROM media m JOIN steps s ON s.id=m.step_id JOIN guides g ON g.id=s.guide_id WHERE m.id=? AND m.kind='file'`, req.params.id), u = req.user;
  if (!m || (m.status !== 'approved' && !isStaff(u) && !(u && u.id === m.author_id))) return notFound(res, 'Fichier introuvable.');
  res.download(path.join(D.uploadDir, path.basename(m.file)), m.name || m.file);
});
app.get('/tag/:tag', (req, res) => {
  const tag = Diag.slug(req.params.tag);
  if (!tag) return notFound(res, 'Hashtag introuvable.');
  res.render('tag', { title: '#' + tag, tag, guides: D.listGuides({ tag }), tags: D.popularTags(20) });
});

// ---------- Outil de diagnostic de panne ----------
const diagVisible = (d, u) => !!d && (d.status === 'approved' || isStaff(u) || !!(u && u.id === d.author_id));
const diagFields = b => { const c = parseInt(b.category_id);
  return { title: String(b.title || '').trim().slice(0, 150), intro: String(b.intro || '').trim().slice(0, 600), tree: String(b.tree || '').slice(0, 20000),
    category_id: c && one('SELECT 1 FROM categories WHERE id=?', c) ? c : null }; };
function diagSave(req, res, old) {
  const f = diagFields(req.body), tree = Diag.parseTree(f.tree), errors = tree.errors.slice();
  if (!f.title) errors.unshift('Le titre est obligatoire.');
  if (errors.length) return res.status(400).render('diag_form', { title: old ? "Modifier l'outil" : 'Nouvel outil de diagnostic', d: { id: old && old.id, ...f }, cats: D.catList(), errors, warnings: [] });
  let id = old && old.id;
  const status = old ? (isStaff(req.user) ? old.status : 'pending') : (isStaff(req.user) ? 'approved' : 'pending');
  if (id) run('UPDATE diags SET title=?,intro=?,tree=?,category_id=?,status=?,reject_note=NULL WHERE id=?', f.title, f.intro, f.tree, f.category_id, status, id);
  else id = Number(run('INSERT INTO diags(title,intro,tree,category_id,author_id,status) VALUES(?,?,?,?,?,?)', f.title, f.intro, f.tree, f.category_id, req.user.id, status).lastInsertRowid);
  Object.values(tree.nodes).forEach(n => (n.links || []).forEach(l => { if (l.type === 'guide' && !D.getGuide(l.id)) tree.warnings.push(`Le guide n°${l.id} n'existe pas (encore).`); }));
  flash(req, (status === 'pending' ? "Outil envoyé : il sera publié après validation par un modérateur." : 'Outil de diagnostic enregistré.') + (tree.warnings.length ? ' Attention : ' + tree.warnings.join(' ') : ''));
  res.redirect('/diag/' + id);
}
app.get('/diag', (req, res) => res.render('diag_list', { title: 'Diagnostic de panne', diags: all(DIAG_SQL + ` WHERE d.status='approved' ORDER BY d.views DESC, d.id DESC`) }));
app.get('/diag/new', need(...WRITERS), (req, res) => res.render('diag_form', { title: 'Nouvel outil de diagnostic', d: { tree: '' }, cats: D.catList(), errors: [], warnings: [] }));
app.post('/diag/new', need(...WRITERS), (req, res) => diagSave(req, res, null));
const canEditDiag = (req, res, next) => {
  const d = getDiag(req.params.id), u = req.user;
  if (!d) return notFound(res, 'Outil de diagnostic introuvable.');
  if (!u) return res.redirect('/login');
  if (!(isStaff(u) || (u.role === 'creator' && d.author_id === u.id))) return res.status(403).render('error', { text: 'Accès refusé.' });
  req.diag = d; next();
};
app.get('/diag/:id/edit', canEditDiag, (req, res) => res.render('diag_form', { title: "Modifier l'outil", d: req.diag, cats: D.catList(), errors: [], warnings: [] }));
app.post('/diag/:id/edit', canEditDiag, (req, res) => diagSave(req, res, req.diag));
app.post('/diag/:id/delete', need(...WRITERS), (req, res) => {
  const d = getDiag(req.params.id);
  if (d && (isStaff(req.user) || d.author_id === req.user.id)) { run('DELETE FROM diags WHERE id=?', d.id); flash(req, 'Outil supprimé.'); }
  res.redirect('/diag');
});
app.get('/diag/:id', (req, res) => {
  const d = getDiag(req.params.id);
  if (!diagVisible(d, req.user)) return notFound(res, 'Outil de diagnostic introuvable.');
  const tree = Diag.parseTree(d.tree);
  if (!tree.ok) return res.status(500).render('error', { text: 'Cet outil de diagnostic est en cours de réparation.' });
  const w = Diag.walk(tree, req.query.p), result = w.node.kind === 'result';
  if (!req.query.p && d.status === 'approved') run('UPDATE diags SET views=views+1 WHERE id=?', d.id);
  const articles = result ? (w.node.links || []).map(l => { if (l.type !== 'guide') return { kind: 'url', ...l }; const g = D.getGuide(l.id); return g && g.status === 'approved' ? { kind: 'guide', g } : null; }).filter(Boolean) : [];
  const shown = new Set(articles.filter(a => a.kind === 'guide').map(a => a.g.id));
  res.render('diag_run', { title: d.title, d, node: w.node, trail: w.trail, base: w.base, result, invalid: w.invalid, articles,
    guides: (result && w.node.tags.length ? D.listGuides({ tags: w.node.tags, limit: 6 }) : []).filter(g => !shown.has(g.id)) });
});
app.get('/user/:id', (req, res) => {
  const p = one('SELECT id,name,role,created_at FROM users WHERE id=? AND banned=0', req.params.id);
  if (!p) return notFound(res, 'Profil introuvable.');
  res.render('profile', { p, title: p.name, guides: D.listGuides({ authorId: p.id }) });
});

// ---------- Compte ----------
app.get('/register', (req, res) => res.render('register'));
app.post('/register', limit(10, 36e5), wrap(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase(), name = (req.body.name || '').trim().slice(0, 40), pw = req.body.password || '';
  if (!validEmail(email) || !name || pw.length < 8) { flash(req, 'Email valide, pseudo et mot de passe (8 caractères min.) requis.'); return res.redirect('/register'); }
  if (one('SELECT 1 FROM users WHERE email=?', email)) { flash(req, 'Cet email a déjà un compte.'); return res.redirect('/register'); }
  const r = run('INSERT INTO users(email,name,password_hash) VALUES(?,?,?)', email, name, await bcrypt.hash(pw, 10));
  req.session.uid = Number(r.lastInsertRowid); flash(req, 'Compte créé, bienvenue !'); res.redirect('/');
}));
app.get('/login', (req, res) => res.render('login'));
app.post('/login', limit(12, 9e5), wrap(async (req, res) => {
  const u = one('SELECT * FROM users WHERE email=?', (req.body.email || '').trim().toLowerCase());
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) { flash(req, 'Identifiants incorrects.'); return res.redirect('/login'); }
  if (u.banned) { flash(req, 'Ce compte est suspendu.'); return res.redirect('/login'); }
  req.session.uid = u.id; res.redirect('/');
}));
app.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });
app.get('/account', need(), (req, res) => res.render('account', { title: 'Mon compte' }));
app.post('/account', need(), wrap(async (req, res) => {
  const u = one('SELECT password_hash FROM users WHERE id=?', req.user.id), np = req.body.new_password || '';
  if (!(await bcrypt.compare(req.body.old_password || '', u.password_hash))) flash(req, 'Mot de passe actuel incorrect.');
  else if (np.length < 8) flash(req, 'Le nouveau mot de passe doit faire 8 caractères minimum.');
  else { run('UPDATE users SET password_hash=? WHERE id=?', await bcrypt.hash(np, 10), req.user.id); flash(req, 'Mot de passe modifié.'); }
  res.redirect('/account');
}));

// ---------- Commentaires ----------
app.post('/comment/:id/delete', need('moderator', 'admin'), (req, res) => {
  const c = one('SELECT guide_id FROM comments WHERE id=?', req.params.id);
  run('DELETE FROM comments WHERE id=?', req.params.id);
  res.redirect(c ? '/guide/' + c.guide_id : '/');
});
app.post('/guide/:id/comment', need(), (req, res) => {
  const body = (req.body.body || '').trim().slice(0, 2000);
  if (body && one(`SELECT 1 FROM guides WHERE id=? AND status='approved'`, req.params.id)) run('INSERT INTO comments(guide_id,user_id,body) VALUES(?,?,?)', req.params.id, req.user.id, body);
  res.redirect('/guide/' + req.params.id);
});

// ---------- Guides (ceux des créateurs doivent être validés) ----------
// Lit le formulaire (texte + fichiers) ; old = guide existant lors d'une modification
function parseGuide(req, old) {
  const b = req.body || {}, files = req.files || [];
  const good = files.filter(sniff);
  delFiles(files.filter(f => !good.includes(f)).map(f => f.filename));
  const by = {}; good.forEach(f => (by[f.fieldname] = by[f.fieldname] || []).push(f));
  const used = new Set();
  let bad = 0;
  const order = String(b.order || '').split(',').filter(k => /^\w{1,12}$/.test(k)).slice(0, 60);
  const steps = order.map(k => {
    const fl = (by['m_' + k] || []).map(f => { used.add(f); return { file: f.filename, kind: TYPES[f.mimetype][1] }; });
    const dl = (by['f_' + k] || []).map(f => { used.add(f); return { file: f.filename, kind: 'file', name: cleanName(f.originalname), size: f.size || 0 }; });
    const lk = String(b['l_' + k] || '').split('\n').slice(0, 10).map(x => x.trim()).filter(Boolean).map(line => {
      const parts = line.split(/\s+/), url = cleanLink(parts[0]);
      if (!url) { bad++; return null; }
      return { file: '', kind: 'link', url, name: parts.slice(1).join(' ').slice(0, 120) || linkLabel(url), size: 0 };
    }).filter(Boolean);
    return { id: parseInt(b['s_' + k + '_id']) || null, title: String(b['s_' + k + '_title'] || '').trim().slice(0, 150),
      body: String(b['s_' + k + '_body'] || '').trim().slice(0, 5000), files: fl.concat(dl, lk) };
  }).filter(s => s.id || s.title || s.body || s.files.length);
  let image = old ? old.image : null;
  if (b.remove_cover) image = null;
  const cv = (by.cover || [])[0];
  if (cv) { image = '/uploads/' + cv.filename; used.add(cv); }
  delFiles(good.filter(f => !used.has(f)).map(f => f.filename));
  const cat = parseInt(b.category_id);
  return {
    title: String(b.title || '').trim().slice(0, 150), steps, bad, uploaded: good.map(f => f.filename),
    delMedia: Object.keys(b).filter(k => /^delm_\d+$/.test(k)).map(k => +k.slice(5)),
    g: { title: String(b.title || '').trim().slice(0, 150), intro: String(b.intro || '').trim().slice(0, 1500),
      tags: Diag.tagsToDb(Diag.parseTags(b.tags)), tools: String(b.tools || '').trim().slice(0, 2000), category_id: cat && one('SELECT 1 FROM categories WHERE id=?', cat) ? cat : null,
      difficulty: ['Facile', 'Moyen', 'Difficile'].includes(b.difficulty) ? b.difficulty : 'Moyen',
      duration: Math.max(0, Math.min(1440, parseInt(b.duration) || 0)), image },
  };
}
app.get('/new', need(...WRITERS), (req, res) => res.render('form', { title: 'Nouveau guide', g: {}, steps: [{}], cats: D.catList() }));
app.post('/new', need(...WRITERS), upload, (req, res) => {
  const f = parseGuide(req);
  if (!f.title) { delFiles(f.uploaded); flash(req, 'Le titre est obligatoire.'); return res.redirect('/new'); }
  const status = isStaff(req.user) ? 'approved' : 'pending';
  const r = D.saveGuide({ ...f.g, author_id: req.user.id, status }, f.steps, []);
  flash(req, (status === 'pending' ? 'Guide envoyé : il sera publié après validation par un modérateur.' : 'Guide publié.') + (f.bad ? ' ' + f.bad + ' lien(s) refusé(s) : seuls les liens https vers archive.org sont acceptés.' : ''));
  res.redirect(status === 'pending' ? '/mine' : '/guide/' + r.id);
});
const canEdit = (req, res, next) => {
  const g = one('SELECT * FROM guides WHERE id=?', req.params.id), u = req.user;
  if (!g) return notFound(res, 'Guide introuvable.');
  if (!u) return res.redirect('/login');
  if (!(isStaff(u) || (u.role === 'creator' && g.author_id === u.id))) return res.status(403).render('error', { text: 'Accès refusé.' });
  req.guide = g; next();
};
app.get('/edit/:id', canEdit, (req, res) => {
  const steps = D.getSteps(req.guide.id);
  res.render('form', { title: 'Modifier le guide', g: req.guide, steps: steps.length ? steps : [{}], cats: D.catList() });
});
app.post('/edit/:id', canEdit, upload, (req, res) => {
  const f = parseGuide(req, req.guide);
  if (!f.title) { delFiles(f.uploaded); flash(req, 'Le titre est obligatoire.'); return res.redirect('/edit/' + req.guide.id); }
  const status = isStaff(req.user) ? req.guide.status : 'pending';
  const r = D.saveGuide({ ...f.g, id: req.guide.id, status }, f.steps, f.delMedia);
  delFiles(r.removed);
  if (status === 'pending' && req.guide.status !== 'pending') flash(req, 'Modifications envoyées : le guide sera de nouveau validé par un modérateur.' + (f.bad ? ' ' + f.bad + ' lien(s) refusé(s) : seuls les liens https vers archive.org sont acceptés.' : ''));
  else flash(req, 'Guide enregistré.' + (f.bad ? ' ' + f.bad + ' lien(s) refusé(s) : seuls les liens https vers archive.org sont acceptés.' : ''));
  res.redirect('/guide/' + r.id);
});
app.post('/delete/:id', need(...WRITERS), (req, res) => {
  const g = one('SELECT author_id FROM guides WHERE id=?', req.params.id);
  if (g && (isStaff(req.user) || g.author_id === req.user.id)) { delFiles(D.deleteGuide(req.params.id)); flash(req, 'Guide supprimé.'); }
  res.redirect('/');
});
app.get('/mine', need(...WRITERS), (req, res) => res.render('mine', { title: 'Mes guides', guides: D.listGuides({ authorId: req.user.id, status: null }), diags: all(DIAG_SQL + ' WHERE d.author_id=? ORDER BY d.id DESC', req.user.id) }));

// ---------- Modération : modérateurs ET admins valident ----------
app.get('/moderation', need('moderator', 'admin'), (req, res) =>
  res.render('moderation', { title: 'Validation', guides: D.listGuides({ status: 'pending', limit: 200 }).reverse(), diags: all(DIAG_SQL + ` WHERE d.status='pending' ORDER BY d.id`) }));
app.post('/moderation/:id/approve', need('moderator', 'admin'), (req, res) => {
  run(`UPDATE guides SET status='approved', reject_note=NULL WHERE id=?`, req.params.id);
  flash(req, 'Guide validé et publié.'); res.redirect('/moderation');
});
app.post('/moderation/diag/:id/approve', need('moderator', 'admin'), (req, res) => {
  run(`UPDATE diags SET status='approved', reject_note=NULL WHERE id=?`, req.params.id); flash(req, 'Outil de diagnostic validé et publié.'); res.redirect('/moderation');
});
app.post('/moderation/diag/:id/reject', need('moderator', 'admin'), (req, res) => {
  run(`UPDATE diags SET status='rejected', reject_note=? WHERE id=?`, (req.body.note || '').trim().slice(0, 500), req.params.id); flash(req, 'Outil de diagnostic refusé.'); res.redirect('/moderation');
});
app.post('/moderation/:id/reject', need('moderator', 'admin'), (req, res) => {
  run(`UPDATE guides SET status='rejected', reject_note=? WHERE id=?`, (req.body.note || '').trim().slice(0, 500), req.params.id);
  flash(req, 'Guide refusé.'); res.redirect('/moderation');
});

// ---------- Administration ----------
app.get('/admin', need('admin', 'moderator'), (req, res) => res.render('admin', {
  title: 'Administration',
  stats: { users: one('SELECT COUNT(*) n FROM users').n, guides: one(`SELECT COUNT(*) n FROM guides WHERE status='approved'`).n,
    pending: one(`SELECT COUNT(*) n FROM guides WHERE status='pending'`).n, comments: one('SELECT COUNT(*) n FROM comments').n },
  users: all('SELECT id,email,name,role,banned FROM users ORDER BY id DESC'),
  cats: D.catList(),
  comments: all('SELECT m.id,m.body,m.guide_id,u.name FROM comments m JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 30'),
}));
// Icône de catégorie : un emoji OU une image envoyée (l'image est prioritaire)
function parseIcon(req, old) {
  const files = req.files || [];
  const f = files.find(x => x.fieldname === 'icon_file' && TYPES[x.mimetype] && TYPES[x.mimetype][1] === 'image' && sniff(x));
  delFiles(files.filter(x => x !== f).map(x => x.filename));
  const emoji = String(req.body.icon_text || '').trim().slice(0, 12);
  let icon = old || null;
  if (req.body.remove_icon) icon = null;
  if (emoji) icon = emoji;
  if (f) icon = '/uploads/' + f.filename;
  return icon;
}
app.post('/admin/category', need('admin'), upload, (req, res) => {
  const n = (req.body.name || '').trim().slice(0, 60), parent = parseInt(req.body.parent_id) || null, icon = parseIcon(req, null);
  const r = n ? run('INSERT OR IGNORE INTO categories(name,parent_id,icon) VALUES(?,?,?)', n, parent, icon) : { changes: 0 };
  if (!r.changes) { delFiles([D.coverFile(icon)]); if (n) flash(req, 'Ce nom de catégorie existe déjà.'); }
  res.redirect('/admin');
});
app.post('/admin/category/:id/icon', need('admin'), upload, (req, res) => {
  const c = one('SELECT * FROM categories WHERE id=?', req.params.id);
  if (!c) { parseIcon(req, null); return res.redirect('/admin'); }
  const icon = parseIcon(req, c.icon);
  run('UPDATE categories SET icon=? WHERE id=?', icon, c.id);
  if (icon !== c.icon) delFiles([D.coverFile(c.icon)]);
  flash(req, 'Icône mise à jour.'); res.redirect('/admin');
});
app.post('/admin/category/:id/delete', need('admin'), (req, res) => {
  const c = one('SELECT icon FROM categories WHERE id=?', req.params.id);
  run('DELETE FROM categories WHERE id=?', req.params.id);
  if (c) delFiles([D.coverFile(c.icon)]);
  res.redirect('/admin');
});
app.post('/admin/user/:id', need('admin'), (req, res) => {
  if (+req.params.id !== req.user.id) {
    if (Object.keys(ROLES).includes(req.body.role)) run('UPDATE users SET role=? WHERE id=?', req.body.role, req.params.id);
    run('UPDATE users SET banned=? WHERE id=?', req.body.banned === 'on' ? 1 : 0, req.params.id);
  }
  res.redirect('/admin');
});
app.post('/admin/user/:id/ban', need('moderator', 'admin'), (req, res) => {
  run(`UPDATE users SET banned=1-banned WHERE id=? AND role='reader'`, req.params.id);
  res.redirect('/admin');
});

app.use((req, res) => notFound(res, 'Page introuvable.'));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { text: 'Erreur serveur.' }); });
module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('RepairHub prêt sur http://localhost:' + port));
}
