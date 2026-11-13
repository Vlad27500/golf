/* Golf Tracker – application principale */
'use strict';

/* ---------- Utilitaires ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Date().toISOString().slice(0, 10);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, b) => (b ? Math.round((100 * a) / b) + ' %' : '–');
const one = (a, b) => (b ? (a / b).toFixed(1).replace('.', ',') : '–');

const LIES = [['tee', 'Tee'], ['fairway', 'Fairway'], ['rough', 'Rough'], ['bunker', 'Bunker'], ['recovery', 'Recovery']];
const LIE_LABEL = { tee: 'Tee', fairway: 'Fairway', rough: 'Rough', bunker: 'Bunker', recovery: 'Recovery', green: 'Green', trou: 'Dans le trou' };
const KINDS = [['plein', 'Plein'], ['punch', 'Punch'], ['chip', 'Chip'], ['lob', 'Lob']];
const COLORS = ['#e53935', '#fb8c00', '#fdd835', '#7cb342', '#43a047', '#00acc1', '#1e88e5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41', '#546e7a'];

const DEFAULT_CLUBS = [['Driver', 180], ['Bois 3', 160], ['Hybride 3', 150], ['Fer 5', 140], ['Fer 6', 130], ['Fer 7', 120],
  ['Fer 8', 110], ['Fer 9', 100], ['PW', 90], ['48°', 80], ['52°', 70], ['58°', 55]]
  .map(([name, target], i) => ({ id: 'c' + i, name, target, color: COLORS[i % COLORS.length] }));
const DEFAULT_SETTINGS = { unit: 'm', index: 35, sim: false, wake: true, theme: 'dark', lastBackup: null };

const S = { settings: null, clubs: null, courses: {}, map: null, cleanup: [], sheet: null };

function fmt(m, unit = true) {
  if (m == null || isNaN(m)) return '–';
  const v = S.settings.unit === 'yd' ? m * 1.09361 : m;
  return Math.round(v) + (unit ? (S.settings.unit === 'yd' ? ' y' : ' m') : '');
}
function unitLabel() { return S.settings.unit === 'yd' ? 'yards' : 'mètres'; }

async function saveSettings() { await DB.put('kv', S.settings, 'settings'); applyTheme(); }
async function saveClubs() { await DB.put('kv', S.clubs, 'clubs'); }
function applyTheme() { document.body.classList.toggle('light', S.settings.theme === 'light'); }

/* ---------- Toast / feuilles / confirmations ---------- */
function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}
function bind(root, handlers) {
  root.onclick = e => {
    const t = e.target.closest('[data-act]');
    if (t && root.contains(t) && handlers[t.dataset.act]) handlers[t.dataset.act](t.dataset.arg, t, e);
  };
}
function openSheet(html, handlers = {}) {
  const sh = $('#sheet');
  sh.innerHTML = `<div class="sheet-bg" data-act="__close"></div><div class="sheet-body">${html}</div>`;
  sh.classList.add('on');
  bind(sh, { __close: closeSheet, close: closeSheet, ...handlers });
  return sh;
}
function closeSheet() { const sh = $('#sheet'); sh.classList.remove('on'); sh.innerHTML = ''; }
function ask(question, okLabel = 'Confirmer', danger = false) {
  return new Promise(res => {
    openSheet(`<p class="q">${esc(question)}</p>
      <div class="row2"><button class="btn" data-act="no">Annuler</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-act="yes">${esc(okLabel)}</button></div>`,
    { no: () => { closeSheet(); res(false); }, yes: () => { closeSheet(); res(true); }, __close: () => { closeSheet(); res(false); } });
  });
}

/* ---------- GPS (réel ou simulé) ---------- */
const GPS = {
  pos: null, err: null, watch: null, subs: new Set(),
  start() {
    if (this.watch !== null || !navigator.geolocation) return;
    this.watch = navigator.geolocation.watchPosition(
      p => { if (!S.settings.sim) this.set([p.coords.latitude, p.coords.longitude], p.coords.accuracy); },
      e => { this.err = e.message; this.emit(); },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  },
  set(ll, acc) { this.pos = { ll, acc, t: Date.now() }; this.err = null; this.emit(); },
  emit() { this.subs.forEach(f => f(this.pos)); },
  on(f) { this.subs.add(f); return () => this.subs.delete(f); },
  fresh() { return this.pos && (S.settings.sim || Date.now() - this.pos.t < 30000) ? this.pos.ll : null; },
  once(timeout = 15000) {
    return new Promise((res, rej) => {
      if (this.fresh()) return res(this.fresh());
      if (!navigator.geolocation) return rej(new Error('GPS indisponible'));
      navigator.geolocation.getCurrentPosition(p => res([p.coords.latitude, p.coords.longitude]),
        e => rej(new Error(e.message)), { enableHighAccuracy: true, timeout });
    });
  },
};

/* ---------- Carte ---------- */
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const FEAT_STYLE = {
  green: { color: '#7CFC8A', weight: 1, fillOpacity: 0.15 }, fairway: { color: '#b5e655', weight: 1, fillOpacity: 0.06 },
  tee: { color: '#ffffff', weight: 1, fillOpacity: 0.1 }, bunker: { color: '#ffe8a3', weight: 1, fillOpacity: 0.25 },
  water: { color: '#4fc3f7', weight: 1, fillOpacity: 0.25 }, rough: { color: '#558b2f', weight: 0, fillOpacity: 0 },
  range: { color: '#999', weight: 1, fillOpacity: 0 },
};
function makeMap(el) {
  const m = L.map(el, { zoomControl: false, maxZoom: 20, tap: true });
  m.attributionControl.setPrefix(false);
  L.tileLayer(TILE_URL, { maxNativeZoom: 18, maxZoom: 20, attribution: '© Esri · © OpenStreetMap' }).addTo(m);
  S.map = m;
  return m;
}
function drawFeatures(map, course) {
  const g = L.layerGroup();
  for (const f of course.features || []) if (FEAT_STYLE[f.kind]) L.polygon(f.poly, { ...FEAT_STYLE[f.kind], interactive: false }).addTo(g);
  return g.addTo(map);
}
const pin = (txt, cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${txt}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });

function tilesForBbox(bb) {
  const [s, w, n, e] = bb, out = [];
  const lx = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const ly = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
  for (let z = 15; z <= 18; z++) for (let x = lx(w, z); x <= lx(e, z); x++) for (let y = ly(n, z); y <= ly(s, z); y++)
    out.push(TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
  return out;
}
async function prefetchTiles(course, onProgress) {
  if (!('caches' in window)) return 0;
  let bb = course.bbox;
  const pts = course.holes.flatMap(h => [h.tee, h.green && h.green.c]).filter(Boolean);
  if (!bb && pts.length) bb = Geo.bbox(pts);
  if (!bb) return 0;
  const p = 0.001; bb = [bb[0] - p, bb[1] - p, bb[2] + p, bb[3] + p];
  const urls = tilesForBbox(bb).slice(0, 1500);
  const cache = await caches.open('tiles');
  let done = 0; const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try { if (!(await cache.match(u))) { const r = await fetch(u, { mode: 'no-cors' }); await cache.put(u, r); } } catch (e) { /* ignore */ }
      done++; onProgress && onProgress(done, urls.length);
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));
  return urls.length;
}

/* ---------- Logique de jeu ---------- */
function courseHole(round, i) { const c = S.courses[round.courseId]; return (c && c.holes[i]) || round.holes[i]; }
// Devine le lie à partir de la cartographie. Sans fairways cartographiés,
// on considère « fairway » tout ce qui est à moins de 18 m de l'axe du trou.
function lieAt(course, ll, hole) {
  if (!course || !ll) return 'rough';
  const feats = course.features || [];
  const hit = k => feats.some(f => f.kind === k && Geo.inPoly(ll, f.poly));
  if (hit('bunker')) return 'bunker';
  if (hit('fairway') || hit('green') || hit('tee')) return 'fairway';
  if (!feats.some(f => f.kind === 'fairway') && hole && hole.tee && hole.green) {
    if (Geo.distToLine(ll, hole.line || [hole.tee, hole.green.c]) < 18) return 'fairway';
  }
  return 'rough';
}
function derive(round, i) {
  const H = round.holes[i], C = courseHole(round, i);
  const greenC = C.green && C.green.c;
  const shots = H.shots.map((s, k) => {
    const next = H.shots[k + 1];
    let end = null, result = null;
    if (next) { end = next.pos; result = next.lie; }
    else if (H.greenPos) { end = H.greenPos; result = 'green'; }
    else if (H.putts === 0) { end = greenC; result = 'trou'; }
    return { ...s, end, result, dist: end ? Geo.dist(s.pos, end) : null };
  });
  const pen = H.shots.reduce((a, s) => a + (s.pen || 0), 0);
  const finished = H.putts != null || !!H.picked;
  const score = H.picked ? null : finished ? H.shots.length + pen + (H.putts || 0) : null;
  const toGreen = H.shots.length + pen;
  const onGreen = !!H.greenPos || H.putts === 0;
  const gir = finished && !H.picked && onGreen && toGreen <= H.par - 2;
  let fir = null, firSide = null;
  if (H.par >= 4 && shots[0] && shots[0].result && shots[0].result !== 'trou') {
    fir = shots[0].result === 'fairway' || (shots[0].result === 'green');
    if (!fir && greenC && shots[0].end) firSide = Geo.side(shots[0].pos, greenC, shots[0].end);
  }
  return { shots, pen, finished, score, gir, fir, firSide, par: H.par, putts: H.putts };
}
function strokesReceived(round) {
  const N = round.holes.length;
  const p = Math.max(0, Math.round(N === 9 ? round.phcp / 2 : round.phcp));
  const order = round.holes.map((h, i) => ({ i, k: courseHole(round, i).hcp || h.n })).sort((a, b) => a.k - b.k);
  const out = new Array(N).fill(Math.floor(p / N));
  order.forEach((o, rank) => { if (rank < p % N) out[o.i]++; });
  return out;
}
function roundTotals(round) {
  const rec = strokesReceived(round);
  let score = 0, par = 0, putts = 0, stb = 0, played = 0, pen = 0, complete = true;
  round.holes.forEach((H, i) => {
    const d = derive(round, i);
    if (!d.finished) { complete = false; return; }
    played++; pen += d.pen; putts += H.putts || 0;
    if (d.score == null) { complete = false; return; }
    score += d.score; par += H.par;
    stb += Math.max(0, H.par + rec[i] - d.score + 2);
  });
  return { score, par, putts, stb, played, pen, complete: complete && played === round.holes.length, rec };
}
function clubSamples(rounds) {
  const res = {};
  for (const r of rounds) r.holes.forEach((H, i) => {
    for (const s of derive(r, i).shots) {
      if (!s.club || s.dist == null || s.miss || s.pen || (s.kind && s.kind !== 'plein') || s.lie === 'recovery') continue;
      if (s.dist < 5) continue;
      (res[s.club] = res[s.club] || []).push(s.dist);
    }
  });
  return res;
}
function analyze(rounds) {
  const a = { rounds: rounds.length, holes: 0, putts: 0, three: 0, one: 0, fwE: 0, fwH: 0, fwL: 0, fwR: 0, girE: 0, gir: 0,
    scrE: 0, scr: 0, pen: 0, fullRounds: 0, fullScore: 0, fullPar: 0, stb: 0, firstPutt: [] };
  for (const r of rounds) {
    const t = roundTotals(r);
    if (t.complete) { a.fullRounds++; a.fullScore += t.score; a.fullPar += t.par; a.stb += t.stb; }
    r.holes.forEach((H, i) => {
      const d = derive(r, i);
      if (!d.finished) return;
      a.holes++; a.pen += d.pen;
      if (H.picked) return;
      a.putts += H.putts || 0;
      if (H.putts >= 3) a.three++;
      if (H.putts === 1) a.one++;
      if (d.fir !== null) { a.fwE++; if (d.fir) a.fwH++; else if (d.firSide === 'G') a.fwL++; else if (d.firSide === 'D') a.fwR++; }
      a.girE++; if (d.gir) a.gir++;
      else { a.scrE++; if (d.score <= H.par) a.scr++; }
    });
  }
  a.perRound = a.holes / 18;
  return a;
}

/* ---------- Partie en cours ---------- */
async function saveRound(r) { r.updatedAt = Date.now(); await DB.put('rounds', r); }
async function saveCourse(c) { S.courses[c.id] = c; await DB.put('courses', c); }

function newRound(course, startHole, phcp) {
  const holes = course.holes.map(h => ({ n: h.n, par: h.par, shots: [], putts: null, firstPutt: null, greenPos: null, picked: false }));
  const s = Math.max(0, holes.findIndex(h => h.n === startHole));
  const seq = holes.map((_, i) => (s + i) % holes.length);
  return { id: uid(), courseId: course.id, courseName: course.name, date: new Date().toISOString(), phcp, holes, seq, pos: 0, done: false };
}

/* ======================================================================
   VUES
   ====================================================================== */
const app = () => $('#app');

/* ----- Accueil ----- */
async function viewHome() {
  const rounds = (await DB.all('rounds')).sort((a, b) => b.date.localeCompare(a.date));
  const open = rounds.find(r => !r.done);
  const lastB = S.settings.lastBackup;
  const unsaved = rounds.filter(r => !lastB || (r.updatedAt || 0) > lastB).length;
  app().innerHTML = `
  <div class="page home">
    <h1>⛳ Golf Tracker</h1>
    ${open ? `<button class="big primary" data-act="resume">▶ Reprendre la partie<br><small>${esc(open.courseName)} · trou ${open.holes[open.seq[open.pos]].n}</small></button>` : ''}
    <button class="big ${open ? '' : 'primary'}" data-act="new">⛳ Nouvelle partie</button>
    <div class="grid2">
      <button class="tile" data-act="go" data-arg="#/stats">📊<br>Statistiques</button>
      <button class="tile" data-act="go" data-arg="#/history">🗂<br>Historique</button>
      <button class="tile" data-act="go" data-arg="#/courses">🗺<br>Parcours</button>
      <button class="tile" data-act="go" data-arg="#/settings">⚙️<br>Réglages</button>
    </div>
    ${unsaved && rounds.length ? `<button class="warn" data-act="backup">💾 ${unsaved} partie(s) non sauvegardée(s) — sauvegarder vers Proton Drive</button>` : ''}
  </div>`;
  bind(app(), {
    resume: () => (location.hash = '#/play/' + open.id),
    new: () => (location.hash = '#/courses'),
    go: a => (location.hash = a),
    backup: () => backup().then(viewHome),
  });
}

/* ----- Parcours : liste, recherche, import ----- */
async function viewCourses() {
  const list = Object.values(S.courses).sort((a, b) => a.name.localeCompare(b.name));
  app().innerHTML = `
  <div class="page">
    <div class="top"><button class="icon" data-act="home">←</button><h2>Choisir un parcours</h2></div>
    <h3>Mes parcours</h3>
    ${list.length ? list.map(c => `<button class="item" data-act="pick" data-arg="${esc(c.id)}">
        <b>${esc(c.name)}</b><small>${c.holes.length} trous · ${c.holes.filter(h => h.tee && h.green).length} cartographiés</small></button>`).join('')
      : '<p class="muted">Aucun parcours enregistré pour l’instant.</p>'}
    <h3>Ajouter un parcours</h3>
    <button class="btn primary wide" data-act="near">📍 Parcours à proximité</button>
    <div class="searchrow"><input id="q" type="search" placeholder="Nom ou ville (ex. Combles)" enterkeyhint="search"><button class="btn" data-act="search">🔎</button></div>
    <button class="btn wide" data-act="manual">✏️ Créer un parcours à la main</button>
    <div id="results"></div>
  </div>`;
  const showResults = (items, title) => {
    $('#results').innerHTML = `<h3>${esc(title)}</h3>` + (items.length ? items.map((x, k) => `<button class="item" data-act="import" data-arg="${k}">
      <b>${esc(x.name)}</b><small>${x.dist != null ? (x.dist / 1000).toFixed(1).replace('.', ',') + ' km · ' : ''}${esc(x.detail || '')}</small></button>`).join('')
      : '<p class="muted">Aucun golf trouvé.</p>');
    S.results = items;
  };
  bind(app(), {
    home: () => (location.hash = '#/home'),
    pick: id => coursePicked(S.courses[id]),
    near: async () => {
      $('#results').innerHTML = '<p class="muted">Recherche autour de toi…</p>';
      try {
        GPS.start();
        const ll = await GPS.once();
        const items = await OSM.nearby(ll[0], ll[1]);
        items.forEach(x => (x.detail = ''));
        showResults(items, 'À proximité');
      } catch (e) { $('#results').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    },
    search: async () => {
      const q = $('#q').value.trim(); if (!q) return;
      $('#results').innerHTML = '<p class="muted">Recherche…</p>';
      try { showResults(await OSM.search(q), 'Résultats'); } catch (e) { $('#results').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    },
    import: async k => {
      const x = S.results[+k];
      $('#results').innerHTML = `<p class="muted">Import de « ${esc(x.name)} » depuis OpenStreetMap…<br>(jusqu’à une minute)</p>`;
      try {
        const c = await OSM.loadCourse(x.type, x.id, x.name);
        if (S.courses[c.id] && !(await ask('Ce parcours existe déjà. Le remplacer par la version OpenStreetMap ?', 'Remplacer', true))) return;
        await saveCourse(c);
        toast(c.found ? `${c.found} trous trouvés dans OpenStreetMap` : 'Aucun trou détaillé : place départs et greens à la main', 4000);
        location.hash = '#/course/' + encodeURIComponent(c.id);
        prefetchTiles(c);
      } catch (e) { $('#results').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    },
    manual: async () => {
      const name = prompt('Nom du parcours ?'); if (!name) return;
      const n = await new Promise(res => openSheet(`<p class="q">Combien de trous ?</p>
        <div class="row2"><button class="btn primary" data-act="n" data-arg="9">9 trous</button><button class="btn primary" data-act="n" data-arg="18">18 trous</button></div>`,
      { n: v => { closeSheet(); res(+v); }, __close: () => { closeSheet(); res(0); } }));
      if (!n) return;
      let center = null; try { center = await GPS.once(8000); } catch (e) { /* ignore */ }
      const c = { id: 'm-' + uid(), name, center: center || [46.6, 2.4], bbox: null, outline: [], features: [], createdAt: Date.now(),
        holes: Array.from({ length: n }, (_, i) => ({ n: i + 1, par: 4, hcp: null, tee: null, green: null })) };
      await saveCourse(c);
      location.hash = '#/course/' + encodeURIComponent(c.id);
    },
  });
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') $('[data-act=search]').click(); });
}

function coursePicked(c) {
  openSheet(`<h3>${esc(c.name)}</h3>
    <button class="big primary" data-act="play">▶ Jouer</button>
    <button class="btn wide" data-act="edit">✏️ Voir / modifier le parcours</button>
    <button class="btn wide danger" data-act="del">🗑 Supprimer</button>`, {
    play: () => { closeSheet(); startRoundSheet(c); },
    edit: () => { closeSheet(); location.hash = '#/course/' + encodeURIComponent(c.id); },
    del: async () => {
      closeSheet();
      if (await ask(`Supprimer « ${c.name} » ? Les parties déjà jouées sont conservées.`, 'Supprimer', true)) {
        delete S.courses[c.id]; await DB.del('courses', c.id); viewCourses();
      }
    },
  });
}

function startRoundSheet(c) {
  let start = 1, phcp = Math.round(S.settings.index);
  const render = () => openSheet(`<h3>Nouvelle partie · ${esc(c.name)}</h3>
    <label>Trou de départ</label>
    <div class="seg">${[1, 10].filter(n => n <= c.holes.length).map(n => `<button class="${n === start ? 'on' : ''}" data-act="start" data-arg="${n}">Trou ${n}</button>`).join('')}</div>
    <label>Handicap de jeu (pour le Stableford)</label>
    <div class="stepper"><button data-act="ph" data-arg="-1">−</button><b>${phcp}</b><button data-act="ph" data-arg="1">+</button></div>
    <button class="big primary" data-act="go">C’est parti</button>
    <button class="btn wide" data-act="close">Annuler</button>`, {
    start: n => { start = +n; render(); },
    ph: d => { phcp = Math.max(0, Math.min(54, phcp + +d)); render(); },
    go: async () => {
      const r = newRound(c, start, phcp);
      await saveRound(r); closeSheet();
      location.hash = '#/play/' + r.id;
    },
  });
  render();
}

/* ----- Édition d'un parcours ----- */
async function viewCourse(id) {
  const c = S.courses[decodeURIComponent(id)];
  if (!c) { location.hash = '#/courses'; return; }
  let hi = c.holes.findIndex(h => !h.tee || !h.green); if (hi < 0) hi = 0;
  let mode = null;
  app().innerHTML = `
  <div class="play">
    <div class="top"><button class="icon" data-act="back">←</button><h2 class="grow">${esc(c.name)}</h2><button class="btn small" data-act="rename">Renommer</button></div>
    <div class="chips" id="holes"></div>
    <div class="editbar" id="edit"></div>
    <div id="map" class="map"></div>
    <div class="actions">
      <button class="btn" data-act="offline" id="offl">📥 Hors-ligne</button>
      <button class="btn primary" data-act="play">▶ Jouer</button>
    </div>
  </div>`;
  const map = makeMap($('#map'));
  drawFeatures(map, c);
  const dyn = L.layerGroup().addTo(map);
  const pts = c.holes.flatMap(h => [h.tee, h.green && h.green.c]).filter(Boolean);
  if (c.bbox) map.fitBounds([[c.bbox[0], c.bbox[1]], [c.bbox[2], c.bbox[3]]]);
  else if (pts.length) map.fitBounds(pts, { padding: [30, 30] });
  else map.setView(c.center, 16);

  const draw = (fit) => {
    dyn.clearLayers();
    c.holes.forEach((h, i) => {
      if (h.tee) L.marker(h.tee, { icon: pin(h.n, i === hi ? 'tee sel' : 'tee'), interactive: false }).addTo(dyn);
      if (h.green) L.marker(h.green.c, { icon: pin('⚑', i === hi ? 'flag sel' : 'flag'), interactive: false }).addTo(dyn);
      if (h.tee && h.green) L.polyline(h.line || [h.tee, h.green.c], { color: i === hi ? '#fff' : '#ffffff55', weight: i === hi ? 3 : 1, dashArray: '6 6', interactive: false }).addTo(dyn);
    });
    const h = c.holes[hi];
    if (fit) { const p = [h.tee, h.green && h.green.c].filter(Boolean); if (p.length === 2) map.fitBounds(p, { padding: [40, 40] }); else if (p.length) map.setView(p[0], 17); }
    $('#holes').innerHTML = c.holes.map((x, i) => `<button class="chip ${i === hi ? 'on' : ''} ${x.tee && x.green ? 'ok' : 'todo'}" data-act="hole" data-arg="${i}">${x.n}</button>`).join('');
    const len = h.tee && h.green ? Geo.dist(h.tee, h.green.c) : null;
    $('#edit').innerHTML = `
      <div class="line"><b>Trou ${h.n}</b> · ${len ? fmt(len) : 'longueur ?'} ${h.parGuessed ? '<span class="tag">par estimé</span>' : ''}
        <span class="grow"></span>Par <span class="seg mini">${[3, 4, 5].map(p => `<button class="${h.par === p ? 'on' : ''}" data-act="par" data-arg="${p}">${p}</button>`).join('')}</span></div>
      <div class="line">Placer : <button class="btn small ${mode === 'tee' ? 'primary' : ''}" data-act="mode" data-arg="tee">Départ</button>
        <button class="btn small ${mode === 'green' ? 'primary' : ''}" data-act="mode" data-arg="green">Centre du green</button>
        <span class="grow"></span>Hcp <input class="num" id="hcp" type="number" inputmode="numeric" min="1" max="18" value="${h.hcp || ''}"></div>
      ${mode ? `<p class="hint">Touche la carte pour placer ${mode === 'tee' ? 'le départ' : 'le centre du green'} du trou ${h.n}.</p>` : ''}`;
    $('#hcp').onchange = e => { h.hcp = parseInt(e.target.value, 10) || null; saveCourse(c); };
  };
  draw(true);
  map.on('click', e => {
    if (!mode) return;
    const h = c.holes[hi], ll = [e.latlng.lat, e.latlng.lng];
    if (mode === 'tee') { h.tee = ll; h.line = null; } else {
      const g = (c.features || []).find(f => f.kind === 'green' && Geo.inPoly(ll, f.poly));
      h.green = g ? { c: Geo.centroid(g.poly), poly: g.poly } : { c: ll, poly: null }; h.line = null;
    }
    mode = mode === 'tee' && !h.green ? 'green' : null;
    saveCourse(c); draw(false);
  });
  bind(app(), {
    back: () => history.length > 1 ? history.back() : (location.hash = '#/courses'),
    hole: i => { hi = +i; mode = null; draw(true); },
    par: p => { c.holes[hi].par = +p; c.holes[hi].parGuessed = false; saveCourse(c); draw(false); },
    mode: m => { mode = mode === m ? null : m; draw(false); },
    rename: async () => { const n = prompt('Nom du parcours', c.name); if (n) { c.name = n; await saveCourse(c); viewCourse(id); } },
    offline: async () => {
      const b = $('#offl'); b.disabled = true;
      const n = await prefetchTiles(c, (d, t) => (b.textContent = `📥 ${Math.round((100 * d) / t)} %`));
      b.textContent = n ? '✅ Carte hors-ligne prête' : 'Impossible'; b.disabled = false;
    },
    play: () => startRoundSheet(c),
  });
}

/* ----- Écran de jeu ----- */
async function viewPlay(id) {
  const r = await DB.get('rounds', id);
  if (!r) { location.hash = '#/home'; return; }
  const course = S.courses[r.courseId];
  GPS.start();
  let placeMode = null;
  const learned = clubSamples((await DB.all('rounds')));
  const expected = c => { const s = learned[c.id]; return s && s.length >= 3 ? median(s) : c.target; };

  app().innerHTML = `
  <div class="play">
    <header class="playbar">
      <button class="icon" data-act="prev">◀</button>
      <div class="holeinfo" data-act="card"><b id="hT"></b><small id="hS"></small></div>
      <button class="icon" data-act="next">▶</button>
      <button class="icon" data-act="menu">☰</button>
    </header>
    <div class="dists"><div><small>Avant</small><b id="dF">–</b></div><div class="c"><small>Centre</small><b id="dC">–</b></div><div><small>Arrière</small><b id="dB">–</b></div></div>
    <div class="mapwrap"><div id="map" class="map"></div><div class="gpsline" id="gpsl">GPS…</div><div class="hint over" id="phint"></div></div>
    <div class="chips shots" id="shots"></div>
    <div class="actions">
      <button class="big primary" data-act="shot">📍 Coup ici</button>
      <button class="big greenbtn" data-act="green">⛳ Sur le green</button>
    </div>
  </div>`;

  const map = makeMap($('#map'));
  if (course) drawFeatures(map, course);
  const dyn = L.layerGroup().addTo(map);
  const me = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 2, fillColor: '#2196f3', fillOpacity: 1, interactive: false });
  const meAcc = L.circle([0, 0], { radius: 1, color: '#2196f3', weight: 1, fillOpacity: 0.1, interactive: false });

  const idx = () => r.seq[r.pos];
  const H = () => r.holes[idx()];
  const C = () => courseHole(r, idx());

  function updateDist() {
    const ll = GPS.fresh(), c = C();
    const g = c.green;
    if (GPS.pos) { me.setLatLng(GPS.pos.ll).addTo(map); meAcc.setLatLng(GPS.pos.ll).setRadius(GPS.pos.acc || 1).addTo(map); }
    if (!g) { $('#dC').textContent = '?'; $('#dF').textContent = $('#dB').textContent = '–'; }
    else {
      $('#dC').textContent = ll ? fmt(Geo.dist(ll, g.c), false) : '–';
      const fb = ll && Geo.frontBack(ll, g.poly);
      $('#dF').textContent = fb ? fmt(fb[0], false) : '–';
      $('#dB').textContent = fb ? fmt(fb[1], false) : '–';
    }
    const last = H().shots[H().shots.length - 1];
    let txt = S.settings.sim ? '🧪 GPS simulé (touche la carte)' : GPS.err ? '⚠️ ' + GPS.err : GPS.pos ? `GPS ±${Math.round(GPS.pos.acc)} m` : 'Recherche GPS…';
    if (last && ll && !H().greenPos) txt += ` · dernier coup → toi : ${fmt(Geo.dist(last.pos, ll))}`;
    $('#gpsl').textContent = txt;
  }

  function render(fit) {
    const h = H(), c = C(), d = derive(r, idx());
    const t = roundTotals(r);
    $('#hT').textContent = `Trou ${h.n} · Par ${h.par}`;
    const vs = t.score - t.par;
    $('#hS').textContent = `${c.hcp ? 'Hcp ' + c.hcp + ' · ' : ''}coups ${h.shots.length + d.pen}${h.putts != null ? ' + ' + h.putts + ' putt(s)' : ''} · total ${t.played ? (vs > 0 ? '+' : '') + vs : '–'}`;
    $('#phint').textContent = placeMode ? `Touche la carte pour placer ${placeMode === 'tee' ? 'le départ' : 'le centre du green'}` : '';
    $('#phint').style.display = placeMode ? '' : 'none';
    dyn.clearLayers();
    if (c.tee) L.marker(c.tee, { icon: pin('T', 'tee'), interactive: false }).addTo(dyn);
    if (c.green) L.marker(c.green.c, { icon: pin('⚑', 'flag'), interactive: false }).addTo(dyn);
    const path = d.shots.map(s => s.pos).concat(h.greenPos ? [h.greenPos] : []);
    if (path.length > 1) L.polyline(path, { color: '#ffeb3b', weight: 3, interactive: false }).addTo(dyn);
    d.shots.forEach((s, k) => {
      const club = S.clubs.find(x => x.id === s.club);
      const m = L.marker(s.pos, { icon: pin(k + 1, 'shot'), draggable: true }).addTo(dyn);
      m.on('click', () => shotSheet(k));
      m.on('dragend', async e => { const p = e.target.getLatLng(); h.shots[k].pos = [p.lat, p.lng]; await saveRound(r); render(false); });
      if (club && s.dist) m.bindTooltip(`${club.name} · ${fmt(s.dist)}`, { direction: 'top', offset: [0, -12] });
    });
    if (h.greenPos) {
      const gm = L.marker(h.greenPos, { icon: pin('●', 'ball'), draggable: true }).addTo(dyn);
      gm.on('dragend', async e => { const p = e.target.getLatLng(); h.greenPos = [p.lat, p.lng]; await saveRound(r); render(false); });
    }
    $('#shots').innerHTML = d.shots.map((s, k) => {
      const club = S.clubs.find(x => x.id === s.club);
      return `<button class="chip shotchip" data-act="edit" data-arg="${k}" style="border-color:${club ? club.color : '#888'}">
        <b>${k + 1}</b> ${esc(club ? club.name : '?')}${s.pen ? ` <span class="pen">+${s.pen}</span>` : ''}${s.miss ? ' ✗' : ''}<small>${s.dist ? fmt(s.dist) : ''}</small></button>`;
    }).join('') + (h.putts != null ? `<button class="chip shotchip" data-act="green"><b>⛳</b> ${h.putts} putt(s)<small>${h.firstPutt ? fmt(h.firstPutt) : ''}</small></button>` : '')
      + (h.picked ? '<span class="chip">Ramassée</span>' : '') + (!d.shots.length && h.putts == null ? '<span class="muted small">Touche « Coup ici » à l’endroit où tu tapes la balle.</span>' : '');
    if (fit) {
      const pts = [c.tee, c.green && c.green.c, ...h.shots.map(s => s.pos)].filter(Boolean);
      if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 18 });
      else if (pts.length) map.setView(pts[0], 17);
      else if (GPS.pos) map.setView(GPS.pos.ll, 17);
      else if (course) map.setView(course.center, 16);
      if (S.settings.sim && !GPS.pos) { const p = c.tee || (course && course.center); if (p) GPS.set(p, 3); }
    }
    updateDist();
  }

  function shotSheet(k, isNew) {
    const h = H(), c = C();
    const s = h.shots[k];
    const remaining = c.green ? Geo.dist(s.pos, c.green.c) : null;
    const clubs = [...S.clubs];
    if (remaining != null) clubs.sort((a, b) => Math.abs(expected(a) - remaining) - Math.abs(expected(b) - remaining));
    const draw = () => openSheet(`
      <div class="line"><b>Coup ${k + 1}</b><span class="grow"></span>${remaining != null ? 'reste ' + fmt(remaining) : ''}</div>
      <div class="seg">${LIES.map(([v, l]) => `<button class="${s.lie === v ? 'on' : ''}" data-act="lie" data-arg="${v}">${l}</button>`).join('')}</div>
      <div class="seg">${KINDS.map(([v, l]) => `<button class="${(s.kind || 'plein') === v ? 'on' : ''}" data-act="kind" data-arg="${v}">${l}</button>`).join('')}
        <button class="${s.miss ? 'on bad' : ''}" data-act="miss">Raté</button></div>
      <div class="seg">${[0, 1, 2].map(p => `<button class="${(s.pen || 0) === p ? 'on' + (p ? ' bad' : '') : ''}" data-act="pen" data-arg="${p}">${p ? 'Pénalité +' + p : 'Sans pénalité'}</button>`).join('')}</div>
      <p class="hint">Choisis le club pour valider :</p>
      <div class="clubs">${clubs.map(cl => `<button class="club ${s.club === cl.id ? 'on' : ''}" data-act="club" data-arg="${cl.id}" style="--c:${cl.color}">
        ${esc(cl.name)}<small>${fmt(expected(cl))}</small></button>`).join('')}</div>
      <div class="row2">
        ${isNew ? '<button class="btn danger" data-act="del">Annuler ce coup</button>' : `<button class="btn danger" data-act="del">Supprimer</button><button class="btn" data-act="ins">Insérer avant</button>`}
        ${!isNew ? '<button class="btn" data-act="close">Fermer</button>' : ''}
      </div>`, {
      lie: v => { s.lie = v; draw(); },
      kind: v => { s.kind = v; draw(); },
      miss: () => { s.miss = !s.miss; draw(); },
      pen: p => { s.pen = +p; draw(); },
      club: async id => { s.club = id; closeSheet(); await saveRound(r); render(false); },
      del: async () => { h.shots.splice(k, 1); closeSheet(); await saveRound(r); render(false); },
      ins: async () => {
        const prev = h.shots[k - 1];
        const at = Geo.mid(prev ? prev.pos : (c.tee || s.pos), s.pos);
        h.shots.splice(k, 0, { id: uid(), pos: at, club: null, lie: k === 0 ? 'tee' : lieAt(course, at, c), pen: 0, kind: 'plein', miss: false, t: Date.now() });
        if (k === 0) s.lie = lieAt(course, s.pos, c);
        closeSheet(); await saveRound(r); render(false); shotSheet(k, false);
      },
      __close: async () => { closeSheet(); await saveRound(r); render(false); },
    });
    draw();
  }

  function greenSheet() {
    const h = H(), c = C();
    const ll = GPS.fresh();
    if (h.putts == null && ll) h.greenPos = ll;
    let putts = h.putts ?? 2;
    let fp = h.firstPutt ?? (h.greenPos && c.green ? Math.max(1, Math.round(Geo.dist(h.greenPos, c.green.c))) : 5);
    const draw = () => openSheet(`
      <h3>Sur le green · trou ${h.n}</h3>
      <label>Distance du 1er putt (≈ ${Math.round(fp / 0.8)} pas)</label>
      <div class="stepper"><button data-act="fp" data-arg="-1">−</button><b>${fmt(fp)}</b><button data-act="fp" data-arg="1">+</button></div>
      <label>Nombre de putts — touche pour valider le trou</label>
      <div class="putts">${[0, 1, 2, 3, 4].map(p => `<button class="${h.putts === p ? 'on' : ''}" data-act="putts" data-arg="${p}">${p}</button>`).join('')}</div>
      <p class="hint">0 = balle rentrée depuis l’extérieur du green.</p>
      <div class="row2"><button class="btn" data-act="pick">Ramasser la balle</button><button class="btn" data-act="close">Annuler</button></div>`, {
      fp: d => { fp = Math.max(0, fp + +d); draw(); },
      putts: async p => {
        h.putts = +p; h.firstPutt = +p === 0 ? null : fp; h.picked = false;
        if (+p === 0) h.greenPos = null;
        closeSheet(); await saveRound(r); finishHole();
      },
      pick: async () => { h.picked = true; h.putts = null; closeSheet(); await saveRound(r); finishHole(); },
    });
    draw();
  }

  async function finishHole() {
    const d = derive(r, idx()), h = H();
    if (d.score != null) {
      const diff = d.score - h.par;
      toast(`Trou ${h.n} : ${d.score} (${diff === 0 ? 'par' : (diff > 0 ? '+' : '') + diff})`);
    }
    if (r.pos < r.seq.length - 1) { r.pos++; await saveRound(r); render(true); }
    else { render(false); location.hash = '#/card/' + r.id; }
  }

  bind(app(), {
    prev: async () => { if (r.pos > 0) { r.pos--; placeMode = null; await saveRound(r); render(true); } },
    next: async () => { if (r.pos < r.seq.length - 1) { r.pos++; placeMode = null; await saveRound(r); render(true); } },
    card: () => (location.hash = '#/card/' + r.id),
    shot: async () => {
      const ll = GPS.fresh();
      if (!ll) { toast(S.settings.sim ? 'Touche d’abord la carte pour simuler ta position' : 'Position GPS pas encore disponible…'); return; }
      const h = H();
      const k = h.shots.length;
      if (h.putts != null || h.picked) { if (!(await ask('Ce trou est terminé. Ajouter quand même un coup ?', 'Ajouter'))) return; h.putts = null; h.picked = false; }
      h.greenPos = null;
      h.shots.push({ id: uid(), pos: ll, club: null, lie: k === 0 ? 'tee' : lieAt(course, ll, C()), pen: 0, kind: 'plein', miss: false, t: Date.now() });
      await saveRound(r); render(false); shotSheet(k, true);
    },
    edit: k => shotSheet(+k),
    green: () => greenSheet(),
    menu: () => openSheet(`
      <button class="btn wide" data-act="card">📋 Carte de score</button>
      <button class="btn wide" data-act="place" data-arg="green">⚑ Placer / corriger le green de ce trou</button>
      <button class="btn wide" data-act="place" data-arg="tee">T Placer / corriger le départ de ce trou</button>
      <button class="btn wide" data-act="sim">${S.settings.sim ? '📡 Revenir au vrai GPS' : '🧪 Simuler le GPS (test)'}</button>
      <button class="btn wide" data-act="home">🏠 Accueil (la partie reste ouverte)</button>
      <button class="btn wide" data-act="close">Fermer</button>`, {
      card: () => { closeSheet(); location.hash = '#/card/' + r.id; },
      place: m => { closeSheet(); placeMode = m; render(false); },
      sim: async () => { S.settings.sim = !S.settings.sim; await saveSettings(); closeSheet(); GPS.pos = null; GPS.emit(); render(true); },
      home: () => { closeSheet(); location.hash = '#/home'; },
    }),
  });

  map.on('click', async e => {
    const ll = [e.latlng.lat, e.latlng.lng];
    if (placeMode && course) {
      const c = course.holes[idx()];
      if (placeMode === 'tee') c.tee = ll;
      else {
        const g = (course.features || []).find(f => f.kind === 'green' && Geo.inPoly(ll, f.poly));
        c.green = g ? { c: Geo.centroid(g.poly), poly: g.poly } : { c: ll, poly: null };
      }
      c.line = null; placeMode = null; await saveCourse(course); render(false); return;
    }
    if (S.settings.sim) GPS.set(ll, 3);
  });

  S.cleanup.push(GPS.on(updateDist));
  // Garder l'écran allumé pendant la partie.
  let lock = null;
  const getLock = async () => { try { if (S.settings.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ } };
  const onVis = () => { if (document.visibilityState === 'visible') getLock(); };
  document.addEventListener('visibilitychange', onVis);
  getLock();
  S.cleanup.push(() => { document.removeEventListener('visibilitychange', onVis); if (lock) lock.release().catch(() => {}); });

  render(true);
}

/* ----- Carte de score ----- */
async function viewCard(id) {
  const r = await DB.get('rounds', id);
  if (!r) { location.hash = '#/home'; return; }
  const t = roundTotals(r), a = analyze([r]);
  const rows = (from, to) => r.holes.slice(from, to).map((h, j) => {
    const i = from + j, d = derive(r, i);
    const sc = d.score, diff = sc != null ? sc - h.par : null;
    const cls = diff == null ? '' : diff <= -2 ? 'eagle' : diff === -1 ? 'birdie' : diff === 0 ? 'par' : diff === 1 ? 'bogey' : 'dbl';
    const pts = d.finished ? (h.picked ? 0 : Math.max(0, h.par + t.rec[i] - sc + 2)) : '';
    return `<tr data-act="hole" data-arg="${i}"><td>${h.n}</td><td>${h.par}</td><td><span class="sc ${cls}">${h.picked ? 'X' : sc ?? ''}</span></td>
      <td>${h.putts ?? ''}</td><td>${d.pen || ''}</td><td>${d.fir == null ? '' : d.fir ? '✓' : d.firSide === 'G' ? '←' : '→'}</td><td>${d.gir ? '✓' : ''}</td><td>${pts}</td></tr>`;
  }).join('');
  const sum = (from, to) => {
    let s = 0, p = 0, pu = 0;
    r.holes.slice(from, to).forEach((h, j) => { const d = derive(r, from + j); p += h.par; if (d.score != null) s += d.score; pu += h.putts || 0; });
    return `<tr class="sum"><td>${from ? 'In' : r.holes.length > 9 ? 'Out' : 'Total'}</td><td>${p}</td><td>${s || ''}</td><td>${pu || ''}</td><td colspan="4"></td></tr>`;
  };
  const vs = t.score - t.par;
  app().innerHTML = `
  <div class="page">
    <div class="top"><button class="icon" data-act="back">←</button><h2 class="grow">${esc(r.courseName)}</h2></div>
    <p class="muted">${new Date(r.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · hcp de jeu ${r.phcp}</p>
    <div class="kpis">
      <div><b>${t.played ? t.score : '–'}</b><small>Score${t.played ? ` (${vs > 0 ? '+' : ''}${vs})` : ''}</small></div>
      <div><b>${t.stb}</b><small>Stableford</small></div>
      <div><b>${t.putts}</b><small>Putts</small></div>
      <div><b>${pct(a.fwH, a.fwE)}</b><small>Fairways</small></div>
      <div><b>${pct(a.gir, a.girE)}</b><small>GIR</small></div>
      <div><b>${t.pen}</b><small>Pénalités</small></div>
    </div>
    <table class="card"><thead><tr><th>Trou</th><th>Par</th><th>Score</th><th>Putts</th><th>Pén.</th><th>Fw</th><th>GIR</th><th>Pts</th></tr></thead>
    <tbody>${rows(0, Math.min(9, r.holes.length))}${sum(0, Math.min(9, r.holes.length))}${r.holes.length > 9 ? rows(9, r.holes.length) + sum(9, r.holes.length) : ''}</tbody></table>
    ${r.done ? '' : '<button class="big primary" data-act="resume">▶ Continuer la partie</button><button class="btn wide" data-act="finish">🏁 Terminer la partie</button>'}
    <button class="btn wide" data-act="backup">💾 Sauvegarder vers Proton Drive</button>
    <button class="btn wide danger" data-act="del">🗑 Supprimer cette partie</button>
  </div>`;
  bind(app(), {
    back: () => (location.hash = r.done ? '#/history' : '#/play/' + r.id),
    hole: async i => { if (r.done) return; r.pos = Math.max(0, r.seq.indexOf(+i)); await saveRound(r); location.hash = '#/play/' + r.id; },
    resume: () => (location.hash = '#/play/' + r.id),
    finish: async () => {
      r.done = true; await saveRound(r);
      if (await ask('Partie terminée ! Sauvegarder maintenant vers Proton Drive ?', 'Sauvegarder')) await backup();
      viewCard(id);
    },
    backup: () => backup(),
    del: async () => { if (await ask('Supprimer définitivement cette partie ?', 'Supprimer', true)) { await DB.del('rounds', r.id); location.hash = '#/history'; } },
  });
}

/* ----- Historique ----- */
async function viewHistory() {
  const rounds = (await DB.all('rounds')).sort((a, b) => b.date.localeCompare(a.date));
  app().innerHTML = `
  <div class="page">
    <div class="top"><button class="icon" data-act="home">←</button><h2>Historique</h2></div>
    ${rounds.length ? rounds.map(r => { const t = roundTotals(r); const vs = t.score - t.par;
      return `<button class="item" data-act="open" data-arg="${r.id}"><b>${esc(r.courseName)}${r.done ? '' : ' <span class="tag">en cours</span>'}</b>
        <small>${new Date(r.date).toLocaleDateString('fr-FR')} · ${t.played} trous · ${t.played ? t.score + ' (' + (vs > 0 ? '+' : '') + vs + ')' : '–'} · ${t.stb} pts</small></button>`; }).join('')
      : '<p class="muted">Aucune partie pour l’instant.</p>'}
  </div>`;
  bind(app(), { home: () => (location.hash = '#/home'), open: id => (location.hash = '#/card/' + id) });
}

/* ----- Statistiques ----- */
async function viewStats(nArg) {
  const n = nArg === 'all' ? Infinity : +(nArg || 10);
  const all = (await DB.all('rounds')).sort((a, b) => b.date.localeCompare(a.date));
  const rounds = all.slice(0, n);
  const a = analyze(rounds);
  const samples = clubSamples(rounds);
  const fullR = a.holes / 18;
  app().innerHTML = `
  <div class="page">
    <div class="top"><button class="icon" data-act="home">←</button><h2>Statistiques</h2></div>
    <div class="seg">${[['5', '5 parties'], ['10', '10'], ['20', '20'], ['all', 'Toutes']].map(([v, l]) => `<button class="${String(nArg || '10') === v ? 'on' : ''}" data-act="n" data-arg="${v}">${l}</button>`).join('')}</div>
    <p class="muted">${rounds.length} partie(s), ${a.holes} trous joués. Moyennes ramenées à 18 trous.</p>
    <div class="kpis">
      <div><b>${a.fullRounds ? Math.round(a.fullScore / a.fullRounds) : '–'}</b><small>Score moyen${a.fullRounds ? ` (+${Math.round((a.fullScore - a.fullPar) / a.fullRounds)})` : ''}</small></div>
      <div><b>${a.fullRounds ? Math.round(a.stb / a.fullRounds) : '–'}</b><small>Stableford moyen</small></div>
      <div><b>${one(a.putts, fullR)}</b><small>Putts / 18 trous</small></div>
      <div><b>${pct(a.fwH, a.fwE)}</b><small>Fairways</small></div>
      <div><b>${pct(a.gir, a.girE)}</b><small>Greens en régul.</small></div>
      <div><b>${pct(a.scr, a.scrE)}</b><small>Scrambling</small></div>
      <div><b>${one(a.three, fullR)}</b><small>3-putts / 18 trous</small></div>
      <div><b>${one(a.pen, fullR)}</b><small>Pénalités / 18 trous</small></div>
      <div><b>${a.fwE ? `${pct(a.fwL, a.fwE)} · ${pct(a.fwR, a.fwE)}` : '–'}</b><small>Ratés gauche · droite</small></div>
    </div>
    <h3>Distances par club</h3>
    <p class="muted small">Coups pleins seulement : les coups ratés, avec pénalité, en recovery ou de type chip/punch/lob sont exclus.</p>
    <table class="card clubs-t"><thead><tr><th>Club</th><th>Coups</th><th>Moy.</th><th>Méd.</th><th>Min</th><th>Max</th><th>Cible</th></tr></thead><tbody>
    ${S.clubs.map(c => { const s = samples[c.id] || []; const avg = s.length ? s.reduce((x, y) => x + y, 0) / s.length : null;
      return `<tr><td><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</td><td>${s.length || ''}</td><td>${s.length ? fmt(avg, false) : ''}</td>
        <td><b>${s.length ? fmt(median(s), false) : ''}</b></td><td>${s.length ? fmt(Math.min(...s), false) : ''}</td><td>${s.length ? fmt(Math.max(...s), false) : ''}</td><td class="muted">${fmt(c.target, false)}</td></tr>`; }).join('')}
    </tbody></table>
    <p class="muted small">Distances en ${unitLabel()}. Dès 3 coups enregistrés, la médiane remplace ta distance cible pour suggérer le club.</p>
  </div>`;
  bind(app(), { home: () => (location.hash = '#/home'), n: v => (location.hash = '#/stats/' + v) });
}

/* ----- Réglages ----- */
function viewSettings() {
  const st = S.settings;
  app().innerHTML = `
  <div class="page">
    <div class="top"><button class="icon" data-act="home">←</button><h2>Réglages</h2></div>
    <h3>Affichage</h3>
    <div class="line">Unités <span class="grow"></span><span class="seg mini">${[['m', 'Mètres'], ['yd', 'Yards']].map(([v, l]) => `<button class="${st.unit === v ? 'on' : ''}" data-act="unit" data-arg="${v}">${l}</button>`).join('')}</span></div>
    <div class="line">Thème <span class="grow"></span><span class="seg mini">${[['dark', 'Sombre'], ['light', 'Plein soleil']].map(([v, l]) => `<button class="${st.theme === v ? 'on' : ''}" data-act="theme" data-arg="${v}">${l}</button>`).join('')}</span></div>
    <div class="line">Garder l’écran allumé en partie <span class="grow"></span><button class="btn small ${st.wake ? 'primary' : ''}" data-act="wake">${st.wake ? 'Oui' : 'Non'}</button></div>
    <div class="line">Index <span class="grow"></span><input class="num" id="idx" type="number" step="0.1" inputmode="decimal" value="${st.index}"></div>
    <div class="line">GPS simulé (pour tester chez soi) <span class="grow"></span><button class="btn small ${st.sim ? 'primary' : ''}" data-act="sim">${st.sim ? 'Activé' : 'Désactivé'}</button></div>

    <h3>Mon sac</h3>
    <p class="muted small">Distance cible en mètres. Utilise ↑ ↓ pour l’ordre.</p>
    <div id="bag">${S.clubs.map((c, i) => `<div class="bagrow">
      <input type="color" value="${c.color}" data-i="${i}" data-f="color">
      <input class="name" value="${esc(c.name)}" data-i="${i}" data-f="name">
      <input class="num" type="number" inputmode="numeric" value="${c.target}" data-i="${i}" data-f="target">
      <button class="icon s" data-act="up" data-arg="${i}">↑</button><button class="icon s" data-act="down" data-arg="${i}">↓</button>
      <button class="icon s" data-act="rm" data-arg="${i}">✕</button></div>`).join('')}</div>
    <button class="btn wide" data-act="add">＋ Ajouter un club</button>

    <h3>Données</h3>
    <p class="muted small">Dernière sauvegarde : ${st.lastBackup ? new Date(st.lastBackup).toLocaleString('fr-FR') : 'jamais'}</p>
    <button class="btn wide primary" data-act="backup">💾 Sauvegarder (→ Proton Drive)</button>
    <button class="btn wide" data-act="restore">📂 Restaurer une sauvegarde</button>
    <button class="btn wide" data-act="csv">📄 Exporter les coups en CSV</button>
    <input type="file" id="file" accept=".json,.txt,application/json,text/plain" hidden>
    <p class="muted small">Golf Tracker v${APP_VERSION} · cartes © Esri, données parcours © contributeurs OpenStreetMap.</p>
  </div>`;
  const rerender = () => viewSettings();
  $('#bag').onchange = async e => {
    const el = e.target, i = +el.dataset.i, f = el.dataset.f; if (!f) return;
    S.clubs[i][f] = f === 'target' ? parseInt(el.value, 10) || 0 : el.value;
    await saveClubs();
  };
  $('#idx').onchange = async e => { st.index = parseFloat(String(e.target.value).replace(',', '.')) || 0; await saveSettings(); };
  $('#file').onchange = async e => { const f = e.target.files[0]; if (f) await restore(f); e.target.value = ''; };
  bind(app(), {
    home: () => (location.hash = '#/home'),
    unit: v => { st.unit = v; saveSettings().then(rerender); },
    theme: v => { st.theme = v; saveSettings().then(rerender); },
    wake: () => { st.wake = !st.wake; saveSettings().then(rerender); },
    sim: () => { st.sim = !st.sim; GPS.pos = null; saveSettings().then(rerender); },
    up: i => { i = +i; if (i > 0) { [S.clubs[i - 1], S.clubs[i]] = [S.clubs[i], S.clubs[i - 1]]; saveClubs().then(rerender); } },
    down: i => { i = +i; if (i < S.clubs.length - 1) { [S.clubs[i + 1], S.clubs[i]] = [S.clubs[i], S.clubs[i + 1]]; saveClubs().then(rerender); } },
    rm: async i => { if (await ask(`Retirer « ${S.clubs[+i].name} » du sac ? Les coups déjà joués restent enregistrés.`, 'Retirer', true)) { S.clubs.splice(+i, 1); await saveClubs(); rerender(); } },
    add: () => { S.clubs.push({ id: 'c' + uid(), name: 'Nouveau club', target: 100, color: COLORS[S.clubs.length % COLORS.length] }); saveClubs().then(rerender); },
    backup: () => backup().then(rerender),
    restore: () => $('#file').click(),
    csv: () => exportCsv(),
  });
}

/* ---------- Sauvegarde / restauration / export ---------- */
async function shareOrDownload(text, base, exts) {
  for (const [ext, type] of exts) {
    const f = new File([text], `${base}.${ext}`, { type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: base }); return true; }
      catch (e) { if (e.name === 'AbortError') return false; }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: exts[0][1] }));
  a.download = `${base}.${exts[0][0]}`; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return true;
}
async function backup() {
  const data = { app: 'golftrack', v: 1, date: new Date().toISOString(), settings: S.settings, clubs: S.clubs,
    courses: await DB.all('courses'), rounds: await DB.all('rounds') };
  const ok = await shareOrDownload(JSON.stringify(data), 'golf-sauvegarde-' + today(), [['json', 'application/json'], ['txt', 'text/plain']]);
  if (ok) { S.settings.lastBackup = Date.now(); await saveSettings(); toast('Sauvegarde envoyée ✔'); }
}
async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('Fichier illisible'); return; }
  if (data.app !== 'golftrack') { toast('Ce fichier n’est pas une sauvegarde Golf Tracker'); return; }
  if (!(await ask(`Restaurer la sauvegarde du ${new Date(data.date).toLocaleString('fr-FR')} ? Les données actuelles du téléphone seront remplacées.`, 'Restaurer', true))) return;
  await DB.clear('courses'); await DB.clear('rounds');
  for (const c of data.courses || []) await DB.put('courses', c);
  for (const r of data.rounds || []) await DB.put('rounds', r);
  S.settings = { ...DEFAULT_SETTINGS, ...data.settings, sim: false }; S.clubs = data.clubs || DEFAULT_CLUBS;
  await saveSettings(); await saveClubs();
  await loadCourses();
  toast('Sauvegarde restaurée ✔'); location.hash = '#/home';
}
async function exportCsv() {
  const rounds = (await DB.all('rounds')).sort((a, b) => a.date.localeCompare(b.date));
  const head = ['date', 'parcours', 'trou', 'par', 'coup', 'club', 'lie', 'resultat', 'distance_m', 'reste_avant_m', 'penalite', 'type', 'rate', 'lat', 'lon'];
  const lines = [head.join(';')];
  const q = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  for (const r of rounds) r.holes.forEach((H, i) => {
    const c = courseHole(r, i), d = derive(r, i);
    d.shots.forEach((s, k) => {
      const club = S.clubs.find(x => x.id === s.club);
      lines.push([r.date.slice(0, 10), r.courseName, H.n, H.par, k + 1, club ? club.name : '', s.lie, s.result || '',
        s.dist != null ? Math.round(s.dist) : '', c.green ? Math.round(Geo.dist(s.pos, c.green.c)) : '', s.pen || 0, s.kind || 'plein', s.miss ? 1 : 0,
        s.pos[0].toFixed(6), s.pos[1].toFixed(6)].map(q).join(';'));
    });
    if (H.putts != null) lines.push([r.date.slice(0, 10), r.courseName, H.n, H.par, 'putts', 'Putter', 'green', H.putts + ' putt(s)',
      H.firstPutt ?? '', '', 0, 'putt', 0, '', ''].map(q).join(';'));
  });
  await shareOrDownload('﻿' + lines.join('\n'), 'golf-coups-' + today(), [['csv', 'text/csv']]);
}

/* ---------- Routeur ---------- */
const APP_VERSION = '1.0.0';
async function loadCourses() { S.courses = {}; for (const c of await DB.all('courses')) S.courses[c.id] = c; }
function cleanup() {
  closeSheet();
  S.cleanup.forEach(f => f()); S.cleanup = [];
  if (S.map) { S.map.remove(); S.map = null; }
}
async function route() {
  cleanup();
  const [, v, arg] = (location.hash || '#/home').split('/');
  const views = { home: viewHome, courses: viewCourses, course: viewCourse, play: viewPlay, card: viewCard, history: viewHistory, stats: viewStats, settings: viewSettings };
  try { await (views[v] || viewHome)(arg); window.scrollTo(0, 0); }
  catch (e) { console.error(e); app().innerHTML = `<div class="page"><p class="err">Erreur : ${esc(e.message)}</p><button class="btn" onclick="location.hash='#/home'">Accueil</button></div>`; }
}

(async function init() {
  S.settings = { ...DEFAULT_SETTINGS, ...((await DB.get('kv', 'settings')) || {}) };
  S.clubs = (await DB.get('kv', 'clubs')) || DEFAULT_CLUBS.map(c => ({ ...c }));
  applyTheme();
  await loadCourses();
  if (/[?&]sim\b/.test(location.search)) { S.settings.sim = true; await saveSettings(); }
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
