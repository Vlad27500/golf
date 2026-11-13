/* Calculs géographiques. Les points sont des tableaux [lat, lon]. */
const Geo = {
  dist(a, b) {
    if (!a || !b) return null;
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  },
  // Distances min / max aux sommets d'un polygone (avant / arrière du green).
  frontBack(pos, poly) {
    if (!pos || !poly || poly.length < 3) return null;
    let min = Infinity, max = 0;
    for (const p of poly) { const d = Geo.dist(pos, p); if (d < min) min = d; if (d > max) max = d; }
    return [min, max];
  },
  inPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < ((xj - xi) * (pt[0] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  },
  centroid(poly) {
    let la = 0, lo = 0;
    for (const p of poly) { la += p[0]; lo += p[1]; }
    return [la / poly.length, lo / poly.length];
  },
  bbox(points) {
    let s = 90, w = 180, n = -90, e = -180;
    for (const [la, lo] of points) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
    return [s, w, n, e];
  },
  // Côté (gauche/droite) d'un point par rapport à la ligne a -> b.
  side(a, b, p) {
    const c = (b[1] - a[1]) * (p[0] - a[0]) - (b[0] - a[0]) * (p[1] - a[1]);
    return c > 0 ? 'G' : 'D';
  },
  // Distance (m) d'un point à une ligne brisée.
  distToLine(p, line) {
    if (!line || line.length < 2) return Infinity;
    const k = Math.cos((p[0] * Math.PI) / 180), M = 111320;
    const xy = q => [(q[1] - p[1]) * k * M, (q[0] - p[0]) * M];
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = xy(line[i - 1]), [bx, by] = xy(line[i]);
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  },
  mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; },
};
