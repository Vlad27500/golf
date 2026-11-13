/* Récupération des parcours depuis OpenStreetMap (Overpass + Nominatim). */
const OSM = (() => {
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];

  async function overpass(q, timeoutMs = 45000) {
    let lastErr;
    for (const ep of ENDPOINTS) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        return j.elements || [];
      } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
    }
    throw new Error('Serveurs OpenStreetMap indisponibles, réessaie dans quelques minutes. (' + (lastErr && lastErr.message) + ')');
  }

  async function nearby(lat, lon, radius = 30000) {
    const els = await overpass(`[out:json][timeout:25];nwr[leisure=golf_course](around:${radius},${lat},${lon});out tags center;`, 30000);
    return els.map(e => {
      const c = e.center || { lat: e.lat, lon: e.lon };
      return { type: e.type, id: e.id, name: (e.tags && e.tags.name) || 'Golf sans nom', lat: c.lat, lon: c.lon,
        dist: Geo.dist([lat, lon], [c.lat, c.lon]) };
    }).filter(e => e.type !== 'node').sort((a, b) => a.dist - b.dist);
  }

  async function search(text) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=15&q=' + encodeURIComponent('golf ' + text);
    const r = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
    if (!r.ok) throw new Error('Recherche indisponible (HTTP ' + r.status + ')');
    const res = await r.json();
    const golf = res.filter(x => x.type === 'golf_course' && x.osm_type !== 'node');
    return (golf.length ? golf : res.filter(x => x.osm_type !== 'node')).map(x => ({
      type: x.osm_type, id: x.osm_id, name: x.name || x.display_name.split(',')[0],
      detail: x.display_name.split(',').slice(1, 4).join(','), lat: +x.lat, lon: +x.lon }));
  }

  function geomOf(el) {
    if (el.type === 'way' && el.geometry) return el.geometry.filter(Boolean).map(g => [g.lat, g.lon]);
    if (el.type === 'relation' && el.members) {
      let best = [];
      for (const m of el.members) {
        if (m.geometry && (m.role === 'outer' || m.role === '') && m.geometry.length > best.length) best = m.geometry;
      }
      return best.filter(Boolean).map(g => [g.lat, g.lon]);
    }
    if (el.type === 'node') return [[el.lat, el.lon]];
    return [];
  }

  const KIND = { green: 'green', tee: 'tee', fairway: 'fairway', bunker: 'bunker', rough: 'rough',
    water_hazard: 'water', lateral_water_hazard: 'water', driving_range: 'range' };

  async function loadCourse(type, id, name) {
    const base = await overpass(`[out:json][timeout:60];${type}(${id});out geom;`);
    const c = base[0];
    if (!c) throw new Error('Parcours introuvable dans OpenStreetMap.');
    const outline = geomOf(c);
    let b = c.bounds;
    if (!b && outline.length) { const x = Geo.bbox(outline); b = { minlat: x[0], minlon: x[1], maxlat: x[2], maxlon: x[3] }; }
    if (!b) throw new Error('Contour du parcours introuvable.');
    const pad = 0.0015; // ~150 m
    const bb = [b.minlat - pad, b.minlon - pad, b.maxlat + pad, b.maxlon + pad].map(v => v.toFixed(6)).join(',');
    const els = await overpass(`[out:json][timeout:90];(nwr[golf](${bb});way[natural=water](${bb});relation[natural=water](${bb}););out geom;`, 90000);

    const features = [], holeWays = [];
    for (const el of els) {
      const t = el.tags || {};
      const g = geomOf(el);
      if (t.golf === 'hole') { if (g.length >= 2) holeWays.push({ tags: t, line: g }); continue; }
      const kind = t.natural === 'water' ? 'water' : KIND[t.golf];
      if (kind && g.length >= 3) features.push({ kind, poly: g });
    }
    // Ne garder que ce qui est dans (ou tout près de) l'emprise du golf.
    const m = 0.0006; // ~60 m de marge
    const inCourse = p => p[0] >= b.minlat - m && p[0] <= b.maxlat + m && p[1] >= b.minlon - m && p[1] <= b.maxlon + m;
    const feats = features.filter(f => inCourse(Geo.centroid(f.poly)));
    const greens = feats.filter(f => f.kind === 'green');

    const holes = [];
    for (const hw of holeWays) {
      const n = parseInt(String(hw.tags.ref || '').split(/[;,]/)[0], 10);
      if (!n || !inCourse(hw.line[0])) continue;
      const tee = hw.line[0], end = hw.line[hw.line.length - 1];
      let green = greens.find(g => Geo.inPoly(end, g.poly));
      if (!green) {
        let best = null, bd = 80;
        for (const g of greens) { const d = Geo.dist(end, Geo.centroid(g.poly)); if (d < bd) { bd = d; best = g; } }
        green = best;
      }
      let length = 0;
      for (let i = 1; i < hw.line.length; i++) length += Geo.dist(hw.line[i - 1], hw.line[i]);
      let par = parseInt(hw.tags.par, 10);
      const parGuessed = !par;
      if (!par) par = length < 230 ? 3 : length < 430 ? 4 : 5;
      holes.push({ n, par, parGuessed, hcp: parseInt(hw.tags.handicap, 10) || null, tee, line: hw.line,
        green: green ? { c: Geo.centroid(green.poly), poly: green.poly } : { c: end, poly: null } });
    }
    holes.sort((a, b) => a.n - b.n);
    const uniq = [];
    for (const h of holes) if (!uniq.find(u => u.n === h.n)) uniq.push(h);

    const count = uniq.length > 9 ? 18 : uniq.length > 0 ? (uniq[uniq.length - 1].n > 9 ? 18 : 9) : 18;
    const full = [];
    for (let n = 1; n <= count; n++) full.push(uniq.find(h => h.n === n) || { n, par: 4, parGuessed: true, hcp: null, tee: null, green: null });

    const center = [(b.minlat + b.maxlat) / 2, (b.minlon + b.maxlon) / 2];
    return {
      id: type + '-' + id, name: (c.tags && c.tags.name) || name || 'Golf', osm: { type, id },
      center, bbox: [b.minlat, b.minlon, b.maxlat, b.maxlon], outline,
      holes: full, features: feats, createdAt: Date.now(),
      found: uniq.length,
    };
  }

  return { nearby, search, loadCourse };
})();
