// Outil de diagnostic : un arbre de questions écrit en texte simple.
//   [repere] Question ?              ← une étape (le premier repère est le départ)
//   - Réponse -> autre_repere        ← un choix qui mène à une autre étape
//   - Réponse -> = Résultat #hashtag ← un choix qui mène directement à un résultat
//   [repere] = Résultat #hashtag     ← un résultat réutilisable
//   ... = Résultat | guide: 12 | lien: https://site.fr/article Titre   ← articles de réparation proposés
// Les #hashtags d'un résultat servent à proposer automatiquement les guides correspondants.
const MAX_NODES = 80, MAX_OPTS = 8;
const slug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const TAG_RE = /#([\p{L}\p{N}_-]{2,30})/gu;
const extractTags = text => { const t = []; String(text).replace(TAG_RE, (m, x) => { const s = slug(x); if (s && !t.includes(s)) t.push(s); return m; }); return t; };
const stripTags = text => String(text).replace(TAG_RE, '').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
// Hashtags d'un guide : "#Batterie, iPhone" -> ",batterie,iphone,"
const parseTags = str => { const out = []; String(str || '').split(/[\s,;]+/).forEach(x => { const s = slug(x.replace(/^#+/, '')); if (s.length >= 2 && !out.includes(s) && out.length < 10) out.push(s); }); return out; };
const tagsToDb = arr => arr.length ? ',' + arr.join(',') + ',' : '';
const tagsFromDb = s => String(s || '').split(',').filter(Boolean);

// Articles de réparation d'un résultat : « guide: 12 » (guide du site) ou « lien: https://... Titre » (article externe)
const LINK_RE = /^(lien|link|article|guide)\s*:\s*(.+)$/i;
function parseLinkSpec(spec, ln, errors) {
  const m = LINK_RE.exec(String(spec).trim());
  if (!m) { errors.push(`Ligne ${ln} : après « | » écrivez « lien: https://... Titre » ou « guide: 12 ».`); return null; }
  const kind = m[1].toLowerCase(), val = m[2].trim(), parts = val.split(/\s+/);
  if (kind === 'guide') {
    const g = /^(\d{1,9})$/.exec(parts[0]) || /\/guide\/(\d{1,9})\/?(?:[?#].*)?$/.exec(parts[0]);
    if (!g) { errors.push(`Ligne ${ln} : « guide: » attend un numéro de guide (ex : guide: 12) ou l'adresse d'un guide du site.`); return null; }
    return { type: 'guide', id: +g[1] };
  }
  let url = null; try { url = new URL(parts[0]); } catch (e) { /* adresse invalide */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password) { errors.push(`Ligne ${ln} : lien invalide (adresse https obligatoire).`); return null; }
  const host = url.hostname.replace(/^www\./, '');
  return { type: 'url', url: url.toString().slice(0, 500), title: (parts.slice(1).join(' ') || host).slice(0, 120), host };
}
const splitLinks = (text, ln, errors) => {
  const parts = String(text).split('|'), links = [];
  parts.slice(1).forEach(sp => { const l = parseLinkSpec(sp, ln, errors); if (l) links.push(l); });
  return { text: parts[0].trim(), links };
};

function parseTree(src) {
  const errors = [], warnings = [], nodes = {}, order = []; let cur = null, auto = 0;
  const add = (id, kind, text, line) => {
    if (nodes[id]) { errors.push(`Ligne ${line} : le repère [${id}] existe déjà.`); return { options: [], text: '' }; }
    if (order.length >= MAX_NODES) { if (!errors.some(e => e.startsWith('Trop'))) errors.push(`Trop d'étapes (maximum ${MAX_NODES}).`); return { options: [], text: '' }; }
    nodes[id] = { id, kind, text: text || '', options: [], links: [], line }; order.push(id); return nodes[id];
  };
  String(src || '').split(/\r?\n/).forEach((raw, i) => {
    const ln = i + 1, line = raw.trim(); if (!line) return;
    let m;
    if ((m = /^\[([A-Za-z0-9_-]{1,20})\]\s*(=?)\s*(.*)$/.exec(line))) { if (m[2]) { const sp = splitLinks(m[3], ln, errors); cur = add(m[1].toLowerCase(), 'result', sp.text, ln); cur.links = sp.links; }
      else cur = add(m[1].toLowerCase(), 'question', m[3], ln);
      return; }
    if (line[0] === '-') {
      if (!cur) { errors.push(`Ligne ${ln} : écrivez d'abord une étape, par exemple « [debut] Votre question ? ».`); return; }
      if (cur.kind === 'result') { errors.push(`Ligne ${ln} : un résultat ne peut pas avoir de choix.`); return; }
      if (!(m = /^-\s*(.+?)\s*->\s*(.+)$/.exec(line))) { errors.push(`Ligne ${ln} : un choix s'écrit « - Réponse -> repère » ou « - Réponse -> = Résultat ».`); return; }
      if (cur.options.length >= MAX_OPTS) { errors.push(`Ligne ${ln} : trop de choix pour cette question (maximum ${MAX_OPTS}).`); return; }
      let target = m[2].trim();
      if (target[0] === '=') { const rid = 'r' + (++auto) + '_', sp = splitLinks(target.slice(1), ln, errors); add(rid, 'result', sp.text, ln).links = sp.links; target = rid; }
      else if (!/^[A-Za-z0-9_-]{1,20}$/.test(target)) { errors.push(`Ligne ${ln} : « ${target.slice(0, 30)} » n'est pas un repère valide (lettres, chiffres, - et _), ni un résultat commençant par =.`); return; }
      cur.options.push({ label: m[1].slice(0, 160), next: target.toLowerCase(), line: ln });
      return;
    }
    if (!cur) { errors.push(`Ligne ${ln} : écrivez d'abord une étape, par exemple « [debut] Votre question ? ».`); return; }
    if (LINK_RE.test(line)) {
      if (cur.kind !== 'result') { errors.push(`Ligne ${ln} : les liens vers des articles se placent dans un résultat.`); return; }
      const l = parseLinkSpec(line, ln, errors); if (l) cur.links.push(l); return;
    }
    cur.text += (cur.text ? '\n' : '') + line;
  });
  if (!order.length) errors.push("Écrivez au moins une question, par exemple « [debut] Votre question ? ».");
  const start = order[0];
  if (start && nodes[start].kind !== 'question') errors.push('La première étape doit être une question.');
  order.forEach(id => {
    const n = nodes[id];
    if (!n.text.trim()) errors.push(`Ligne ${n.line} : l'étape [${id}] n'a pas de texte.`);
    if (n.kind === 'question' && n.options.length === 0) errors.push(`Ligne ${n.line} : la question [${id}] n'a aucun choix.`);
    if (n.kind === 'question' && n.text.length > 500) errors.push(`Ligne ${n.line} : question trop longue (500 caractères maximum).`);
    if (n.links.length > 6) errors.push(`Ligne ${n.line} : 6 liens maximum par résultat.`);
    if (n.kind === 'result' && n.text.length > 1500) errors.push(`Ligne ${n.line} : résultat trop long (1500 caractères maximum).`);
    n.options.forEach(o => { if (!nodes[o.next]) errors.push(`Ligne ${o.line} : le repère [${o.next}] n'existe pas.`); });
  });
  if (!errors.length) {
    const seen = new Set([start]), q = [start];
    while (q.length) nodes[q.shift()].options.forEach(o => { if (!seen.has(o.next)) { seen.add(o.next); q.push(o.next); } });
    order.filter(id => !seen.has(id) && !/^r\d+_$/.test(id)).forEach(id => warnings.push(`L'étape [${id}] n'est reliée à aucune réponse : elle ne sera jamais affichée.`));
    order.forEach(id => { const n = nodes[id]; if (n.kind === 'result') { n.tags = extractTags(n.text); n.text = stripTags(n.text); } });
  }
  return { ok: errors.length === 0, errors, warnings, nodes, start, count: order.length };
}
// Rejoue le chemin des réponses (?p=repere.index,repere.index…) : jamais de confiance dans l'URL
function walk(tree, p) {
  const trail = []; let id = tree.start;
  for (const st of String(p || '').split(',').filter(Boolean).slice(0, 60)) {
    const m = /^([a-z0-9_-]{1,20})\.(\d{1,2})$/.exec(st), n = tree.nodes[id];
    if (!m || !n || n.kind !== 'question' || m[1] !== id || !n.options[+m[2]]) return { id: tree.start, node: tree.nodes[tree.start], trail: [], base: [], invalid: true };
    trail.push({ q: n.text, a: n.options[+m[2]].label, id, i: +m[2] }); id = n.options[+m[2]].next;
  }
  return { id, node: tree.nodes[id], trail, base: trail.map(t => t.id + '.' + t.i), invalid: false };
}

const SEEDS = [
  { title: "Mon smartphone ne s'allume plus", intro: "Répondez à quelques questions pour trouver la cause la plus probable et les guides qui vous aideront.", tree: `[debut] Que se passe-t-il quand vous appuyez longtemps sur le bouton d'allumage ?
- Rien du tout, l'écran reste noir -> charge
- Il s'allume puis s'éteint ou redémarre en boucle -> boucle
- Il s'allume mais l'écran est cassé ou ne répond plus -> ecran

[charge] Branchez-le 30 minutes sur un chargeur d'origine. Une icône de charge apparaît-elle ?
- Oui, il charge mais ne s'allume pas -> = Batterie très déchargée ou logiciel bloqué. Laissez charger une heure puis tentez un redémarrage forcé. Sinon, la batterie est probablement à remplacer. #batterie #smartphone
- Non, aucune réaction -> cable

[cable] Avez-vous essayé un autre câble ET un autre chargeur ?
- Non -> = Essayez d'abord un autre câble et un autre chargeur : ils sont à l'origine de la majorité de ces pannes. #chargeur #cable
- Oui, toujours rien -> port

[port] Regardez dans le port de charge avec une lampe : y voyez-vous de la poussière ou de la saleté ?
- Oui -> = Nettoyez délicatement avec un cure-dent en bois, appareil éteint. La saleté empêche souvent le contact. #port-de-charge #nettoyage
- Non, il est propre -> = Connecteur de charge ou batterie défectueux : une réparation est nécessaire. #connecteur #batterie #smartphone

[boucle] Le problème est-il apparu après une mise à jour ou l'installation d'une application ?
- Oui -> = Problème logiciel : démarrez en mode sans échec, désinstallez l'application récente ou réinitialisez après sauvegarde. #logiciel #smartphone
- Non, sans raison apparente -> = Batterie usée qui ne tient plus la tension : remplacement conseillé. #batterie #smartphone

[ecran] Voyez-vous des fissures ou des taches, ou l'appareil est-il tombé ?
- Oui -> = Écran à remplacer. #ecran #smartphone #remplacement
- Non -> = Mauvaise connexion de la dalle ou problème logiciel : redémarrage forcé, puis diagnostic en atelier. #ecran #smartphone` },
  { title: 'Mon ordinateur portable est lent, chauffe ou ne démarre pas', intro: "Un petit questionnaire pour orienter votre réparation : disque, mémoire, ventilation ou alimentation.", tree: `[debut] Quel est le problème principal de votre ordinateur portable ?
- Il est très lent -> lent
- Il chauffe beaucoup et le ventilateur est bruyant -> chaud
- Il ne démarre plus du tout -> demarre

[lent] Le stockage est-il un disque mécanique (HDD) ou un SSD ?
- HDD, ou je ne sais pas -> = Passer à un SSD est la meilleure amélioration de vitesse possible. #ssd #ordinateur #upgrade
- SSD -> ram

[ram] Votre mémoire vive (RAM) est-elle de 8 Go ou moins ?
- Oui -> = Ajouter de la RAM aide si vous gardez beaucoup d'onglets ou d'applications ouverts. #ram #ordinateur #upgrade
- Non -> = Vérifiez les programmes lancés au démarrage et cherchez d'éventuels logiciels indésirables. #logiciel #ordinateur

[chaud] Quand a eu lieu le dernier dépoussiérage de l'ordinateur ?
- Jamais, ou il y a plus de 2 ans -> = Ventilateur et grilles encrassés : nettoyez-les. Si cela ne suffit pas, renouvelez la pâte thermique. #ventilateur #nettoyage #ordinateur
- Récemment -> = Renouvelez la pâte thermique et vérifiez que le ventilateur tourne bien. #pate-thermique #ventilateur #ordinateur

[demarre] Un voyant s'allume-t-il quand vous branchez le chargeur ?
- Oui -> ecran
- Non -> = Chargeur ou prise de charge défectueux, ou batterie totalement vide : testez un autre chargeur compatible. #chargeur #ordinateur

[ecran] Entendez-vous le ventilateur tourner alors que l'écran reste noir ?
- Oui -> = Écran, mémoire mal fixée ou carte mère : reposez la RAM et testez un écran externe. #ram #ecran #ordinateur
- Non -> = Alimentation interne ou carte mère : un diagnostic en atelier est conseillé. #carte-mere #ordinateur` },
  { title: 'Mon lave-linge ne vidange pas, ne démarre pas ou fait du bruit', intro: "Trouvez rapidement l'origine de la panne avant d'appeler un réparateur.", tree: `[debut] Quel est le problème de votre lave-linge ?
- Il ne vidange pas l'eau -> vidange
- Il ne démarre pas du tout -> demarre
- Il fait beaucoup de bruit à l'essorage -> bruit

[vidange] Avez-vous nettoyé le filtre de vidange (en bas, derrière la petite trappe) ?
- Non -> = Videz et nettoyez le filtre : pièces de monnaie, chaussettes et peluches le bouchent souvent. #filtre #lave-linge
- Oui, il est propre -> tuyau

[tuyau] Le tuyau d'évacuation est-il plié, bouché ou placé trop haut ?
- Oui -> = Dégagez ou repositionnez le tuyau (environ 1 mètre de haut au maximum). #tuyau #lave-linge
- Non -> = Pompe de vidange probablement hors service : à remplacer. #pompe #lave-linge

[demarre] Le voyant s'allume-t-il quand vous branchez la machine et fermez la porte ?
- Le voyant ne s'allume pas -> = Vérifiez la prise, le disjoncteur puis le cordon d'alimentation. #electricite #lave-linge
- Voyant allumé mais rien ne démarre -> = Le verrou de porte ou le module électronique est en cause. #verrou-de-porte #lave-linge

[bruit] Le bruit ressemble-t-il à un grincement métallique ou à de grosses secousses ?
- Un grincement métallique -> = Roulements du tambour usés : réparation à envisager rapidement. #roulements #lave-linge
- De grosses secousses -> = Machine mal calée ou linge mal réparti : réglez les pieds et vérifiez les amortisseurs. #amortisseurs #lave-linge` },
];
module.exports = { slug, parseTags, tagsToDb, tagsFromDb, extractTags, stripTags, parseTree, walk, SEEDS };
