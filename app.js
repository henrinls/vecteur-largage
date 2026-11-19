'use strict';
// Filet de sécurité : toute erreur s'affiche au lieu de laisser une carte vide
window.addEventListener('error', e => {
  const t = document.getElementById('toast');
  if (t) { t.textContent = 'Erreur : ' + (e.message || 'inconnue') + ' — ferme et rouvre l\'appli'; t.classList.remove('hidden'); }
});
// iPhone : après la fermeture du clavier, iOS laisse parfois la page décalée et les appuis tombent à côté de ce qu'on voit
// (ex. « −1 » de la longueur qui corrige le cap). On remet la page en place dès qu'une case perd le focus.
document.addEventListener('focusout', e => {
  if (!e.target || !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  setTimeout(() => { const a = document.activeElement; if (!a || !/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) window.scrollTo(0, 0); }, 60);
});
const VERSION = '0.9.7';
const APP_ID = 'vl';
// Fonds de carte : Esri (monde entier) ou photos aériennes IGN (France, licence ouverte : hors-ligne et PDF autorisés)
const BASEMAPS = {
  esri: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Imagerie © Esri, Maxar, Earthstar Geographics', maxNative: 19 },
  ign: { url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', attr: 'Photos aériennes © IGN – Géoplateforme', maxNative: 19 }
};
const TILE_CACHE = 'vl-tiles-v1';
// Paramètres : les « hypothèses » (valeurs arbitraires, réglables) et les réglages d'utilisation (à chaque saut)
const DEFAULT_PARAMS = {
  vff: 50, openLoss: 100, perpTime: 15, vz: 4, glide: 2.5, hMin: 300, margin: 0, sep: 300,    // hypothèses (margin : toujours 0 depuis v0.9.3, option retirée ; sep : séparation mini entre sorties, m)
  acMs: 36.0, acType: 'pc6',                                             // avion et vitesse de largage, badin (m/s ; 70 kt : Pilatus PC-6)
  hOpen: 1000, relMode: 'FL', relFL: 140, relAGL: 4000                   // utilisation
};
const PROFILE_KEYS = ['vff', 'openLoss', 'perpTime', 'vz', 'glide', 'hMin', 'margin', 'sep', 'acMs', 'acType', 'hOpen', 'relMode', 'relFL', 'relAGL'];
const C_START = '#1ec83c', C_END = '#ff2020', C_PRV = '#ffd400', C_PRVUSED = '#ff8c00', C_RELAX = '#00e5ff';
const isDark = c => c === '#000000';
const KT = 1.943844; // m/s → nœuds


// ---------- Météo en ligne (Open-Meteo, gratuit, sans compte) ----------
// Météo-France (AROME 2,5 km en France puis ARPEGE) jusqu'à J+3 ; au-delà, ECMWF (modèle mondial).
const PLEV = [1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 275, 250];
const HLEV_MF = [10, 20, 50, 100, 150, 200], HLEV_EC = [10, 100];
const pad2 = n => String(n).padStart(2, '0');
const dayStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function nowWhen() { const d = new Date(); return `${dayStr(d)}T${pad2(d.getHours())}:00`; }
function shiftWhen(w, hours) { const d = new Date(w + ':00'); d.setHours(d.getHours() + hours); return `${dayStr(d)}T${pad2(d.getHours())}:00`; }
function fmtWhen(w) { const d = new Date(w + ':00'); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}h`; }
function wxSource(date) {
  const days = Math.round((new Date(date + 'T12:00') - new Date(dayStr(new Date()) + 'T12:00')) / 864e5);
  if (days <= 3) return { kind: 'mf', name: 'Météo-France (AROME, puis ARPEGE)', base: 'https://api.open-meteo.com/v1/meteofrance', models: 'meteofrance_seamless', hlev: HLEV_MF };
  return { kind: 'ec', name: 'ECMWF IFS (mondial)', base: 'https://api.open-meteo.com/v1/forecast', models: 'ecmwf_ifs025', hlev: HLEV_EC };
}
function wxUrl(lat, lng, date, src, minimal) {
  const v = [];
  (minimal ? [10] : src.hlev).forEach(h => v.push(`wind_speed_${h}m`, `wind_direction_${h}m`));
  v.push('temperature_2m'); if (!minimal && src.kind === 'mf') [20, 50, 100, 150, 200].forEach(h => v.push(`temperature_${h}m`));
  PLEV.forEach(p => v.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `temperature_${p}hPa`, `geopotential_height_${p}hPa`));
  return `${src.base}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=${v.join(',')}&models=${src.models}` +
    `&wind_speed_unit=ms&timezone=auto&start_date=${date}&end_date=${date}`;
}
const wxKey = (zid, date) => `vl.wx.${zid || 'tmp'}.${date}`;
const wxMem = {};
function wxCached(zid, date) { const k = wxKey(zid, date); return wxMem[k] || (wxMem[k] = store.get(k, null)); }
async function wxFetch(z, date) {
  const src = wxSource(date), c = z.center && z.prvs.length ? prvCentroid(z) : z.center;
  let r = null, js = null, used = src;
  // Essais : modèle prévu, puis requête allégée, puis ECMWF (secours mondial)
  const ec = wxSource('9999-12-31'), tries = [[src, false], [src, true]].concat(src.kind === 'mf' ? [[ec, false]] : []);
  for (const [s2, minimal] of tries) {
    try { r = await fetch(wxUrl(c.lat, c.lng, date, s2, minimal)); if (r.ok) { js = await r.json(); used = s2; break; } } catch (e) { r = null; if (navigator.onLine === false) break; }
  }
  if (!js || !js.hourly) throw new Error(r ? 'HTTP ' + r.status : 'réseau');
  const rec = { date, fetched: Date.now(), model: used.name, elev: js.elevation, hourly: js.hourly };
  const k = wxKey(z.id, date); wxMem[k] = rec; store.set(k, rec);
  // ménage : on ne garde que les 4 derniers jours téléchargés de chaque zone
  try { const keepDay = z.vector && z.vector.when ? wxKey(z.id, z.vector.when.slice(0, 10)) : null; Object.keys(localStorage).filter(x => x.startsWith(`vl.wx.${z.id || 'tmp'}.`) && x !== keepDay).sort().slice(0, -4).forEach(x => store.del(x)); } catch (e) {}
  if (typeof js.elevation === 'number') { z.elevAuto = Math.round(js.elevation); }
  return rec;
}
// Profil de vent à une heure donnée : niveaux en hauteur sol (m AGL), vent (u, v vers où il souffle), température
// TEMPORAIRE (19/11/2026, demande d'Henri) : vent forcé à 0 à toutes les hauteurs, pour voir un vecteur sans vent. À retirer.
let zeroWind = (() => { try { return localStorage.getItem('vl.zeroWind') === 'true'; } catch (e) { return false; } })();
function wxProfile(rec, when, elevUsed) { const pr = wxProfileRaw(rec, when, elevUsed); if (pr && zeroWind) pr.lv.forEach(l => { l.spd = 0; l.u = 0; l.v = 0; }); return pr; }
function wxProfileRaw(rec, when, elevUsed) {
  if (!rec) return null;
  const H = rec.hourly, i = (H.time || []).indexOf(when);
  if (i < 0) return null;
  const val = k => (H[k] && typeof H[k][i] === 'number') ? H[k][i] : null;
  const lv = [];
  const add = (h, spd, dir, T, extra) => { if (spd == null || dir == null) return; const a = dir * Math.PI / 180; lv.push(Object.assign({ h, spd, dir, T, u: -spd * Math.sin(a), v: -spd * Math.cos(a) }, extra || {})); };
  const hl = Object.keys(H).filter(k => /^wind_speed_\d+m$/.test(k)).map(k => +k.match(/\d+/)[0]).sort((a, b) => a - b);
  hl.forEach(h => add(h, val(`wind_speed_${h}m`), val(`wind_direction_${h}m`), val(h === 10 ? 'temperature_2m' : `temperature_${h}m`)));
  const topH = lv.length ? lv[lv.length - 1].h : 0;
  const pz = [];
  PLEV.forEach(p => {
    const z = val(`geopotential_height_${p}hPa`); if (z == null) return;
    pz.push({ p, z });
    const h = z - elevUsed;
    if (h > topH + 30) add(h, val(`wind_speed_${p}hPa`), val(`wind_direction_${p}hPa`), val(`temperature_${p}hPa`), { p });
  });
  lv.sort((a, b) => a.h - b.h); pz.sort((a, b) => b.p - a.p);
  return lv.length ? { lv, pz, elev: elevUsed, model: rec.model, fetched: rec.fetched } : null;
}
function interpLv(prof, h, key) {
  const L = prof.lv; if (h <= L[0].h) return L[0][key]; if (h >= L[L.length - 1].h) return L[L.length - 1][key];
  for (let k = 1; k < L.length; k++) if (h <= L[k].h) { const a = L[k - 1], b = L[k], f = (h - a.h) / (b.h - a.h); return a[key] == null || b[key] == null ? (a[key] ?? b[key]) : a[key] + (b[key] - a[key]) * f; }
  return null;
}
const windAt = (prof, h) => ({ u: interpLv(prof, h, 'u'), v: interpLv(prof, h, 'v') });
const tempAt = (prof, h) => interpLv(prof, h, 'T');
const spdDir = w => ({ spd: Math.hypot(w.u, w.v), dir: n360(Math.atan2(-w.u, -w.v) * 180 / Math.PI) });

// ---------- FL ↔ hauteur sol (m AGL) ----------
// FL = altitude pression (centaines de pieds au-dessus de l'isobare 1013,25 hPa, atmosphère standard)
const stdP = hm => 1013.25 * Math.pow(1 - 0.0065 * hm / 288.15, 5.25588);              // altitude standard (m) → pression
const stdH = p => (1 - Math.pow(p / 1013.25, 1 / 5.25588)) * 288.15 / 0.0065;           // pression → altitude standard (m)
function zOfP(pz, p) { // hauteur géopotentielle (m) d'une pression, interpolée en log p
  if (!pz || pz.length < 2) return null;
  const lp = Math.log(p); let a = pz[0], b = pz[1];
  for (let k = 1; k < pz.length; k++) { b = pz[k]; a = pz[k - 1]; if (p >= b.p) break; }
  return a.z + (b.z - a.z) * (lp - Math.log(a.p)) / (Math.log(b.p) - Math.log(a.p));
}
function pOfZ(pz, z) {
  if (!pz || pz.length < 2) return null;
  let a = pz[0], b = pz[1];
  for (let k = 1; k < pz.length; k++) { b = pz[k]; a = pz[k - 1]; if (z <= b.z) break; }
  const lp = Math.log(a.p) + (Math.log(b.p) - Math.log(a.p)) * (z - a.z) / (b.z - a.z);
  return Math.exp(lp);
}
function flToAgl(fl, prof, elev) {
  const hs = fl * 100 * 0.3048;
  const z = prof ? zOfP(prof.pz, stdP(hs)) : null;
  return (z == null ? hs : z) - elev; // sans prévision : atmosphère standard
}
function aglToFl(agl, prof, elev) {
  const p = prof ? pOfZ(prof.pz, agl + elev) : null;
  return (p == null ? agl + elev : stdH(p)) / 30.48;
}

// ---------- Stockage (clés vl.* : séparées des autres applis, même site) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Enregistrement impossible sur cet appareil'); } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const clone = o => JSON.parse(JSON.stringify(o));
const SHOW_DEFAULT = { relax: true, label: true, rose: false };
function upgrade(z) {
  if (!z) return z;
  z.params = Object.assign({}, DEFAULT_PARAMS, z.params || {});
  z.show = Object.assign({}, SHOW_DEFAULT, typeof z.show === 'object' && z.show ? z.show : {});
  z.prvs = Array.isArray(z.prvs) ? z.prvs : [];
  z.axis = Object.assign({ on: false, mag: 0, both: true }, z.axis || {}); delete z.axis.ref;
  if (z.elevManual !== null && typeof z.elevManual !== 'number') z.elevManual = null;
  if (z.prvManual === undefined) z.prvManual = null;
  if (z.headingOverride === undefined) z.headingOverride = null; // cap vrai imposé à la main (appui long sur le cap)
  z.reversed = !!z.reversed;
  if (z.offsetManual === undefined) z.offsetManual = null;          // vecteur déplacé à la main (décalage latéral, m)
  if (z.tManual === undefined) z.tManual = null;
  delete z.prevVector; if (z.show) delete z.show.prev; // ancien vecteur gardé : fonction retirée (v0.4.3)
  if (typeof z.when !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:00$/.test(z.when)) z.when = nowWhen(); // date et heure du saut
  return z;
}
let zones = store.get('vl.zones', []).map(upgrade);
let current = upgrade(store.get('vl.current', null)) || newZone(null);
// La copie de base (v0.1) pouvait contenir des zones d'une autre appli : on ne garde que les zones de largage
zones = zones.filter(z => !z.target && !z.gateA);
store.set('vl.zones', zones);
if (current.target || current.gateA) current = newZone(null);

// ---------- Paramètres communs à toutes les zones ----------
let profile = store.get('vl.profile', null) || {};
PROFILE_KEYS.forEach(k => { if (profile[k] === undefined) profile[k] = DEFAULT_PARAMS[k]; });
profile.margin = 0; // option « marge » retirée (v0.9.3) : toujours 0
if (profile.acMs === 41.2) profile.acMs = DEFAULT_PARAMS.acMs; // ancien défaut 80 kt → 70 kt (v0.4.5)
if (!store.get('vl.mig.hOpen', false)) { if (+profile.hOpen === 1500) profile.hOpen = 1000; store.set('vl.mig.hOpen', true); } // ancien défaut 1 500 m → 1 000 m (v0.8.0), une seule fois
Object.keys(profile).forEach(k => { if (!PROFILE_KEYS.includes(k)) delete profile[k]; });
store.set('vl.profile', profile);
function applyProfile(z) { if (z && z.params) PROFILE_KEYS.forEach(k => { z.params[k] = profile[k]; }); }
applyProfile(current); zones.forEach(applyProfile); store.set('vl.zones', zones);

function newZone(center) {
  return upgrade({
    id: null, name: 'Nouvelle zone',
    center: center || { lat: 46.6, lng: 2.4 }, zoom: center ? 15 : 6,
    prvs: [], axis: { on: false, mag: 0, both: true }, elevManual: null,
    params: Object.assign({}, DEFAULT_PARAMS)
  });
}
function persist() {
  current.center = map.getCenter(); current.zoom = map.getZoom(); current.updated = Date.now();
  store.set('vl.current', current);
  if (current.id) {
    const i = zones.findIndex(z => z.id === current.id);
    if (i >= 0) { zones[i] = clone(current); store.set('vl.zones', zones); }
  }
}

const n360 = h => ((h % 360) + 360) % 360;
// Tous les caps affichés sont magnétiques (cap vrai − déclinaison de la zone) ; la géométrie et les vents téléchargés restent en vrai
let _dz = { k: null, v: 0 };
function declCur() { if (!current) return 0; const c = current.prvs && current.prvs.length ? prvCentroid(current) : current.center; if (!c) return 0; const k = c.lat.toFixed(2) + ',' + c.lng.toFixed(2) + ',' + current.prvs.length; if (_dz.k !== k) _dz = { k, v: declAt(current) }; return _dz.v; }
const hdgN = h => String(Math.round(n360(h - declCur())) % 360).padStart(3, '0') + '°'; // magnétique, sans suffixe (tableaux)
const hdg = h => hdgN(h) + ' M';
function cardOf(h) { h = n360(h); if (h >= 315 || h <= 45) return 'N'; if (h >= 135 && h <= 225) return 'S'; return h < 180 ? 'E' : 'O'; }
const fmt1 = v => (Math.round(v * 10) / 10).toString().replace('.', ',');
const fmtInt = v => Math.round(v).toLocaleString('fr-FR');

// ---------- Calcul du vecteur de largage ----------
// Repère local centré sur le PRV utilisé (x = Est, y = Nord, en m). Le vent (u, v) est le sens où il souffle.
const DH = 10; // pas d'intégration en hauteur (m)
function prvCentroid(z) { const P = z.prvs; return { lat: P.reduce((a, p) => a + p.lat, 0) / P.length, lng: P.reduce((a, p) => a + p.lng, 0) / P.length }; }
function elevOf(z, rec) { return typeof z.elevManual === 'number' ? z.elevManual : (rec && typeof rec.elev === 'number' ? rec.elev : (typeof z.elevAuto === 'number' ? z.elevAuto : 0)); }
function driftBetween(prof, hTop, hBot, vsink) { // déplacement dû au vent en descendant de hTop à hBot à vsink m/s
  let x = 0, y = 0;
  for (let h = hTop; h > hBot; h -= DH) { const dh = Math.min(DH, h - hBot), w = windAt(prof, h - dh / 2); x += w.u * dh / vsink; y += w.v * dh / vsink; }
  return { x, y };
}
function driftFF(prof, hTop, hBot, proj) { // dérive due au vent pendant la chute libre, avec l'accélération du début (proj.zAt)
  let x = 0, y = 0; const dt = 0.25, T = proj.fallTime(hTop - hBot);
  for (let t = 0; t < T; t += dt) { const d = Math.min(dt, T - t), w = windAt(prof, hTop - proj.zAt(t + d / 2)); x += w.u * d; y += w.v * d; }
  return { x, y, T };
}
function meanWindLow(prof, top) { let u = 0, v = 0, n = 0; for (let h = 0; h <= top; h += DH) { const w = windAt(prof, h); u += w.u; v += w.v; n++; } return { u: u / n, v: v / n }; }
function relHeight(p, prof, elev) { return p.relMode === 'AGL' ? +p.relAGL : flToAgl(+p.relFL, prof, elev); }
// PRV utilisé : choix à la main, sinon le plus au vent (vent moyen 0–300 m)
function chooseprv(z, prof) {
  if (!z.prvs.length) return null;
  if (z.prvManual && z.prvs.find(p => p.id === z.prvManual)) return { prv: z.prvs.find(p => p.id === z.prvManual), auto: false };
  if (z.prvs.length === 1 || !prof) return { prv: z.prvs[0], auto: true };
  const w = spdDir(meanWindLow(prof, 300)), a = w.dir * Math.PI / 180, f = { x: Math.sin(a), y: Math.cos(a) }, c = prvCentroid(z);
  let best = null, bs = -Infinity;
  z.prvs.forEach(p => { const v = Geo.toLocal(c, p), s = v.x * f.x + v.y * f.y; if (s > bs) { bs = s; best = p; } });
  return { prv: best, auto: true, lowWind: w };
}
function declAt(z) { const c = z.prvs.length ? prvCentroid(z) : z.center; try { return magDeclination(c.lat, c.lng, new Date()); } catch (e) { return 0; } }
// Cap de l'axe (vrai) : face au vent à la hauteur de largage, ou axe imposé, ou cap choisi à la main ; puis sens inversé si demandé
function axisHeading(z, prof, hRel, decl) {
  const wr = spdDir(windAt(prof, hRel)), into = wr.dir;
  let h = into, why = 'face au vent de largage', warn = null;
  if (z.axis.on) {
    const ax = n360(+z.axis.mag + decl);
    if (z.axis.both) { const d1 = diffB(ax, into), d2 = diffB(ax + 180, into); h = Math.abs(d1 - d2) < 0.5 ? ax : (d1 <= d2 ? ax : n360(ax + 180)); }
    else h = ax;
    why = 'axe imposé';
  }
  if (typeof z.headingOverride === 'number') { h = z.headingOverride; why = 'cap choisi à la main'; }
  if (z.reversed) { h = n360(h + 180); if (z.axis.on && !z.axis.both) warn = 'Sens inversé : la zone n\'autorise pas cet axe dans ce sens !'; }
  return { h, why, warn, windRel: wr };
}
// Projection : le para quitte l'avion à sa vitesse propre, puis la traînée le freine (frottement quadratique,
// calé sur la vitesse de chute : k = g / vff²). Renvoie la distance parcourue dans l'air, dans le sens de vol, en fonction du temps.
const projCache = {};
function projection(Vair, vff) {
  const key = Vair.toFixed(2) + '|' + vff; if (projCache[key]) return projCache[key];
  // Même calcul pour la chute : le para sort à vitesse verticale nulle et accélère (≈ 300 m les 10 premières secondes, puis ~vff)
  const g = 9.81, k = g / (vff * vff), dt = 0.05, step = 0.5, xs = [0], zs = [0];
  let x = 0, z = 0, vx = Vair, vz = 0, t = 0, next = step;
  while (t < 120) {
    const v = Math.hypot(vx, vz); vx += -k * v * vx * dt; vz += (g - k * v * vz) * dt; x += vx * dt; z += vz * dt; t += dt;
    if (t >= next - 1e-9) { xs.push(x); zs.push(z); next += step; }
  }
  const lerp = (arr, tt) => { const i = Math.min(arr.length - 1, tt / step), a0 = Math.floor(i), f = i - a0; return a0 + 1 < arr.length ? arr[a0] * (1 - f) + arr[a0 + 1] * f : arr[arr.length - 1]; };
  const T = (zs.length - 1) * step, zEnd = zs[zs.length - 1];
  return (projCache[key] = { step, xs, zs, total: x, at: tt => lerp(xs, tt),
    zAt: tt => tt <= T ? lerp(zs, tt) : zEnd + vff * (tt - T),                       // hauteur perdue après tt secondes
    fallTime: H => { if (H >= zEnd) return T + (H - zEnd) / vff; let lo = 0, hi = T; for (let n = 0; n < 40; n++) { const m = (lo + hi) / 2; if (lerp(zs, m) < H) lo = m; else hi = m; } return (lo + hi) / 2; } });
}
// Nombre de sorties sur le vecteur. Deux paras qui sortent à D secondes d'intervalle ont la même projection et traversent
// les mêmes vents aux mêmes hauteurs : une fois la projection finie, et donc à l'ouverture, ils sont séparés de D × vitesse sol
// de l'avion. Intervalle = séparation ÷ vitesse sol (règle pratique), arrondi à la seconde au-dessus.
// (Avant v0.9.2 : on exigeait la séparation dès la sortie, pendant la projection du premier → 13 s au lieu de 7 s par vent nul.)
function exitsOn(sol, prof, p) {
  const sep = +p.sep || 300, u = sol.u, wr = windAt(prof, sol.hRel), Vg = sol.tas + wr.u * u.x + wr.v * u.y; // vitesse sol le long de l'axe
  if (!(Vg > 3)) return { n: 1, dt: null, s: null, Vg, sep };
  const D = Math.ceil(sep / Vg - 1e-9), sp = Vg * D;
  return { n: Math.floor(sol.length / sp + 1e-6) + 1, dt: D, s: sp, Vg, sep };
}
function solve(z, prof, rec) {
  const p = z.params, elev = elevOf(z, rec), out = { ok: false };
  const ch = chooseprv(z, prof); if (!ch) { out.err = 'Place au moins un point de rendez-vous (onglet Zones).'; return out; }
  out.prv = ch.prv; out.prvAuto = ch.auto;
  if (!prof) { out.err = 'Pas de prévision météo pour cette date et cette heure.'; return out; }
  const decl = declAt(z), hRel = relHeight(p, prof, elev), hOpen = +p.hOpen;
  const Va = (+p.vz) * (+p.glide), h1 = hOpen - (+p.openLoss), h2 = h1 - (+p.vz) * (+p.perpTime), hMin = +p.hMin;
  Object.assign(out, { decl, elev, hRel, flRel: aglToFl(hRel, prof, elev), Va });
  if (!(hRel > hOpen)) { out.err = 'La hauteur de largage doit être au-dessus de la hauteur d\'ouverture.'; return out; }
  if (!(h2 > hMin)) { out.err = 'Plus assez de hauteur sous voile pour rejoindre le PRV (vérifie ouverture et hypothèses).'; return out; }
  const ax = axisHeading(z, prof, hRel, decl), H = ax.h * Math.PI / 180;
  Object.assign(out, { heading: ax.h, why: ax.why, warn: ax.warn, windRel: ax.windRel });
  const u = { x: Math.sin(H), y: Math.cos(H) }, r = { x: Math.cos(H), y: -Math.sin(H) };
  // 1) chute libre + ouverture (vitesse de chute), 2) 15 s perpendiculaire à l'axe, 3) navigation vers le PRV
  // Chute libre : dérive due au vent + projection (vitesse de l'avion), dans le sens de vol
  // La vitesse saisie est une vitesse badin (indiquée) : on la convertit en vitesse vraie à la hauteur de largage
  const pRel = 1013.25 * Math.pow(1 - 0.0065 * (out.flRel * 30.48) / 288.15, 5.25588), tRel = tempAt(prof, hRel), TK = (tRel == null ? 15 - 0.0065 * (hRel + elev) : tRel) + 273.15;
  const rho = pRel * 100 / (287.05 * TK), tas = (+p.acMs || 0) * Math.sqrt(1.225 / rho);
  out.tas = tas;
  const proj = projection(tas, +p.vff);
  // Chute libre jusqu'à la hauteur d'ouverture, puis ouverture : freinage régulier de vff à vz sur la perte à l'ouverture (Henri : ~50 → 4 m/s sur 100 m)
  const dF = driftFF(prof, hRel, hOpen, proj), tOpen = h1 < hOpen ? 2 * (hOpen - h1) / ((+p.vff) + (+p.vz)) : 0;
  let oX = 0, oY = 0; for (let t = 0; t < tOpen; t += 0.25) { const d = Math.min(0.25, tOpen - t), f = (t + d / 2) / tOpen, v0 = +p.vff, v1 = +p.vz;
    const hh = hOpen - (v0 * (t + d / 2) - (v0 - v1) * (t + d / 2) * f / 2), w = windAt(prof, Math.max(h1, hh)); oX += w.u * d; oY += w.v * d; }
  const dW = { x: dF.x + oX, y: dF.y + oY, T: dF.T };
  const dFF = { x: dW.x + proj.total * u.x, y: dW.y + proj.total * u.y };
  out.throwDist = proj.total; out.dW = dW; out.h1 = h1; out.hOpen = hOpen; out.Tff = dF.T; out.tOpen = tOpen; out.z10 = proj.zAt(10);
  const dP = driftBetween(prof, h1, h2, +p.vz), lat = Va * (+p.perpTime);
  const S = [1, -1].map(s => ({ x: dFF.x + dP.x + s * lat * r.x, y: dFF.y + dP.y + s * lat * r.y }));
  // Portée vers le PRV selon la direction suivie (route directe, dérive corrigée en crabe), du bas de la phase 2 à hMin
  const Rt = new Float64Array(361);
  for (let d = 0; d <= 360; d++) {
    const a = d * Math.PI / 180, e = { x: Math.sin(a), y: Math.cos(a) }; let dist = 0;
    for (let h = h2; h > hMin; h -= DH) {
      const dh = Math.min(DH, h - hMin), w = windAt(prof, h - dh / 2), wp = w.u * e.x + w.v * e.y, wq = -w.u * e.y + w.v * e.x;
      dist += (wp + Math.sqrt(Math.max(0, Va * Va - wq * wq))) * dh / (+p.vz);
    }
    Rt[d] = Math.max(0, dist);
  }
  // Borne physique : quel que soit le cap tenu, on ne peut pas faire mieux que le cercle (dérive sous voile + Vh × temps).
  // Elle évite de compter une route directe intenable quand le vent de travers dépasse la vitesse propre.
  const D2 = driftBetween(prof, h2, hMin, +p.vz), R2 = Va * (h2 - hMin) / (+p.vz);
  const reach = (qx, qy) => { // depuis le point local q (début de la navigation), peut-on rejoindre le PRV ?
    if (Math.hypot(qx + D2.x, qy + D2.y) > R2) return false;
    const d = Math.hypot(qx, qy); if (d < 1) return true;
    const b = n360(Math.atan2(-qx, -qy) * 180 / Math.PI), i = Math.floor(b), f = b - i;
    return d <= Rt[i] * (1 - f) + Rt[i + 1] * f;
  };
  const insideRaw = (x, y) => reach(x + S[0].x, y + S[0].y) || reach(x + S[1].x, y + S[1].y);
  let Rmax = 0; for (let d = 0; d < 360; d++) Rmax = Math.max(Rmax, Rt[d]);
  // La zone de largage tient dans le cercle de relaxation (sans les 15 s) : on cherche autour de son centre.
  // (Avant : centre = simple dérive en chute, sans la dérive sous voile → par vent fort il tombait hors de la zone
  //  et le contour en pointillés était faux, coupé par un trait droit.)
  const dC = driftBetween(prof, h1, hMin, +p.vz);
  out.relax = { c: { x: -(dFF.x + dC.x), y: -(dFF.y + dC.y) }, R: Va * (h1 - hMin) / (+p.vz) };
  // Marge de sécurité : cercle et zone réduits de x % autour du même centre → vecteur raccourci d'autant, surtout aux deux bouts
  const k = Math.min(1, Math.max(0.05, 1 - (+p.margin || 0) / 100));
  out.relax.R *= k; out.margin = Math.round((1 - k) * 100);
  const C0 = out.relax.c, Rs = out.relax.R + 100;
  const inside = (x, y) => insideRaw(C0.x + (x - C0.x) / k, C0.y + (y - C0.y) / k);
  // Vent moyen sous voile (de la fin des 15 s jusqu'à l'arrivée au PRV), pour l'explication
  let cu = 0, cv = 0, cn = 0; for (let h = h2; h > hMin; h -= DH) { const w = windAt(prof, h); cu += w.u; cv += w.v; cn++; }
  const canopyWind = spdDir({ u: cu / Math.max(cn, 1), v: cv / Math.max(cn, 1) });
  Object.assign(out, { u, r, S, C0, Rs, inside, dFF, dP, Rmax, Rt, reach, canopyWind, h1, h2 });
  // Recherche du plus long segment parallèle à l'axe, entièrement dans la zone
  const step = 10;
  // Segments de l'axe (décalé de o sur le côté) entièrement dans la zone ; tWant : le plus proche de ce point, sinon le plus long
  const runOn = (o, tWant, st) => {
    st = st || step;
    let best = null, bd = Infinity, start = null;
    const base = { x: C0.x + o * r.x, y: C0.y + o * r.y }, n = Math.ceil(Rs / st);
    for (let k = -n; k <= n + 1; k++) {
      const t = k * st, inn = k <= n && inside(base.x + t * u.x, base.y + t * u.y);
      if (inn && start === null) start = t;
      if (!inn && start !== null) {
        const seg = { a: start, b: t - st, st };
        if (tWant != null) { const d = tWant < seg.a ? seg.a - tWant : tWant > seg.b ? tWant - seg.b : 0; if (d < bd) { bd = d; best = seg; } }
        else if (!best || seg.b - seg.a > best.b - best.a) best = seg;
        start = null;
      }
    }
    return best;
  };
  const refine = (o, seg) => { // bords au mètre près
    const base = { x: C0.x + o * r.x, y: C0.y + o * r.y }, ins = t => inside(base.x + t * u.x, base.y + t * u.y), st = seg.st || step;
    const edge = (tin, tout) => { for (let k = 0; k < 12; k++) { const m = (tin + tout) / 2; if (ins(m)) tin = m; else tout = m; } return tin; };
    return { a: edge(seg.a, seg.a - st), b: edge(seg.b, seg.b + st) };
  };
  let bo = null, bs = null;
  if (typeof z.offsetManual === 'number') { // vecteur placé à la main : décalage latéral mémorisé par rapport au PRV
    const o = Math.max(-Rs, Math.min(Rs, z.offsetManual - (C0.x * r.x + C0.y * r.y))); // jamais plus loin que le cercle
    const tw = typeof z.tManual === 'number' ? z.tManual - (C0.x * u.x + C0.y * u.y) : null;
    const s = runOn(o, tw);
    if (s) { bo = o; bs = s; }
    else { // déplacé hors de la zone : on le bloque sur le bord le plus proche, quitte à le réduire à un point
      const n = Math.ceil(2 * Rs / step); let oin = null, oout = o;
      for (let k = 1; k <= n && oin === null; k++) for (const sg of [1, -1]) { const oo = o + sg * k * step; if (runOn(oo, null)) { oin = oo; oout = oo - sg * step; break; } }
      if (oin !== null) {
        let a = oin, b = oout;
        for (let k = 0; k < 12; k++) { const m = (a + b) / 2; if (runOn(m, null, 1)) a = m; else b = m; }
        bo = a; bs = runOn(a, tw, 1) || runOn(oin, tw); if (!runOn(a, tw, 1)) bo = oin;
      }
    }
  } else {
    const n = Math.ceil(Rs / step);
    for (let k = -n; k <= n; k++) { const s = runOn(k * step, null); if (s && (!bs || s.b - s.a > bs.b - bs.a)) { bs = s; bo = k * step; } }
  }
  if (!bs) { out.err = 'Aucun point de largage ne permet de rejoindre le PRV à ' + hMin + ' m avec ces vents.'; out.ok = false; return out; }
  const seg = refine(bo, bs), base = { x: C0.x + bo * r.x, y: C0.y + bo * r.y };
  const A = { x: base.x + seg.a * u.x, y: base.y + seg.a * u.y }, B = { x: base.x + seg.b * u.x, y: base.y + seg.b * u.y };
  out.start = Geo.fromLocal(ch.prv, A); out.end = Geo.fromLocal(ch.prv, B); out.length = seg.b - seg.a;
  out.offsetUsed = bo + (C0.x * r.x + C0.y * r.y); out.tUsed = (seg.a + seg.b) / 2 + (C0.x * u.x + C0.y * u.y);
  out.u = u; out.exits = exitsOn(out, prof, p, proj);
  // Dernier para (Henri, 19/11/2026) : il ne fait pas les 15 s perpendiculaires (personne derrière lui pour lui tomber dessus).
  // Il peut donc sortir au-delà de la zone en pointillés, jusqu'au cercle sans les 15 s, au plus un intervalle plus loin
  // (l'avant-dernier reste ainsi dans la zone avec les 15 s).
  out.lastExtra = 0;
  const sp = out.exits && out.exits.s;
  if (sp) {
    const rc = out.relax.c, Rr = out.relax.R, bx = B.x - rc.x, by = B.y - rc.y, bu = bx * u.x + by * u.y, disc = bu * bu - (bx * bx + by * by - Rr * Rr);
    const e = Math.max(0, Math.min(disc > 0 ? -bu + Math.sqrt(disc) : 0, sp));
    if (e > 0.5) {
      out.lastExtra = e; out.length += e; out.end = Geo.fromLocal(ch.prv, { x: B.x + e * u.x, y: B.y + e * u.y });
      out.exits.n = Math.floor(out.length / sp + 1e-6) + 1;
    }
  }
  out.ok = true; return out;
}
// Zone réelle de largage (avec les 15 s perpendiculaires, union des deux côtés) : « patatoïde », par rayons depuis son centre
function patatoidPolygon(sol) {
  if (!sol || !sol.inside) return null;
  const pts = [], c = sol.C0, st = 10;
  for (let a = 0; a < 360; a += 2) {
    const e = { x: Math.sin(a * Math.PI / 180), y: Math.cos(a * Math.PI / 180) }; let last = -1;
    for (let d = 0; d <= sol.Rs; d += st) if (sol.inside(c.x + d * e.x, c.y + d * e.y)) last = d;
    if (last < 0) continue;
    let tin = last, tout = last + st;
    for (let k = 0; k < 8; k++) { const m = (tin + tout) / 2; if (sol.inside(c.x + m * e.x, c.y + m * e.y)) tin = m; else tout = m; }
    pts.push(Geo.fromLocal(sol.prv, { x: c.x + tin * e.x, y: c.y + tin * e.y }));
  }
  return pts.length > 10 ? pts : null;
}
// Cercle de relaxation (affichage) : sans les 15 s perpendiculaires, c'est un vrai cercle
function relaxPolygon(sol) {
  if (!sol || !sol.relax) return null;
  const c = sol.relax.c, R = sol.relax.R, pts = [];
  for (let a = 0; a < 360; a += 3) pts.push(Geo.fromLocal(sol.prv, { x: c.x + R * Math.sin(a * Math.PI / 180), y: c.y + R * Math.cos(a * Math.PI / 180) }));
  return pts;
}

// ---------- Carte ----------
const map = L.map('map', { zoomControl: false, maxZoom: 22, zoomSnap: 0.25, attributionControl: true,
  rotate: true, touchRotate: true, bearing: current.bearing || 0, rotateControl: false, touchPitch: false, pitchDrag: false, shiftKeyRotate: true })
  .setView([current.center.lat, current.center.lng], current.zoom);
let basemap = (store.get('vl.basemap', 'esri') in BASEMAPS) ? store.get('vl.basemap', 'esri') : 'esri';
let baseLayer = null, tileFails = 0;
function setBasemap(k, msg) {
  basemap = BASEMAPS[k] ? k : 'esri'; store.set('vl.basemap', basemap);
  if (baseLayer) map.removeLayer(baseLayer);
  const B = BASEMAPS[basemap]; tileFails = 0;
  baseLayer = L.tileLayer(B.url, { maxNativeZoom: B.maxNative, maxZoom: 22, crossOrigin: 'anonymous', attribution: B.attr }).addTo(map);
  baseLayer.on('tileerror', () => { if (++tileFails === 12 && basemap === 'ign') toast('Photos IGN indisponibles ici (hors France ou pas de réseau) : repasse sur « Satellite »'); });
  $('bmEsri').classList.toggle('on', basemap === 'esri'); $('bmIgn').classList.toggle('on', basemap === 'ign');
  if (msg) toast(basemap === 'ign' ? 'Fond : photos aériennes IGN (France)' : 'Fond : satellite Esri (monde)');
}
setBasemap(basemap);
$('bmEsri').addEventListener('click', () => setBasemap('esri', true));
$('bmIgn').addEventListener('click', () => setBasemap('ign', true));
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
map.on('moveend', () => { current.center = map.getCenter(); current.zoom = map.getZoom(); store.set('vl.current', current); });
// Boussole : indique le nord quand la carte est tournée ; un appui remet le nord en haut
function syncCompass() {
  const b = map.getBearing ? map.getBearing() : 0;
  $('compassNeedle').style.transform = `rotate(${b}deg)`; // la carte tourne de +b : le nord aussi
  $('btnNorth').classList.toggle('rotated', Math.abs(((b % 360) + 360) % 360) > 0.5);
}
let rotT = 0;
map.on('rotate', () => { syncCompass(); current.bearing = map.getBearing(); clearTimeout(rotT); rotT = setTimeout(persist, 400); });

const fig = L.layerGroup().addTo(map);
const grads = L.layerGroup().addTo(map);
let placing = null, posMarker = null; // placing : null | 'P' (PRV)
const prvMarkers = {};
let patPts = null, solKey = '', sol = null, prof = null, wxRec = null, relaxPts = null, relaxKey = '';

function dotIcon(color, size, label, cls) {
  return L.divIcon({
    className: 'dot ' + (cls || ''),
    html: `<span style="background:${color};width:${size}px;height:${size}px"></span>${label ? `<b class="${isDark(color) ? 'onlight' : ''}" style="color:${color}">${label}</b>` : ''}`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2]
  });
}
const LL = p => [p.lat, p.lng];
let raf = 0;
function redraw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => draw()); } // draw(false) : dessin complet
let lightT = 0;
function drawLight() { const n = performance.now(); if (n - lightT > 60) { lightT = n; draw(true); } }

// Recalcule le vecteur (sans réseau : prévision gardée en mémoire)
function compute() {
  wxRec = wxCached(current.id, current.when.slice(0, 10));
  const elev = elevOf(current, wxRec);
  prof = wxProfile(wxRec, current.when, elev);
  const key = JSON.stringify([current.id, current.when, current.prvs, current.params, current.axis, current.elevManual, current.prvManual,
    current.headingOverride, current.reversed, current.offsetManual, current.tManual, elev, wxRec && wxRec.fetched, zeroWind]);
  if (key !== solKey) { sol = solve(current, prof, wxRec); solKey = key; }
  if (sol.ok) current.vector = { when: current.when, start: sol.start, end: sol.end, heading: sol.heading, length: Math.round(sol.length), decl: sol.decl, prv: sol.prv.id };
}
function draw(light) {
  if (typeof Photo !== 'undefined') Photo.sync();
  fig.clearLayers(); grads.clearLayers();
  compute();
  updateInfo(); syncQuick(); syncPlaceBtn(); syncJump(); fillInputs(true);
  if (placing) placeBanner();
  else if (!current.prvs.length) setBanner(current.id ? 'Place les points de rendez-vous : ☰ Zones → PRV → Toucher la carte.' : 'Pour commencer : ☰ → ＋ Nouvelle zone.');
  else if (!sol.ok) setBanner(sol.err);
  else setBanner(zeroWind ? 'TEST : vent forcé à 0 partout (bouton « Vent 0 » pour revenir aux prévisions)' : (sol.warn || null));
  if (sol.ok) {
    if (current.show.relax) {
      const key = [current.when, sol.heading, sol.prv.id, JSON.stringify(current.params), sol.elev, wxRec && wxRec.fetched].join('|');
      if (!light && key !== relaxKey) { relaxPts = relaxPolygon(sol); patPts = patatoidPolygon(sol); relaxKey = key; }
      if (relaxPts) L.polygon(relaxPts.map(LL), { color: C_RELAX, weight: 1.75, fill: false, smoothFactor: 0, interactive: false }).addTo(fig);
      if (patPts) L.polygon(patPts.map(LL), { color: C_RELAX, weight: 1.5, dashArray: '6 5', fill: false, smoothFactor: 0, interactive: false }).addTo(fig);
    }
    if (current.show.rose) { const ro = roseOf(sol); degRing(ro.c, ro.R, '#ffffff', sol.decl); }
    const a = LL(sol.start), b = LL(sol.end);
    L.polyline([a, b], { color: '#fff', weight: 5, opacity: .9, interactive: false }).addTo(fig);
    L.polyline([a, b], { color: '#000', weight: 2.5, interactive: false }).addTo(fig);
    L.marker(a, { interactive: false, zIndexOffset: 600, icon: dotIcon(C_START, 14, '') }).addTo(fig);
    L.marker(b, { interactive: false, zIndexOffset: 600, icon: dotIcon(C_END, 14, '') }).addTo(fig);
  }
  placeMarkers();
}

// Rosace graduée en degrés MAGNÉTIQUES autour du vecteur (pour le largueur)
const mPerPx = ll => 40075016.686 * Math.cos(ll.lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
function roseOf(sol) { return { c: { lat: (sol.start.lat + sol.end.lat) / 2, lng: (sol.start.lng + sol.end.lng) / 2 }, R: Math.max(250, sol.length / 2 * 1.15) }; }
function degRing(center, radius, color, decl) {
  const mpp = mPerPx(center);
  L.circle(LL(center), { radius, color, weight: 1.5, opacity: .85, fill: false, dashArray: '4 6', interactive: false }).addTo(grads);
  const degs = Geo.degTicks(radius / mpp);
  const pt = (deg, d) => { const a = (deg + decl) * Math.PI / 180; return LL(Geo.fromLocal(center, { x: d * Math.sin(a), y: d * Math.cos(a) })); };
  const segs = [];
  degs.forEach(deg => {
    segs.push([pt(deg, radius), pt(deg, radius - 10 * mpp)]);
    L.marker(pt(deg, radius + 16 * mpp), { interactive: false,
      icon: L.divIcon({ className: 'glabel', html: `<span style="color:${color}">${deg}°</span>`, iconSize: [0, 0] }) }).addTo(grads);
  });
  L.polyline(segs, { color, weight: 1.5, interactive: false }).addTo(grads);
}
const isDragging = m => !!(m && (m._lpDragging || (m.dragging && m.dragging._draggable && m.dragging._draggable._moving)));

// ---------- Appui long pour déplacer un point (portes, mesure) ----------
// Un glissement immédiat déplace la carte ; il faut rester appuyé HOLD_MS sans bouger pour « soulever » le point.
const HOLD_MS = 450, MOVE_TOL = 10;
let suppressClickUntil = 0;
function longPressDrag(marker, onMove, onEnd, onStart) {
  const el = marker.getElement(); if (!el) return;
  let timer = null, start = null;
  const pt = e => (e.touches ? (e.touches[0] || e.changedTouches[0]) : e);
  const off = () => {
    document.removeEventListener('touchmove', move); document.removeEventListener('mousemove', move);
    document.removeEventListener('touchend', up); document.removeEventListener('touchcancel', up); document.removeEventListener('mouseup', up);
  };
  const down = e => {
    if (e.touches && e.touches.length > 1) return; // deux doigts : c'est pour la carte
    const p = pt(e); start = { x: p.clientX, y: p.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null; marker._lpDragging = true; if (onStart) onStart();
      const d = map.dragging && map.dragging._draggable; if (d) d.finishDrag(true); // stoppe le déplacement de carte commencé
      map.dragging.disable(); el.classList.add('lifting');
      if (navigator.vibrate) try { navigator.vibrate(25); } catch (er) {}
    }, HOLD_MS);
    document.addEventListener('touchmove', move, { passive: false }); document.addEventListener('mousemove', move);
    document.addEventListener('touchend', up); document.addEventListener('touchcancel', up); document.addEventListener('mouseup', up);
  };
  const move = e => {
    if (e.touches && e.touches.length > 1) { clearTimeout(timer); timer = null; return; }
    const p = pt(e); if (!p) return;
    if (!marker._lpDragging) {
      if (timer && Math.hypot(p.clientX - start.x, p.clientY - start.y) > MOVE_TOL) { clearTimeout(timer); timer = null; }
      return;
    }
    e.preventDefault();
    const r = map.getContainer().getBoundingClientRect();
    const ll = map.containerPointToLatLng([p.clientX - r.left, p.clientY - r.top]);
    marker.setLatLng(ll); onMove({ lat: ll.lat, lng: ll.lng });
  };
  const up = () => {
    clearTimeout(timer); timer = null; off();
    if (marker._lpDragging) {
      marker._lpDragging = false; el.classList.remove('lifting'); map.dragging.enable();
      suppressClickUntil = Date.now() + 400; onEnd();
    }
  };
  el.addEventListener('touchstart', down, { passive: true }); el.addEventListener('mousedown', down);
}
// ---------- PRV, vecteur et son étiquette ----------
function prvIcon(used) {
  return L.divIcon({ className: 'prv' + (used ? ' used' : ''), iconSize: [24, 24], iconAnchor: [12, 12], html: '<span></span>' });
}
// Appui long sans glisser → action (ex. menu d'un PRV)
function longPressAction(m, cb) {
  const el = m.getElement(); if (!el) return;
  let t = null, s = null, fired = false;
  const pt = e => (e.touches ? e.touches[0] : e);
  const cancel = () => { clearTimeout(t); t = null; };
  el.addEventListener('touchstart', e => { if (e.touches.length > 1) return; const p = pt(e); s = { x: p.clientX, y: p.clientY }; fired = false; cancel(); t = setTimeout(() => { t = null; fired = true; suppressClickUntil = Date.now() + 600; const d = map.dragging && map.dragging._draggable; if (d) d.finishDrag(true); if (navigator.vibrate) try { navigator.vibrate(25); } catch (er) {} cb(); }, HOLD_MS); }, { passive: true });
  // fin d'un appui long : pas de « clic » fantôme sur la fenêtre qui vient de s'ouvrir
  el.addEventListener('touchend', e => { if (fired) { e.preventDefault(); fired = false; } }, { passive: false });
  el.addEventListener('mousedown', e => { s = { x: e.clientX, y: e.clientY }; cancel(); t = setTimeout(() => { t = null; suppressClickUntil = Date.now() + 600; cb(); }, HOLD_MS); });
  const mv = e => { if (!t || !s) return; const p = pt(e); if (p && Math.hypot(p.clientX - s.x, p.clientY - s.y) > MOVE_TOL) cancel(); };
  el.addEventListener('touchmove', mv, { passive: true }); el.addEventListener('mousemove', mv);
  ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(ev => el.addEventListener(ev, cancel));
}
let vecHit = null, vecLabel = null;
function placeMarkers() {
  const usedId = sol && sol.prv ? sol.prv.id : null;
  Object.keys(prvMarkers).forEach(id => { if (!current.prvs.find(p => p.id === id)) { map.removeLayer(prvMarkers[id]); delete prvMarkers[id]; } });
  current.prvs.forEach(p => {
    let m = prvMarkers[p.id];
    if (!m) { m = prvMarkers[p.id] = L.marker(LL(p), { icon: prvIcon(p.id === usedId), zIndexOffset: 800 }).addTo(map); m._used = p.id === usedId; longPressAction(m, () => prvMenu(p.id)); }
    else { m.setLatLng(LL(p)); if (m._used !== (p.id === usedId)) { m.setIcon(prvIcon(p.id === usedId)); m._used = p.id === usedId; longPressAction(m, () => prvMenu(p.id)); } }
  });
  // Trait du vecteur : appui long puis glisser = déplacer (longueur recalculée, même axe)
  if (sol && sol.ok) {
    if (!vecHit) {
      const line = L.polyline([LL(sol.start), LL(sol.end)], { color: '#fff', weight: 30, opacity: 0, interactive: true, bubblingMouseEvents: true }).addTo(map);
      const handle = { _lpDragging: false, getElement: () => line._path, setLatLng: () => {} };
      vecHit = { line, handle, attachedEl: null };
    } else if (!vecHit.handle._lpDragging) vecHit.line.setLatLngs([LL(sol.start), LL(sol.end)]);
    if (!map.hasLayer(vecHit.line)) vecHit.line.addTo(map);
    // Leaflet recrée l'élément <path> à chaque retour du trait sur la carte : rebrancher l'appui long sur le nouvel élément
    if (vecHit.line._path && vecHit.attachedEl !== vecHit.line._path) { vecHit.attachedEl = vecHit.line._path; const handle = vecHit.handle;
      longPressDrag(handle, ll => { setManualPoint(ll); draw(true); }, () => { if (sol && sol.ok) { current.offsetManual = sol.offsetUsed; current.tManual = sol.tUsed; } persist(); redraw(); toast('Vecteur déplacé. « Vect. auto » (à gauche) pour revenir au meilleur placement.'); });
    }
    // Étiquette : cap magnétique et longueur ; appui long sur le cap = le modifier
    const mid = labelPos();
    const ne = sol.exits ? sol.exits.n : 1;
    const dtx = sol.exits && sol.exits.dt ? ` · <b class="vexits">${fmt1(sol.exits.dt)} s</b>` : '';
    const html = `<span><b class="vcap">${hdg(sol.heading)}</b> · ${fmtInt(sol.length)} m · <b class="vexits">${ne} sortie${ne > 1 ? 's' : ''}</b>${dtx}</span>`;
    if (!vecLabel) { vecLabel = L.marker(LL(mid), { zIndexOffset: 1200, icon: L.divIcon({ className: 'vlabel', iconSize: [0, 0], html }) }).addTo(map); vecLabel._html = html; longPressAction(vecLabel, editHeading); }
    else { vecLabel.setLatLng(LL(mid)); if (vecLabel._html !== html) { vecLabel.setIcon(L.divIcon({ className: 'vlabel', iconSize: [0, 0], html })); vecLabel._html = html; longPressAction(vecLabel, editHeading); } }
    if (current.show.label === false) { if (map.hasLayer(vecLabel)) map.removeLayer(vecLabel); }
    else if (!map.hasLayer(vecLabel)) vecLabel.addTo(map);
  } else {
    if (vecHit && map.hasLayer(vecHit.line)) map.removeLayer(vecHit.line);
    if (vecLabel && map.hasLayer(vecLabel)) map.removeLayer(vecLabel);
  }
}
// Étiquette du vecteur posée à côté du trait (pas dessus), pour laisser le trait libre à l'appui long
function labelPos() {
  const a = map.latLngToContainerPoint(LL(sol.start)), b = map.latLngToContainerPoint(LL(sol.end));
  // direction de l'axe à l'écran (même si le vecteur est réduit à un point)
  const ax = map.latLngToContainerPoint(LL(Geo.fromLocal(sol.start, { x: sol.u.x * 1000, y: sol.u.y * 1000 })));
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, L0 = Math.hypot(ax.x - a.x, ax.y - a.y) || 1;
  let px = -(ax.y - a.y) / L0, py = (ax.x - a.x) / L0; if (px < 0 || (px === 0 && py < 0)) { px = -px; py = -py; }
  const el = vecLabel && vecLabel.getElement() && vecLabel.getElement().querySelector('span');
  const w = el ? el.offsetWidth : 190, h = el ? el.offsetHeight : 34;
  const d = Math.abs(px) * w / 2 + Math.abs(py) * h / 2 + 12;
  const ll = map.containerPointToLatLng([m.x + px * d, m.y + py * d]);
  return { lat: ll.lat, lng: ll.lng };
}
function resetMarkers() {
  Object.keys(prvMarkers).forEach(id => { map.removeLayer(prvMarkers[id]); delete prvMarkers[id]; });
  if (vecHit && map.hasLayer(vecHit.line)) map.removeLayer(vecHit.line);
  if (vecLabel && map.hasLayer(vecLabel)) map.removeLayer(vecLabel);
}
function setManualPoint(ll) {
  if (!sol || !sol.ok) return;
  const q = Geo.toLocal(sol.prv, ll);
  current.offsetManual = q.x * sol.r.x + q.y * sol.r.y; current.tManual = q.x * sol.u.x + q.y * sol.u.y;
}
async function prvMenu(id) {
  const p = current.prvs.find(x => x.id === id); if (!p) return;
  const used = sol && sol.prv && sol.prv.id === id;
  const res = await ask(used ? (current.prvManual ? 'Ce PRV est la référence (choisi à la main).' : 'Ce PRV est la référence (choix automatique).') : 'Utiliser ce point de rendez-vous comme référence ?', undefined, 'Supprimer', used ? 'OK' : 'Utiliser');
  if (res === 'DELETE') {
    if (!(await ask('Supprimer ce point de rendez-vous ?'))) return;
    current.prvs = current.prvs.filter(x => x.id !== id); if (current.prvManual === id) current.prvManual = null;
    persist(); redraw(); return;
  }
  if (res === true && !used) { current.prvManual = id; current.offsetManual = null; persist(); redraw(); toast('PRV choisi à la main. « PRV auto » pour revenir au choix automatique.'); }
}
async function editHeading() {
  if (!sol || !sol.ok) return;
  const res = await ask(`Cap de largage (° magnétiques). Vide = automatique (${sol.why}).`, typeof current.headingOverride === 'number' ? String(Math.round(n360(sol.heading - sol.decl - (current.reversed ? 180 : 0)))) : '');
  if (res === null) return;
  if (res === '') current.headingOverride = null;
  else { const v = parseFloat(res.replace(',', '.')); if (isNaN(v)) return; current.headingOverride = n360(v + sol.decl); }
  current.reversed = false; current.offsetManual = null; persist(); redraw();
}
function addPrv(p) {
  current.prvs.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lat: p.lat, lng: p.lng });
  persist(); redraw();
  toast(`PRV placé (${current.prvs.length}). Appui long sur un PRV : l'utiliser comme référence ou le supprimer.`);
  ensureWx(false);
}

// Points à faire tenir à l'écran (et dans le PDF) : vecteur, PRV, zone de relaxation affichée
function figurePoints() {
  if (!sol || !sol.ok) return current.prvs.map(p => ({ lat: p.lat, lng: p.lng }));
  const pts = [sol.start, sol.end];
  if (current.show.relax && relaxPts) relaxPts.forEach(p => pts.push(p));
  if (current.show.rose) { const ro = roseOf(sol); [0, 90, 180, 270].forEach(a => pts.push(Geo.fromLocal(ro.c, { x: (ro.R + 60) * Math.sin(a * Math.PI / 180), y: (ro.R + 60) * Math.cos(a * Math.PI / 180) }))); }
  // PRV : seulement s'ils sont dans le cercle de relaxation (sinon ils réduiraient trop le zoom)
  const inCircle = ll => { if (!sol.relax) return false; const q = Geo.toLocal(sol.prv, ll); return Math.hypot(q.x - sol.relax.c.x, q.y - sol.relax.c.y) <= sol.relax.R; };
  current.prvs.forEach(p => { if (inCircle(p)) pts.push({ lat: p.lat, lng: p.lng }); });
  return pts;
}
function freeRect() {
  const W = map.getSize().x, H = map.getSize().y, m = 14;
  const top = $('top').getBoundingClientRect(), quick = $('quick').getBoundingClientRect();
  return { l: Math.max(m, quick.right + m), t: Math.max(m, top.bottom + m), r: W - 64, b: H - 40 };
}
function fitFigure() {
  const pts = figurePoints(); if (pts.length < 2) return;
  map.invalidateSize({ animate: false }); // taille réelle de l'écran (portrait / paysage)
  for (let pass = 0; pass < 2; pass++) { // 2 passes : la 2e corrige les arrondis du zoom
    const P = pts.map(p => map.latLngToContainerPoint(LL(p)));
    const x0 = Math.min(...P.map(p => p.x)), x1 = Math.max(...P.map(p => p.x));
    const y0 = Math.min(...P.map(p => p.y)), y1 = Math.max(...P.map(p => p.y));
    const R = freeRect(), aw = Math.max(80, R.r - R.l), ah = Math.max(80, R.b - R.t);
    const k = Math.min(aw / Math.max(x1 - x0, 1), ah / Math.max(y1 - y0, 1));
    const z = Math.min(19, Math.floor((map.getZoom() + Math.log2(k)) * 4) / 4);
    const centerLL = map.containerPointToLatLng([(x0 + x1) / 2, (y0 + y1) / 2]);
    map.setView(centerLL, z, { animate: false });
    // décale pour que le centre de la figure tombe au centre de la zone libre
    const S = map.getSize(), cx = S.x / 2, cy = S.y / 2, ax = (R.l + R.r) / 2, ay = (R.t + R.b) / 2;
    map.panBy([cx - ax, cy - ay], { animate: false });
  }
}

function updateInfo() {
  let t = '';
  if (sol && sol.ok) {
    t = `Vecteur ${hdg(sol.heading)} (déclinaison ${fmt1(sol.decl)}°) · ${fmtInt(sol.length)} m · ${sol.why}` +
      ` · largage FL${Math.round(sol.flRel)} = ${fmtInt(sol.hRel)} m sol · vent de largage ${hdg(sol.windRel.dir)} ${Math.round(sol.windRel.spd * KT)} kt` +
      ` · PRV ${sol.prvAuto ? 'automatique (le plus au vent)' : 'choisi à la main'}` +
      ` · dérive en chute libre ${fmtDist(Math.hypot(sol.dFF.x, sol.dFF.y))} · vent moyen sous voile ${hdg(sol.canopyWind.dir)} ${Math.round(sol.canopyWind.spd * KT)} kt pour une vitesse sous voile de ${Math.round(sol.Va * KT)} kt` +
      (sol.canopyWind.spd >= sol.Va ? ' : impossible de remonter au vent sous voile, il faut ouvrir au vent du PRV' : '');
  } else if (sol && sol.err) t = sol.err;
  $('axisInfo').textContent = t;
  const ex = sol && sol.ok && sol.exits;
  // Panneau 🕑 volontairement court (Henri, 19/11/2026) : nombre de sorties et alerte vent sous voile ; le détail est dans l'onglet Zones (axisInfo)
  $('whyInfo').innerHTML = sol && sol.ok ? (ex && ex.dt ? `<b>${ex.n} sortie${ex.n > 1 ? 's' : ''}</b>, une toutes les <b>${ex.dt} s</b>.` : '') +
    (sol.canopyWind.spd >= sol.Va ? ' <b class="warn">Vent sous voile plus fort que la voile : ouvrir au vent du PRV.</b>' : '') : '';
  $('elevAuto').textContent = typeof current.elevAuto === 'number' ? `automatique : ${current.elevAuto} m` : 'automatique : inconnue (pas encore de prévision)';
}

// ---------- Interface ----------
// Élément absent (ex. page en cache d'une version plus ancienne) : on renvoie un élément fantôme
// plutôt que de planter toute l'appli.
function $(id) { return document.getElementById(id) || document.createElement('div'); }
function setBanner(t) { const b = $('banner'); if (!t) b.classList.add('hidden'); else { b.textContent = t; b.classList.remove('hidden'); } }
let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3200); }
const numIn = el => parseFloat(String(el.value).replace(',', '.'));
const HYP = ['vff', 'openLoss', 'perpTime', 'vz', 'glide', 'hMin', 'sep'];
function setParam(k, v) { current.params[k] = v; profile[k] = v; store.set('vl.profile', profile); zones.forEach(applyProfile); store.set('vl.zones', zones); }
function fillInputs(only) {
  const p = current.params;
  HYP.concat(['hOpen']).forEach(k => { const el = $('p_' + k); if (el && document.activeElement !== el) el.value = String(p[k]).replace('.', ','); });
  // largage : FL et m sol liés (on garde la valeur saisie en dernier, l'autre est recalculée avec la prévision)
  const elev = elevOf(current, wxRec);
  const agl = p.relMode === 'AGL' ? +p.relAGL : flToAgl(+p.relFL, prof, elev), fl = p.relMode === 'FL' ? +p.relFL : aglToFl(+p.relAGL, prof, elev);
  ['p_relFL', 'j_relFL'].forEach(id => { if (document.activeElement !== $(id)) $(id).value = Math.round(fl); });
  ['p_relAGL', 'j_relAGL'].forEach(id => { if (document.activeElement !== $(id)) $(id).value = Math.round(agl); });
  if (document.activeElement !== $('j_hOpen')) $('j_hOpen').value = p.hOpen;
  fillAc();
  $('vhInfo').textContent = `Vitesse horizontale sous voile : ${fmt1((+p.vz) * (+p.glide))} m/s (vitesse verticale × finesse).`;
  if (only) return;
  $('z_axisOn').checked = !!current.axis.on; $('z_axisBoth').checked = current.axis.both !== false;
  if (document.activeElement !== $('z_axisMag')) $('z_axisMag').value = current.axis.on ? Math.round(current.axis.mag) : (current.axis.mag || '');
  $('axisRow').classList.toggle('dim', !current.axis.on);
  if (document.activeElement !== $('z_elev')) $('z_elev').value = typeof current.elevManual === 'number' ? current.elevManual : '';
  syncQuick(); syncJump();
  $('zoneName').textContent = current.name + (current.id ? '' : ' (non enregistrée)');
}
HYP.concat(['hOpen']).forEach(k => {
  $('p_' + k).addEventListener('input', e => { const v = numIn(e.target); if (isNaN(v)) return; setParam(k, v); persist(); redraw(); });
  $('p_' + k).addEventListener('blur', () => fillInputs(true));
});
// Avion : vitesses de largage (badin, nœuds) ; « Saisie manuelle » pour une autre valeur
const AIRCRAFT = { pc6: ['Pilatus PC-6', 70], c208: ['Cessna Caravan', 85], dhc6: ['Twin Otter', 85], cn235: ['CASA CN235', 110], a400: ['A400M / C-130J', 130] };
const acName = () => { const t = AIRCRAFT[current.params.acType]; return t && Math.round(current.params.acMs * KT) === t[1] ? t[0] : 'Avion'; };
// Choix de l'avion : dans les Paramètres et dans le panneau 🕑 (même réglage)
['p_acType', 'j_acType'].forEach(id => $(id).addEventListener('change', e => {
  const t = e.target.value;
  if (t === 'manual' && id === 'j_acType') { setParam('acType', 'manual'); fillAc(); toast('Vitesse à saisir dans ⚙ Paramètres'); return; }
  setParam('acType', t);
  if (AIRCRAFT[t]) setParam('acMs', Math.round(AIRCRAFT[t][1] / KT * 10) / 10);
  current.offsetManual = null; persist(); redraw(); fillAc();
}));
// Vitesse de largage de l'avion : nœuds et m/s liés (stockée en m/s)
function fillAc() {
  const ms = +current.params.acMs || 0;
  const ty = AIRCRAFT[current.params.acType];
  const tv = ty && Math.round(ms * KT) === ty[1] ? current.params.acType : 'manual'; // vitesse modifiée à la main → « Saisie manuelle »
  ['p_acType', 'j_acType'].forEach(id => { const s = $(id); const m = s.querySelector && s.querySelector('option[value="manual"]'); if (m) m.textContent = `Saisie manuelle — ${Math.round(ms * KT)} kt`; s.value = tv; });
  if (document.activeElement !== $('p_acKt')) $('p_acKt').value = Math.round(ms * KT);
  if (document.activeElement !== $('p_acMs')) $('p_acMs').value = fmt1(ms);
}
$('p_acKt').addEventListener('change', e => { const v = numIn(e.target); if (isNaN(v)) return; setParam('acType', 'manual'); setParam('acMs', Math.round(v / KT * 10) / 10); current.offsetManual = null; persist(); redraw(); fillAc(); });
$('p_acMs').addEventListener('change', e => { const v = numIn(e.target); if (isNaN(v)) return; setParam('acType', 'manual'); setParam('acMs', v); current.offsetManual = null; persist(); redraw(); fillAc(); });
['p_acKt', 'p_acMs'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); }));
function setRel(mode, v) { if (isNaN(v)) return; setParam('relMode', mode); setParam(mode === 'FL' ? 'relFL' : 'relAGL', v); current.offsetManual = null; persist(); redraw(); setTimeout(() => fillInputs(true), 0); }
['p_relFL', 'j_relFL'].forEach(id => $(id).addEventListener('change', e => setRel('FL', numIn(e.target))));
['p_relAGL', 'j_relAGL'].forEach(id => $(id).addEventListener('change', e => setRel('AGL', numIn(e.target))));
$('j_hOpen').addEventListener('change', e => { const v = numIn(e.target); if (!isNaN(v)) { setParam('hOpen', v); persist(); redraw(); fillInputs(true); } });
['p_relFL', 'p_relAGL', 'j_relFL', 'j_relAGL', 'j_hOpen'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); }));

// ---------- Onglet Zones : axe imposé, altitude du terrain, ancien vecteur ----------
$('z_axisOn').addEventListener('change', e => { current.axis.on = e.target.checked; current.headingOverride = null; current.reversed = false; current.offsetManual = null; persist(); fillInputs(); redraw(); });
$('z_axisBoth').addEventListener('change', e => { current.axis.both = e.target.checked; persist(); redraw(); });
$('z_axisMag').addEventListener('change', e => { const v = numIn(e.target); if (isNaN(v)) return; current.axis.mag = n360(v); current.axis.on = true; current.headingOverride = null; current.offsetManual = null; persist(); fillInputs(); redraw(); });
$('z_elev').addEventListener('change', e => { const raw = e.target.value.trim(); current.elevManual = raw === '' ? null : numIn(e.target); if (isNaN(current.elevManual)) current.elevManual = null; persist(); fillInputs(); redraw(); });

// ---------- Bascules rapides sur la carte ----------
function syncQuick() {
  const p = current.params;
  const flQ = sol && sol.flRel ? Math.round(sol.flRel) : Math.round(p.relMode === 'FL' ? p.relFL : aglToFl(+p.relAGL, prof, elevOf(current, wxRec)));
  const AC_SHORT = { pc6: 'PC-6', c208: 'Caravan', dhc6: 'Twin', cn235: 'CN235', a400: 'A400M' }, acT = AIRCRAFT[p.acType] && Math.round(p.acMs * KT) === AIRCRAFT[p.acType][1] ? AC_SHORT[p.acType] : `${Math.round(p.acMs * KT)} kt`;
  $('qWhen').innerHTML = `🕑 ${fmtWhen(current.when)}<br><b>FL${flQ}</b><br>ouv. ${fmtInt(p.hOpen)} m<br>✈ ${acT}`; // un seul bouton : date, heure, largage, ouverture
  $('qZero').classList.toggle('on', zeroWind);
  $('qRelax').classList.toggle('on', !!current.show.relax); $('qLabel').classList.toggle('on', current.show.label !== false); $('qTicks').classList.toggle('on', !!current.show.rose);
  $('qRev').classList.toggle('on', !!current.reversed);
  $('qPrv').textContent = 'PRV auto'; $('qPrv').classList.toggle('hidden', !current.prvManual); // n'apparaît qu'après un choix manuel
  $('qVecAuto').classList.toggle('hidden', typeof current.offsetManual !== 'number');
  $('qWinds').classList.toggle('on', !$('windsBox').classList.contains('hidden'));
}
function quick(fn, msg) { fn(); syncQuick(); persist(); redraw(); if (msg) toast(msg()); }
$('qLabel').addEventListener('click', () => quick(() => { current.show.label = current.show.label === false; }, () => current.show.label !== false ? 'Infos du vecteur affichées' : 'Infos du vecteur masquées'));
$('qTicks').addEventListener('click', () => quick(() => { current.show.rose = !current.show.rose; }, () => current.show.rose ? 'Rosace en degrés magnétiques autour du vecteur' : 'Rosace masquée'));
$('qRelax').addEventListener('click', () => quick(() => { current.show.relax = !current.show.relax; }, () => current.show.relax ? 'Zone de relaxation affichée' : 'Zone de relaxation masquée'));
$('qRev').addEventListener('click', () => quick(() => { current.reversed = !current.reversed; current.offsetManual = null; },
  () => current.reversed ? (current.axis.on && !current.axis.both ? '⚠️ Sens inversé : la zone n\'autorise pas cet axe dans ce sens' : 'Sens de l\'axe inversé') : 'Sens normal'));
$('qPrv').addEventListener('click', () => { if (!current.prvManual) return toast('PRV automatique (le plus au vent). Appui long sur un PRV pour le choisir à la main.'); quick(() => { current.prvManual = null; current.offsetManual = null; }, () => 'PRV automatique (le plus au vent)'); });
$('qVecAuto').addEventListener('click', () => quick(() => { current.offsetManual = null; current.tManual = null; }, () => 'Vecteur replacé au mieux (le plus long)'));

// ---------- Saut : date, heure, hauteurs (sur la carte) ----------
function syncJump() {
  if (document.activeElement !== $('j_date')) $('j_date').value = current.when.slice(0, 10);
  $('j_hour').value = current.when.slice(11, 13);
  $('wxInfo').innerHTML = (current.holdWx ? `<b class="warn">Vecteur gardé du ${fmtWhen(current.when)}</b><br>` : '') + wxStatus(wxRec, current.when);
}
const fmtFetched = ts => { const d = new Date(ts); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} à ${pad2(d.getHours())}h${pad2(d.getMinutes())}`; };
const wxFailed = {}; // jour → dernier téléchargement raté
function wxStatus(rec, when) {
  if (!rec) return navigator.onLine === false || wxFailed[when.slice(0, 10)] ? '⚠️ Pas de réseau et aucune prévision gardée pour ce jour.' : 'Prévision en cours de téléchargement…';
  const st = fmtFetched(rec.fetched);
  const ok = (rec.hourly.time || []).includes(when);
  return `${rec.model.split(' (')[0]} · prévision du ${st}${Date.now() - rec.fetched > 3 * 3600e3 ? ' <b class="warn">(ancienne : mets à jour si tu as du réseau)</b>' : ''}${ok ? '' : ' <b class="warn">(pas de donnée à cette heure)</b>'}`;
}
let wxBusy = false;
async function ensureWx(force, date) {
  date = date || current.when.slice(0, 10);
  const have = wxCached(current.id, date);
  if (have && !force && (current.holdWx || Date.now() - have.fetched < 3600e3)) return have; // vecteur gardé : prévision figée
  if (wxBusy) return have; wxBusy = true; $('wxInfo').innerHTML = 'Téléchargement de la prévision…';
  try { const r = await wxFetch(current, date); delete wxFailed[date]; persist(); return r; }
  catch (e) { wxFailed[date] = true; toast(have ? 'Pas de réseau : prévision gardée, téléchargée le ' + fmtFetched(have.fetched) : 'Prévision impossible à télécharger (réseau ?)'); return have; }
  finally { wxBusy = false; redraw(); setTimeout(() => fillInputs(true), 0); syncJump(); }
}
function setWhen(w) { current.holdWx = false; current.when = w; current.offsetManual = null; persist(); redraw(); syncJump(); ensureWx(false); }
$('qWhen').addEventListener('click', () => { const b = $('jumpBox'); b.style.left = Math.round($('quick').getBoundingClientRect().right + 6) + 'px'; b.classList.toggle('hidden'); }); // fenêtre calée à droite de la colonne, quelle que soit sa largeur
$('jumpOk').addEventListener('click', () => { $('jumpBox').classList.add('hidden'); if (sol && sol.ok) fitFigure(); });
$('j_minus').addEventListener('click', () => setWhen(shiftWhen(current.when, -1)));
$('j_plus').addEventListener('click', () => setWhen(shiftWhen(current.when, 1)));
$('j_now').addEventListener('click', () => { current.holdWx = false; current.when = nowWhen(); persist(); syncJump(); ensureWx(true); });
$('j_date').addEventListener('change', e => { if (e.target.value) setWhen(e.target.value + current.when.slice(10)); });
$('j_hour').addEventListener('change', e => setWhen(current.when.slice(0, 11) + e.target.value + ':00'));

// ---------- Tableau des vents (date et heure indépendantes de la carte) ----------
let tWhen = null;
function renderWinds() {
  const date = tWhen.slice(0, 10), rec = wxCached(current.id, date), elev = elevOf(current, rec), pr = wxProfile(rec, tWhen, elev);
  $('t_date').value = date; $('t_hour').value = tWhen.slice(11, 13);
  $('t_info').innerHTML = wxStatus(rec, tWhen) + (rec ? ` · terrain ${Math.round(elev)} m` : '');
  const tb = $('windsTable').querySelector('tbody'); tb.innerHTML = '';
  if (!pr) { tb.innerHTML = '<tr><td colspan="6" class="mut">Pas de donnée pour cette heure.</td></tr>'; return; }
  windRows(pr, elev).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.lab}</td><td>${fmtInt(r.h)} m</td><td>${hdgN(r.dir)}</td><td>${Math.round(r.spd * KT)} kt</td><td>${fmt1(r.spd)} m/s</td><td>${r.T == null ? '–' : Math.round(r.T) + ' °C'}</td>`; // unité à côté de chaque chiffre
    tb.append(tr);
  });
}
function windRows(pr, elev) { // une ligne par tranche de 1 000 ft (FL), de la surface à ~10 000 m sol
  const rows = [], add = (lab, h) => { const w = spdDir(windAt(pr, h)); rows.push({ lab, h, dir: w.dir, spd: w.spd, T: tempAt(pr, h) }); };
  add('Sol (10 m)', 10);
  const fl0 = Math.ceil(aglToFl(30, pr, elev) / 10) * 10;
  for (let fl = Math.max(10, fl0); fl <= 400; fl += 10) { const h = flToAgl(fl, pr, elev); if (h > 10000) break; if (h > 20) add('FL' + String(fl).padStart(3, '0'), h); }
  return rows;
}
async function setTWhen(w) { tWhen = w; renderWinds(); const d = w.slice(0, 10); if (!wxCached(current.id, d) || Date.now() - wxCached(current.id, d).fetched > 3600e3) { await ensureWx(false, d); renderWinds(); } }
$('qWinds').addEventListener('click', () => { const b = $('windsBox'); if (!b.classList.contains('hidden')) { b.classList.add('hidden'); syncQuick(); return; } b.classList.remove('hidden'); syncQuick(); setTWhen(current.when); });
$('t_close').addEventListener('click', () => { $('windsBox').classList.add('hidden'); syncQuick(); });
$('t_minus').addEventListener('click', () => setTWhen(shiftWhen(tWhen, -1)));
$('t_plus').addEventListener('click', () => setTWhen(shiftWhen(tWhen, 1)));
$('t_now').addEventListener('click', () => setTWhen(nowWhen()));
$('t_date').addEventListener('change', e => { if (e.target.value) setTWhen(e.target.value + tWhen.slice(10)); });
$('t_hour').addEventListener('change', e => setTWhen(tWhen.slice(0, 11) + e.target.value + ':00'));

// ---------- Placement des PRV : en touchant la carte ----------
function syncPlaceBtn() { $('btnPlaceP').classList.toggle('on', placing === 'P'); }
function placeBanner() { setBanner(placing === 'P' ? 'Touche la carte pour placer le point de rendez-vous.' : null); }
$('btnPlaceP').addEventListener('click', () => {
  if (placing === 'P') { placing = null; placeBanner(); syncPlaceBtn(); return; }
  if (!current.id) return toast('Crée ou ouvre d\'abord une zone');
  stopMeasure(); placing = 'P'; syncPlaceBtn(); placeBanner(); closeSheet();
});

// À l'ouverture d'une zone : vecteur déjà calculé → l'afficher ou mettre à jour à maintenant
// Réponse « Garder » mémorisée 10 min : un rechargement automatique (nouvelle version installée juste après le démarrage)
// ne doit pas reposer la question (bug : il fallait répondre deux fois).
const keptKey = () => 'vl.kept.' + (current.id || 'tmp');
async function askOldVector(atStartup) {
  const v = current.vector, now = nowWhen();
  if (!v || !v.when || v.when === now) { current.when = now; current.holdWx = false; return; }
  if (atStartup) { let k = null; try { k = JSON.parse(sessionStorage.getItem(keptKey()) || 'null'); } catch (e) {}
    if (k && k.when === v.when && Date.now() - k.t < 600e3) { current.when = v.when; current.holdWx = true; return; } }
  const r = await ask(`Un vecteur de largage est enregistré pour cette zone (saut du ${fmtWhen(v.when)}).`, undefined, null, 'Mettre à jour à maintenant', 'Garder ce vecteur');
  if (r !== true) { try { sessionStorage.setItem(keptKey(), JSON.stringify({ when: v.when, t: Date.now() })); } catch (e) {}
    current.when = v.when; current.holdWx = true; persist(); redraw(); syncJump(); return; } // gardé tel quel, avec sa date et son heure
  current.holdWx = false; current.when = now; persist(); redraw(); syncJump(); ensureWx(true);
}

// ---------- Mesure : cap et distance entre deux points touchés (dans l'ordre) ----------
const measLayer = L.layerGroup().addTo(map);
const meas = { active: false, a: null, b: null, ma: null, mb: null, line: null, halo: null, lbl: null };
function capDeg(a, b) { // cap initial (orthodromie) de a vers b, en degrés
  const r = Math.PI / 180, f1 = a.lat * r, f2 = b.lat * r, dl = (b.lng - a.lng) * r;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2).replace('.', ',')} km`; }
function measBox(t) { const b = $('measureBox'); if (!t) b.classList.add('hidden'); else { b.innerHTML = t; b.classList.remove('hidden'); } }
function stopMeasure() {
  Object.assign(meas, { active: false, a: null, b: null, ma: null, mb: null, line: null, halo: null, lbl: null });
  measLayer.clearLayers(); measBox(null); $('qMeasure').classList.remove('on');
}
$('qMeasure').addEventListener('click', () => {
  if (meas.active) { stopMeasure(); return; }
  if (placing) return toast('Termine d\'abord le placement en cours');
  meas.active = true; $('qMeasure').classList.add('on');
  measBox('Mesure : touche le <b>1er point</b>');
});
// Points de mesure déplaçables (comme les portes) : la mesure se met à jour pendant le glissement
const measIcon = L.divIcon({ className: 'measpt', iconSize: [34, 34], iconAnchor: [17, 17], html: '<span></span>' });
function measMarker(key) {
  const m = L.marker(LL(meas[key]), { draggable: false, icon: measIcon, zIndexOffset: 900 }).addTo(measLayer);
  longPressDrag(m, ll => { meas[key] = ll; updateMeasure(); }, () => {});
  return m;
}
function updateMeasure() {
  if (!meas.a || !meas.b) return;
  const a = meas.a, b = meas.b, d = map.distance(LL(a), LL(b)), mid = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
  const c = capDeg(a, b); // cap vrai, affiché en magnétique par hdg
  const txt = `${hdg(c)} · ${fmtDist(d)}`;
  if (!meas.line) {
    meas.halo = L.polyline([LL(a), LL(b)], { color: '#000', weight: 3.5, opacity: .5, interactive: false }).addTo(measLayer);
    meas.line = L.polyline([LL(a), LL(b)], { color: '#00e5ff', weight: 2, dashArray: '8 6', interactive: false }).addTo(measLayer);
    meas.lbl = L.marker(mid, { interactive: false, icon: L.divIcon({ className: 'measlbl', iconSize: [0, 0], html: `<span>${txt}</span>` }) }).addTo(measLayer);
  } else {
    meas.halo.setLatLngs([LL(a), LL(b)]); meas.line.setLatLngs([LL(a), LL(b)]); meas.lbl.setLatLng(mid);
    const el = meas.lbl.getElement && meas.lbl.getElement(); if (el) el.querySelector('span').textContent = txt;
  }
  measBox(`<b>Cap ${hdg(c)} · ${fmtDist(d)}</b><br><small>Appui long sur un point puis glisse pour ajuster · 📏 = effacer</small>`);
}
function measureClick(p) {
  if (!meas.a) { meas.a = p; meas.ma = measMarker('a'); measBox('Mesure : touche le <b>2e point</b>'); return; }
  if (!meas.b) { meas.b = p; meas.mb = measMarker('b'); updateMeasure(); }
  // une fois les deux points posés, on les déplace au doigt ; un appui sur la carte ne fait rien
}

map.on('click', e => {
  if (Date.now() < suppressClickUntil) return; // fin d'un déplacement de point : pas un appui
  if ((typeof Photo !== 'undefined') && Photo.onMapClick(e)) return; // calage d'une photo aérienne en cours
  if (!placing && meas.active) { measureClick({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
  if (!placing) return;
  const p = { lat: e.latlng.lat, lng: e.latlng.lng };
  placing = null; placeBanner(); syncPlaceBtn();
  addPrv(p);
});

map.on('zoomend', redraw);
(function delayTouchRotate() {
  const TG = map.touchGestures; if (!TG || !TG._onTouchStart) return;
  const ROT_HOLD_MS = 300, ROT_TOL = 12; // doigts quasi immobiles pendant 0,3 s → la rotation s'active
  const cp = t => map.mouseEventToContainerPoint(t);
  const origStart = TG._onTouchStart, origMove = TG._onTouchMove;
  TG._onTouchStart = function (e) {
    origStart.call(this, e);
    this._rotPending = null;
    if (this._rotating) { // le plug-in voulait tourner tout de suite : on met en attente
      this._rotating = false;
      this._rotPending = { t: Date.now(), p1: cp(e.touches[0]), p2: cp(e.touches[1]) };
    }
  };
  TG._onTouchMove = function (e) {
    const rp = this._rotPending;
    if (rp && e.touches && e.touches.length === 2) {
      const p1 = cp(e.touches[0]), p2 = cp(e.touches[1]);
      const d = Math.max(p1.distanceTo(rp.p1), p2.distanceTo(rp.p2));
      if (d > ROT_TOL) {
        if (Date.now() - rp.t >= ROT_HOLD_MS) { // doigts restés immobiles assez longtemps : on tourne
          const v = rp.p1.subtract(rp.p2);
          this._startTheta = Math.atan(v.x / v.y);
          this._startBearing = map.getBearing() + (v.y < 0 ? 180 : 0);
          this._rotating = true;
        }
        this._rotPending = null; // sinon : déplacement / zoom à deux doigts, sans rotation
      }
    }
    return origMove.call(this, e);
  };
  TG.disable(); TG.enable(); // ré-abonne les écouteurs aux versions modifiées
})();
// Rotation du téléphone : Leaflet doit relire la taille de l'écran
['resize', 'orientationchange'].forEach(ev => window.addEventListener(ev, () => setTimeout(() => map.invalidateSize({ animate: false }), 250)));

let sheetSize = 'full';
function setSheetSize(sz) { sheetSize = sz; $('sheet').classList.toggle('mini', sz === 'mini'); $('sheet').classList.toggle('full', sz === 'full'); }
(function sheetGrab() {
  const g = $('grab'); let y0 = null, moved = false;
  const start = y => { y0 = y; moved = false; };
  const end = y => {
    if (y0 === null) return; const dy = y - y0; y0 = null;
    if (Math.abs(dy) < 12) { setSheetSize(sheetSize === 'full' ? 'mini' : 'full'); return; } // simple toucher : bascule
    if (dy < 0) setSheetSize('full');                                        // vers le haut : grand
    else if (sheetSize === 'full') setSheetSize('mini');                     // vers le bas : réduit…
    else closeSheet();                                                       // …puis fermé
  };
  g.addEventListener('touchstart', e => start(e.touches[0].clientY), { passive: true });
  g.addEventListener('touchend', e => end(e.changedTouches[0].clientY));
  g.addEventListener('mousedown', e => start(e.clientY));
  window.addEventListener('mouseup', e => end(e.clientY));
})();
let lastTab = 'zones';
function openSheet(tab) {
  lastTab = tab;
  $('sheet').classList.remove('hidden'); setSheetSize(sheetSize);
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['zones', 'params'].forEach(t => $('tab-' + t).classList.toggle('hidden', t !== tab));
  if (tab === 'zones') renderZones();
}
function closeSheet() { $('sheet').classList.add('hidden'); }
// Les deux boutons en haut à gauche ouvrent leur onglet ; second appui sur le même = fermer
function toggleTab(t) { if (!$('sheet').classList.contains('hidden') && lastTab === t) closeSheet(); else openSheet(t); }
$('btnParams').addEventListener('click', () => toggleTab('params'));
$('btnZones').addEventListener('click', () => toggleTab('zones'));
$('btnClose').addEventListener('click', closeSheet);
document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => openSheet(b.dataset.tab)));


// Petite fenêtre : texte, champ facultatif, 3e bouton facultatif (renvoie 'DELETE'), libellés au choix
// cancelLabel === false : pas de bouton Annuler
function ask(text, def, delLabel, okLabel, cancelLabel) {
  return new Promise(res => {
    $('dlgText').textContent = text; $('dlgInput').value = def || ''; $('dialog').classList.remove('hidden');
    $('dlgInput').classList.toggle('hidden', def === undefined);
    $('dlgDel').classList.toggle('hidden', !delLabel); $('dlgDel').textContent = delLabel || '';
    $('dlgOk').textContent = okLabel || 'OK';
    $('dlgCancel').classList.toggle('hidden', cancelLabel === false); $('dlgCancel').textContent = cancelLabel || 'Annuler';
    const done = v => { $('dialog').classList.add('hidden'); $('dlgOk').onclick = $('dlgCancel').onclick = $('dlgDel').onclick = null; res(v); };
    $('dlgOk').onclick = () => done(def === undefined ? true : $('dlgInput').value.trim());
    $('dlgCancel').onclick = () => done(null);
    $('dlgDel').onclick = () => done('DELETE');
    if (def !== undefined && !delLabel) setTimeout(() => $('dlgInput').focus(), 50);
  });
}

// ---------- Zones ----------
function renderZones() {
  const ul = $('zoneList'); ul.innerHTML = '';
  if (!zones.length) ul.innerHTML = '<li class="mut">Aucune zone enregistrée.</li>';
  zones.forEach(z => {
    const li = document.createElement('li');
    li.className = z.id === current.id ? 'cur' : ''; li.dataset.id = z.id;
    li.innerHTML = `<span class="zhandle" title="Glisser pour réordonner">≡</span><span class="zn">${esc(z.name)}</span>`;
    // Appui sur le nom = ouvrir la zone (carte centrée et cadrée comme ⤢)
    li.querySelector('.zn').onclick = () => loadZone(z.id);
    const off = document.createElement('span'); off.className = 'zoff';
    if (dlProgress[z.id]) off.innerHTML = `<small>⬇︎ ${dlProgress[z.id]}</small>`;
    else if (z.offline) {
      off.innerHTML = `<small>hors-ligne</small>`;
      const rm = document.createElement('button'); rm.className = 'zoffdel'; rm.textContent = '🗑'; rm.title = 'Supprimer les photos hors-ligne';
      rm.onclick = e => { e.stopPropagation(); removeOffline(z.id); };
      off.append(rm);
    } else if (z.prvs && z.prvs.length) {
      const dl = document.createElement('button'); dl.className = 'zoffdel'; dl.textContent = '⬇︎ hors-ligne'; dl.title = 'Télécharger les photos pour le hors-ligne';
      dl.onclick = e => { e.stopPropagation(); downloadOffline(z.id); };
      off.append(dl);
    }
    li.querySelector('.zn').append(off);
    const ren = document.createElement('button'); ren.textContent = '✎'; ren.onclick = async () => {
      const n = await ask('Nouveau nom :', z.name); if (!n) return;
      z.name = n; if (current.id === z.id) current.name = n; store.set('vl.zones', zones); persist(); fillInputs(); renderZones();
    };
    const del = document.createElement('button'); del.textContent = '🗑'; del.onclick = async () => {
      if (!(await ask(`Supprimer « ${z.name} » ?`))) return;
      zones = zones.filter(x => x.id !== z.id); store.set('vl.zones', zones); if ((typeof Photo !== 'undefined')) Photo.remove(z.id);
      if (current.id === z.id) { // la zone affichée disparaît : carte vide, au même endroit
        current = newZone(map.getCenter()); applyProfile(current); current.zoom = map.getZoom();
        resetMarkers(); placing = null; persist(); fillInputs(); redraw();
      }
      renderZones();
    };
    li.append(ren, del); ul.append(li);
    zoneReorder(li, li.querySelector('.zhandle'));
  });
}
// Réordonner les zones : on tient la poignée ≡ et on glisse la ligne vers le haut ou le bas
function zoneReorder(li, handle) {
  let y0 = 0, dy = 0, active = false;
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); active = true; y0 = e.clientY; dy = 0;
    try { handle.setPointerCapture(e.pointerId); } catch (er) {}
    li.classList.add('zdrag');
  });
  handle.addEventListener('pointermove', e => {
    if (!active) return;
    dy = e.clientY - y0; li.style.transform = `translateY(${dy}px)`;
    const ul = li.parentNode, rows = [...ul.children].filter(x => x !== li && x.dataset.id);
    const yMid = li.getBoundingClientRect().top + li.offsetHeight / 2;
    const before = rows.find(r => { const b = r.getBoundingClientRect(); return yMid < b.top + b.height / 2; });
    const nextSib = before || null;
    if (li.nextSibling !== nextSib) { // la ligne change de place : on recale le point de départ pour qu'elle reste sous le doigt
      const top0 = li.getBoundingClientRect().top - dy;
      ul.insertBefore(li, nextSib);
      li.style.transform = ''; const top1 = li.getBoundingClientRect().top;
      y0 += top1 - top0; dy = e.clientY - y0; li.style.transform = `translateY(${dy}px)`;
    }
  });
  const end = () => {
    if (!active) return; active = false;
    li.classList.remove('zdrag'); li.style.transform = '';
    const order = [...li.parentNode.children].map(x => x.dataset.id).filter(Boolean);
    zones.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    store.set('vl.zones', zones);
  };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
}
function loadZone(id) {
  const z = zones.find(x => x.id === id); if (!z) return;
  current = upgrade(clone(z)); applyProfile(current);
  resetMarkers(); placing = null; setBanner(null); stopMeasure();
  map.setBearing(current.bearing || 0);
  map.setView([current.center.lat, current.center.lng], Math.max(current.zoom || 17, 15));
  closeSheet(); fillInputs(); redraw(); persist();
  askOldVector().then(() => { compute(); if (sol && sol.ok) fitFigure(); else if (current.prvs.length) map.setView(LL(prvCentroid(current)), 15); ensureWx(false); });
}
// Nouvelle zone : on choisit d'abord où aller (rester ici, ma position ou recherche), puis on place les PRV
async function startNewZone(center, zoom) {
  $('nzDlg').classList.add('hidden');
  const n = await ask('Nom de la nouvelle zone (ex. Bouloc) :', ''); if (!n) return;
  current = newZone(center); applyProfile(current); current.zoom = zoom || 17;
  current.name = n; current.id = 'z' + Date.now(); current.updated = Date.now();
  zones.push(clone(current)); store.set('vl.zones', zones);
  resetMarkers(); stopMeasure();
  map.setView([center.lat, center.lng], current.zoom);
  placing = 'P'; fillInputs(); persist(); redraw(); closeSheet();
  toast(`« ${n} » créée : touche la carte pour placer le point de rendez-vous`);
}
$('btnNewZone').addEventListener('click', () => { $('searchResults').innerHTML = ''; $('nzDlg').classList.remove('hidden'); });
$('nzCancel').addEventListener('click', () => $('nzDlg').classList.add('hidden'));
$('nzMap').addEventListener('click', () => { const c = map.getCenter(); startNewZone({ lat: c.lat, lng: c.lng }, map.getZoom()); });
$('nzHere').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Géolocalisation indisponible');
  $('nzHere').textContent = '📍 Recherche de ta position…';
  navigator.geolocation.getCurrentPosition(pos => {
    $('nzHere').textContent = '📍 Ma position';
    startNewZone({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 17);
  }, () => { $('nzHere').textContent = '📍 Ma position'; toast('Position refusée ou indisponible'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
});

// ---------- Recherche ----------
function parseCoords(s) {
  const d = s.replace(/,/g, ' ').trim().split(/\s+/);
  if (d.length === 2 && d.every(x => /^-?\d+(\.\d+)?$/.test(x))) {
    const lat = +d[0], lng = +d[1]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  const m = s.match(/(\d+)[°\s]+(\d+)['’\s]+([\d.]+)?["”\s]*([NS])[\s,]+(\d+)[°\s]+(\d+)['’\s]+([\d.]+)?["”\s]*([EWO])/i);
  if (m) {
    const lat = (+m[1] + m[2] / 60 + (+m[3] || 0) / 3600) * (/s/i.test(m[4]) ? -1 : 1);
    const lng = (+m[5] + m[6] / 60 + (+m[7] || 0) / 3600) * (/[wo]/i.test(m[8]) ? -1 : 1);
    return { lat, lng };
  }
  return null;
}
async function doSearch() {
  const q = $('searchInput').value.trim(); if (!q) return;
  const ul = $('searchResults'); ul.innerHTML = '';
  const c = parseCoords(q);
  if (c) { startNewZone(c, 17); return; }
  // 1) Clubs FFP enregistrés dans l'appli (sans réseau), proposés en premier
  const clubs = typeof searchClubs === 'function' ? searchClubs(q) : [];
  clubs.forEach(k => {
    const li = document.createElement('li'); const b = document.createElement('button');
    b.className = 'res club'; b.innerHTML = `<b>🪂 ${esc(k.n)}</b><br><small>Club FFP · ${esc(k.v)}</small>`;
    b.onclick = () => startNewZone({ lat: k.lat, lng: k.lng }, 16);
    li.append(b); ul.append(li);
  });
  // 2) Puis la recherche de lieux habituelle
  const wait = document.createElement('li'); wait.className = 'mut'; wait.textContent = 'Recherche…'; ul.append(wait);
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=8&accept-language=fr&q=' + encodeURIComponent(q));
    const js = await r.json(); wait.remove();
    if (!js.length && !clubs.length) ul.innerHTML = '<li class="mut">Rien trouvé.</li>';
    js.forEach(x => {
      const li = document.createElement('li'); const b = document.createElement('button');
      b.className = 'res'; b.textContent = x.display_name;
      b.onclick = () => startNewZone({ lat: +x.lat, lng: +x.lon }, 16);
      li.append(b); ul.append(li);
    });
  } catch (e) { wait.textContent = clubs.length ? 'Autres lieux : pas de réseau.' : 'Recherche impossible (pas de réseau ?). Tu peux taper des coordonnées.'; }
}
$('btnSearch').addEventListener('click', doSearch);
$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// ---------- Position ----------
function locate(center) {
  if (!navigator.geolocation) { toast('Géolocalisation indisponible'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (posMarker) posMarker.setLatLng(ll);
    else posMarker = L.circleMarker(ll, { radius: 6, color: '#fff', weight: 1.5, fillColor: '#2f80ff', fillOpacity: 1 }).addTo(map);
    if (center) map.setView(ll, Math.max(map.getZoom(), 17));
  }, () => { if (center) toast('Position refusée ou indisponible'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}
$('btnLocate').addEventListener('click', () => locate(true));

// Boussole : nord en haut. leaflet-rotate : setBearing(b) tourne la carte de +b, donc le cap h est en haut avec b = -h.
const normB = x => ((x % 360) + 360) % 360, diffB = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
function setMapBearing(b, msg) { map.setBearing(b); current.bearing = b; syncCompass(); persist(); if (msg) toast(msg); }
$('btnNorth').addEventListener('click', () => setMapBearing(0, 'Nord en haut'));
// Bouton « Axe » : l'axe de largage (sens de vol) vers le haut
$('btnAxisUp').addEventListener('click', () => {
  if (!sol || !sol.ok) return toast('Pas encore de vecteur');
  setMapBearing(normB(-sol.heading), `Axe de largage (${hdg(sol.heading)}) vers le haut`);
});
$('btnFit').addEventListener('click', () => { if (figurePoints().length) fitFigure(); else toast('Place d\'abord un point de rendez-vous'); });

// ---------- Images satellite (cache commun carte / hors-ligne / PDF) ----------
const tileUrl = (z, x, y, src) => BASEMAPS[src || basemap].url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
async function getTileBlob(url) {
  // Réponse lisible (CORS) obligatoire pour pouvoir dessiner l'image dans le PDF
  if ('caches' in window) {
    try {
      const c = await caches.open(TILE_CACHE); const hit = await c.match(url);
      if (hit && hit.type !== 'opaque') return await hit.blob();
      const r = await fetch(url, { mode: 'cors' });
      if (r.ok) { c.put(url, r.clone()).catch(() => {}); return await r.blob(); }
    } catch (e) { /* on tente sans cache */ }
  }
  const r = await fetch(url, { mode: 'cors' }); if (!r.ok) throw new Error('tuile'); return r.blob();
}
function tilesAround(center, radiusM, zmin, zmax, src) {
  const list = [];
  for (let z = zmin; z <= zmax; z++) {
    const n = Math.pow(2, z);
    const xt = lng => Math.floor((lng + 180) / 360 * n);
    const yt = lat => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
    const nw = Geo.fromLocal(center, { x: -radiusM, y: radiusM }), se = Geo.fromLocal(center, { x: radiusM, y: -radiusM });
    for (let x = xt(nw.lng); x <= xt(se.lng); x++) for (let y = yt(nw.lat); y <= yt(se.lat); y++) list.push(tileUrl(z, x, y, src));
  }
  return list;
}
// Photos gardées hors-ligne pour une zone : autour des PRV (1 km en détail jusqu'au zoom 18, 6 km en large)
function offlineTiles(z, src) {
  const center = z.prvs && z.prvs.length ? prvCentroid(z) : z.center;
  return [...new Set(tilesAround(center, 1000, 12, 18, src).concat(tilesAround(center, 6000, 11, 15, src)))];
}
// Retirer le hors-ligne d'une zone : on efface ses photos, sauf celles qui servent à une autre zone gardée hors-ligne
async function removeOffline(id) {
  const z = id === current.id ? current : zones.find(x => x.id === id); if (!z) return;
  if (!(await ask(`Supprimer les photos hors-ligne de « ${z.name} » ? La zone reste enregistrée, la carte ne s'affichera plus qu'avec du réseau.`))) return;
  const keep = new Set();
  zones.filter(x => x.id !== id && x.offline).forEach(x => Object.keys(BASEMAPS).forEach(b => offlineTiles(x, b).forEach(u => keep.add(u))));
  let n = 0;
  if ('caches' in window) {
    const c = await caches.open(TILE_CACHE);
    for (const b of Object.keys(BASEMAPS)) for (const u of offlineTiles(z, b)) if (!keep.has(u) && await c.delete(u)) n++;
  }
  z.offline = null;
  const i = zones.findIndex(x => x.id === id); if (i >= 0) zones[i].offline = null;
  if (current.id === id) current.offline = null;
  store.set('vl.zones', zones); persist(); renderZones();
  toast(`Photos hors-ligne supprimées (${n})`);
}
const dlProgress = {}; // id de zone → « 120/1193 » pendant le téléchargement
async function downloadOffline(id) {
  if (!('caches' in window)) { toast('Hors-ligne non pris en charge ici'); return; }
  if (dlProgress[id]) return;
  const z = id === current.id ? current : zones.find(x => x.id === id); if (!z || !z.prvs || !z.prvs.length) return;
  const uniq = offlineTiles(z), total = uniq.length;
  if (!(await ask(`Télécharger les photos de « ${z.name} » pour le hors-ligne : ${total} images, environ ${Math.round(total * 25 / 1024)} Mo ?`))) return;
  let done = 0, fail = 0; dlProgress[id] = `0/${total}`; renderZones();
  const worker = async () => {
    while (uniq.length) {
      const u = uniq.shift();
      try { await getTileBlob(u); } catch (e) { fail++; }
      done++; if (done % 20 === 0) { dlProgress[id] = `${done}/${total}`; renderZones(); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  delete dlProgress[id];
  const date = new Date().toLocaleDateString('fr-FR');
  const i = zones.findIndex(x => x.id === id); if (i >= 0) { zones[i].offline = date; store.set('vl.zones', zones); }
  if (current.id === id) { current.offline = date; persist(); }
  renderZones();
  toast(fail ? `« ${z.name} » : ${fail} images manquées, relance plus tard pour compléter` : `« ${z.name} » disponible hors-ligne`);
  if (fail) { if (i >= 0) zones[i].offline = null; if (current.id === id) current.offline = null; store.set('vl.zones', zones); persist(); renderZones(); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}


// ---------- Export PDF ----------
let jsPdfLoading = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve();
  if (!jsPdfLoading) jsPdfLoading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/jspdf.umd.min.js'; s.onload = res; s.onerror = rej; document.head.append(s);
  });
  return jsPdfLoading;
}
function dateStamp() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }
function safeName(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'zone'; }


// Le haut de la page = le sens de vol sur le vecteur (axe de largage)
function pdfUpBearing() { return sol && sol.ok ? sol.heading : 0; }

async function renderPdfCanvas() {
  const pts = figurePoints();
  const CRS = L.CRS.EPSG3857;
  const Z0 = 19; // pixels « monde » au zoom 19
  const th = pdfUpBearing() * Math.PI / 180, cosT = Math.cos(th), sinT = Math.sin(th);
  const P = pts.map(p => CRS.latLngToPoint(L.latLng(p.lat, p.lng), Z0));
  const c0 = { x: P.reduce((a, p) => a + p.x, 0) / P.length, y: P.reduce((a, p) => a + p.y, 0) / P.length };
  // Rotation monde → page : le cap « th » pointe vers le haut de la page
  const rot = q => { const dx = q.x - c0.x, dy = q.y - c0.y; return { x: dx * cosT + dy * sinT, y: -dx * sinT + dy * cosT }; };
  const unrot = r => ({ x: c0.x + r.x * cosT - r.y * sinT, y: c0.y + r.x * sinT + r.y * cosT });
  const R = P.map(rot);
  const minX = Math.min(...R.map(p => p.x)), maxX = Math.max(...R.map(p => p.x));
  const minY = Math.min(...R.map(p => p.y)), maxY = Math.max(...R.map(p => p.y));
  const fw = maxX - minX, fh = maxY - minY;
  // Portrait ou paysage : celui où la figure s'affiche le plus grand
  const fit = (W, H) => {
    const uu = W / 1000, lh = 12 * 1.5 * uu, band = Math.round(7.2 * lh);
    const availW = W * (1 - 2 * 0.1), availH = (H - band) * (1 - 2 * 0.08);
    return { W, H, band, s: Math.min(availW / Math.max(fw, 1), availH / Math.max(fh, 1)) };
  };
  const A = fit(3508, 2480), B = fit(2480, 3508);
  const landscape = A.s >= B.s;
  const { W, H, band, s } = landscape ? A : B;
  const fs = 12, lh = fs * 1.5 * (W / 1000);
  const cxr = (minX + maxX) / 2, cyr = (minY + maxY) / 2, mapCY = (H - band) / 2;
  const toPage = r => ({ x: W / 2 + (r.x - cxr) * s, y: mapCY + (r.y - cyr) * s });
  const toC = ll => toPage(rot(CRS.latLngToPoint(L.latLng(ll.lat, ll.lng), Z0)));
  const pageAngle = deg => deg * Math.PI / 180 - th; // un cap réel → angle sur la page (0 = haut)

  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#2b2b2b'; g.fillRect(0, 0, W, H);

  // Images satellite : zoom assez fin pour la résolution, au plus 19
  let z = Z0;
  while (z > 1 && s * Math.pow(2, Z0 - z) < 1) z--;
  const f = Math.pow(2, Z0 - z);
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([X, Y]) => unrot({ x: (X - W / 2) / s + cxr, y: (Y - mapCY) / s + cyr }));
  const wx0 = Math.min(...corners.map(p => p.x)) / f, wx1 = Math.max(...corners.map(p => p.x)) / f;
  const wy0 = Math.min(...corners.map(p => p.y)) / f, wy1 = Math.max(...corners.map(p => p.y)) / f;
  const jobs = [];
  let fails = 0;
  for (let tx = Math.floor(wx0 / 256); tx <= Math.floor(wx1 / 256); tx++)
    for (let ty = Math.floor(wy0 / 256); ty <= Math.floor(wy1 / 256); ty++) jobs.push({ tx, ty });
  g.save();
  g.translate(W / 2, mapCY); g.scale(s, s); g.translate(-cxr, -cyr); g.rotate(-th); g.translate(-c0.x, -c0.y);
  const run = async () => {
    while (jobs.length) {
      const { tx, ty } = jobs.shift();
      try {
        const img = await createImageBitmap(await getTileBlob(tileUrl(z, tx, ty)));
        const size = 256 * f;
        g.drawImage(img, tx * size, ty * size, size + 0.5 * f, size + 0.5 * f);
      } catch (e) { fails++; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, run));
  g.restore();
  if ((typeof Photo !== 'undefined')) { try { await Photo.drawPdf(g, toC); } catch (e) {} }

  // ---- Tracé ----
  const u = W / 1000;
  const pxPerM = ll => { const a = toC(ll), b = toC(Geo.fromLocal(ll, { x: 100, y: 0 })); return Math.hypot(b.x - a.x, b.y - a.y) / 100; };
  const shadowText = (txt, x, y, color, size, align) => {
    g.save(); g.font = `700 ${size * u}px -apple-system, Helvetica, Arial, sans-serif`; g.textBaseline = 'middle';
    const w = g.measureText(txt).width, m = 12 * u;
    if (!align) align = (x + w > W - m) ? 'right' : 'left';
    if (align === 'right' && x - w < m) x = m + w;
    if (align === 'left' && x + w > W - m) x = W - m - w;
    if (align === 'center') x = Math.min(Math.max(x, m + w / 2), W - m - w / 2);
    y = Math.min(Math.max(y, 20 * u), H - band - 14 * u);
    g.textAlign = align;
    g.lineWidth = size * u * 0.28; g.strokeStyle = isDark(color) ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.85)'; g.lineJoin = 'round'; g.strokeText(txt, x, y); g.fillStyle = color; g.fillText(txt, x, y); g.restore();
  };
  const dot = (ll, color, r) => {
    const c = toC(ll); g.save(); g.beginPath(); g.arc(c.x, c.y, r * u, 0, 2 * Math.PI); g.fillStyle = color; g.fill();
    g.lineWidth = 1.2 * u; g.strokeStyle = '#111'; g.stroke(); g.restore(); return c;
  };
  // ---- Zone de relaxation, PRV, vecteur ----
  const poly = (pts, stroke, fill, w, dash) => { if (!pts || pts.length < 3) return; g.save(); g.beginPath(); pts.forEach((ll, i) => { const q = toC(ll); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); }); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); } g.strokeStyle = stroke; g.lineWidth = w * u; g.setLineDash(dash ? dash.map(d => d * u) : []); g.stroke(); g.restore(); };
  if (current.show.relax) { poly(relaxPolygon(sol), C_RELAX, null, 2.6); poly(patatoidPolygon(sol), C_RELAX, null, 2.2, [8, 6]); }
  // PDF = même dessin que la carte, juste plus épais pour l'impression : PRV de même taille, l'inactif en transparence
  current.prvs.forEach(p => { const used = sol.prv && p.id === sol.prv.id; g.save(); g.globalAlpha = used ? 1 : 0.5; dot(p, used ? C_PRVUSED : C_PRV, 9); g.restore(); });
  { const a = toC(sol.start), b = toC(sol.end);
    g.save(); g.lineCap = 'round'; g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 10 * u; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.strokeStyle = '#000'; g.lineWidth = 5 * u; g.stroke(); g.restore();
    dot(sol.start, C_START, 9); dot(sol.end, C_END, 9); // même taille que les PRV, comme à l'écran
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, ne = sol.exits ? sol.exits.n : 1;
    /* PDF : jamais de cartouche sur la carte, tout est dans le bandeau d'informations */ }
  if (current.show.rose) { // rosace en degrés magnétiques
    const ro = roseOf(sol), c = toC(ro.c), Rr = ro.R * pxPerM(ro.c);
    g.save(); g.strokeStyle = '#fff'; g.globalAlpha = .85; g.lineWidth = 1.4 * u; g.setLineDash([4 * u, 6 * u]);
    g.beginPath(); g.arc(c.x, c.y, Rr, 0, 2 * Math.PI); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    Geo.degTicks(Rr / u, 40).forEach(deg => {
      const a = pageAngle(deg + sol.decl), l = 11 * u;
      g.beginPath(); g.moveTo(c.x + Rr * Math.sin(a), c.y - Rr * Math.cos(a)); g.lineTo(c.x + (Rr - l) * Math.sin(a), c.y - (Rr - l) * Math.cos(a)); g.stroke();
      shadowText(`${deg}°`, c.x + (Rr + 16 * u) * Math.sin(a), c.y - (Rr + 16 * u) * Math.cos(a), '#fff', 11, 'center');
    });
    g.restore();
  }

  // ---- Flèche du nord (coin haut gauche) ----
  const nx = 85 * u, ny = 95 * u, na = pageAngle(0);
  g.save(); g.fillStyle = 'rgba(0,0,0,.6)'; g.beginPath(); g.arc(nx, ny, 40 * u, 0, 2 * Math.PI); g.fill();
  g.translate(nx, ny); g.rotate(na);
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -30 * u); g.lineTo(-12 * u, 12 * u); g.lineTo(0, 4 * u); g.lineTo(12 * u, 12 * u); g.closePath(); g.fill();
  g.restore();
  shadowText('N', nx + Math.sin(na) * 52 * u, ny - Math.cos(na) * 52 * u, '#fff', 13, 'center');

  // ---- Échelle graphique ----
  const by = H - band;
  const tx = (s2, x, y, c, size, bold, align) => { g.save(); g.font = `${bold ? 700 : 500} ${(size || fs) * u}px -apple-system, Helvetica, Arial, sans-serif`; g.fillStyle = c || '#eee'; g.textBaseline = 'middle'; g.textAlign = align || 'left'; g.fillText(s2, x, y); g.restore(); };
  const mppC = 1 / pxPerM(sol.start);
  const target = W * 0.18 * mppC, nice = [50, 100, 200, 250, 500, 1000, 2000, 5000].reduce((a, b) => (b <= target ? b : a), 50);
  const barW = nice / mppC, sx = 30 * u, sy = by - 28 * u;
  g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(sx - 10 * u, sy - 16 * u, barW + 100 * u, 32 * u);
  g.fillStyle = '#fff'; g.fillRect(sx, sy - 4 * u, barW, 8 * u); g.fillStyle = '#111'; g.fillRect(sx + barW / 2, sy - 3 * u, barW / 2 - 1 * u, 6 * u); g.restore();
  tx(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, sx + barW + 10 * u, sy, '#fff', 12, true);

  // ---- Bandeau d'informations ----
  g.save(); g.fillStyle = 'rgba(12,12,12,.85)'; g.fillRect(0, by, W, band); g.restore();
  const p = current.params;
  const col1 = 30 * u, col2 = W * 0.5, l0 = by + lh * 1.1;
  tx(`${current.name}`, col1, l0, '#fff', fs * 1.3, true);
  tx(`Saut du ${fmtWhen(current.when).replace(' ', ' à ')} · ${wxRec ? wxRec.model : ''}`, col1, l0 + lh * 1.2, '#bbb');
  const exP = sol.exits || { n: 1 };
  tx(`Vecteur ${hdg(sol.heading)} · ${fmtInt(sol.length)} m`, col1, l0 + lh * 2.4, '#fff', fs, true);
  tx(`${exP.n} sortie${exP.n > 1 ? 's' : ''}${exP.dt ? ` · une toutes les ${fmt1(exP.dt)} s (${fmtInt(exP.s)} m au sol, séparation ${exP.sep} m)` : ''}`, col1, l0 + lh * 3.4, C_PRVUSED, fs, true);
  tx(`Largage FL${Math.round(sol.flRel)} = ${fmtInt(sol.hRel)} m sol · ouverture ${fmtInt(p.hOpen)} m sol`, col1, l0 + lh * 4.4, C_END, fs, true);
  tx(`PRV ${sol.prvAuto ? 'automatique' : 'choisi à la main'} · ${sol.why}${current.reversed ? ' · sens inversé' : ''}`, col1, l0 + lh * 5.4, '#ffd400', fs);
  [
    (zeroWind ? 'TEST VENT FORCÉ À 0 · ' : '') + `Vent de largage : ${hdg(sol.windRel.dir)} ${Math.round(sol.windRel.spd * KT)} kt (${fmt1(sol.windRel.spd)} m/s) · ${acName()} ${Math.round(p.acMs * KT)} kt badin (${Math.round(sol.tas * KT)} kt vraie)`,
    `Chute ${p.vff} m/s · perte à l'ouverture ${p.openLoss} m`,
    `${p.perpTime} s perpendiculaire (sauf le dernier) · Vz ${fmt1(+p.vz)} m/s · finesse ${fmt1(+p.glide)}`,
    `Arrivée au PRV à ${p.hMin} m minimum · terrain ${Math.round(sol.elev)} m`,
    `Déclinaison ${fmt1(sol.decl)}° · vents détaillés en page 2`
  ].forEach((s2, i) => tx(s2, col2, l0 + i * lh, '#eee'));
  tx(`${BASEMAPS[basemap].attr} · prévision ${wxRec ? wxRec.model : ''} via Open-Meteo · vecteur-largage v${VERSION}`, W - 20 * u, H - 10 * u, '#888', 8, false, 'right');

  return { canvas: cv, landscape, fails };
}
// Page 2 du PDF : tableau des vents à l'heure du saut
function pdfWindsPage(doc) {
  const elev = elevOf(current, wxRec); if (!prof) return;
  doc.addPage('a4', 'portrait');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(`Vents – ${current.name} – ${fmtWhen(current.when).replace(' ', ' à ')}`, 15, 18);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(`${wxRec.model} via Open-Meteo, téléchargée le ${new Date(wxRec.fetched).toLocaleString('fr-FR')} · terrain ${Math.round(elev)} m`, 15, 25);
  const cols = [['Niveau', 15], ['Hauteur sol', 45], ['Vient du (M)', 85], ['Vitesse', 115], ['', 140], ['Temp.', 165]];
  let y = 35; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); cols.forEach(([t, x]) => doc.text(t, x, y)); doc.setFont('helvetica', 'normal');
  windRows(prof, elev).forEach((r, i) => {
    y += 6.6; if (y > 285) { doc.addPage('a4', 'portrait'); y = 20; }
    if (i % 2 === 0) { doc.setFillColor(238, 238, 238); doc.rect(13, y - 4.6, 184, 6.4, 'F'); }
    [r.lab, fmtInt(r.h).replace(/[\u202f\u00a0]/g, ' ') + ' m', hdgN(r.dir), Math.round(r.spd * KT) + ' kt', fmt1(r.spd) + ' m/s', r.T == null ? '–' : Math.round(r.T) + ' °C'].forEach((t, k) => doc.text(t, cols[k][1], y));
  });
}

let pdfFile = null;
$('btnPdf').addEventListener('click', async () => {
  compute(); if (!sol || !sol.ok) return toast(sol && sol.err ? sol.err : 'Pas encore de vecteur');
  const b = $('btnPdf'); b.disabled = true; const old = b.textContent; b.textContent = 'Préparation du PDF…';
  try {
    await loadJsPdf();
    const { canvas, landscape, fails } = await renderPdfCanvas();
    const doc = new window.jspdf.jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    const wmm = landscape ? 297 : 210, hmm = landscape ? 210 : 297;
    doc.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, wmm, hmm);
    pdfWindsPage(doc);
    const name = `${dateStamp()}_Vecteur_Largage_${safeName(current.name)}.pdf`;
    pdfFile = new File([doc.output('blob')], name, { type: 'application/pdf' });
    $('pdfName').textContent = name + (fails ? ` (${fails} morceaux de photo manquants)` : '');
    $('pdfReady').classList.remove('hidden');
  } catch (e) {
    console.error(e); toast('Échec du PDF : ' + (e && e.message ? e.message : 'erreur'));
  } finally { b.disabled = false; b.textContent = old; }
});
$('pdfClose').addEventListener('click', () => $('pdfReady').classList.add('hidden'));
$('pdfShare').addEventListener('click', async () => {
  if (!pdfFile) return;
  try {
    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) { await navigator.share({ files: [pdfFile] }); /* sans title : iOS en ferait un .txt en plus */ }
    else { const url = URL.createObjectURL(pdfFile); const a = document.createElement('a'); a.href = url; a.download = pdfFile.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    $('pdfReady').classList.add('hidden');
  } catch (e) { if (e && e.name !== 'AbortError') toast('Partage impossible'); }
});


// ---------- Sauvegarde ----------
// Exporter : fichier .json (zones + paramètres) proposé à la feuille de partage (Fichiers, AirDrop, mail…).
$('btnExport').addEventListener('click', async () => {
  persist();
  const data = JSON.stringify({ app: 'vecteur-largage', v: 3, exported: new Date().toISOString(), profile, zones }, null, 1);
  const name = `${dateStamp()}_Vecteur_Largage_zones.json`;
  const file = new File([data], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] }); /* sans title : iOS en ferait un .txt en plus */
    else { const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  } catch (e) { if (e && e.name !== 'AbortError') toast('Export impossible'); }
});
// Importer : ajoute les zones du fichier à celles déjà là (fusion, rien n'est effacé).
// Même zone des deux côtés → on garde la version la plus récente. Si l'appli est vide, on reprend aussi la manœuvre du fichier.
$('btnImport').addEventListener('click', () => { $('importFile').value = ''; $('importFile').click(); });
$('importFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.zones)) throw new Error('format');
    const wasEmpty = zones.length === 0;
    if (wasEmpty && d.profile) { PROFILE_KEYS.forEach(k => { if (d.profile[k] !== undefined) profile[k] = d.profile[k]; }); store.set('vl.profile', profile); }
    let added = 0, updated = 0;
    d.zones.map(upgrade).forEach(z => {
      if (!z.id) z.id = 'z' + Date.now() + Math.random().toString(36).slice(2, 6);
      applyProfile(z);
      const i = zones.findIndex(x => x.id === z.id);
      if (i < 0) { zones.push(z); added++; }
      else if ((z.updated || 0) > (zones[i].updated || 0)) { zones[i] = z; updated++; }
    });
    store.set('vl.zones', zones);
    if (wasEmpty) { applyProfile(current); fillInputs(); }
    renderZones(); redraw();
    toast(`Import : ${added} zone(s) ajoutée(s)${updated ? `, ${updated} mise(s) à jour` : ''}`);
  } catch (er) { toast('Fichier illisible'); }
});
// Tout effacer (zones, paramètres, zone en cours, prévisions) — les photos gardées hors-ligne restent.
$('btnWipe').addEventListener('click', async () => {
  if (!(await ask('Effacer TOUTES les données (zones enregistrées, paramètres, zone en cours, prévisions) ? C\'est définitif. Pense à exporter avant si besoin.'))) return;
  Object.keys(localStorage).filter(k => k.startsWith('vl.')).forEach(k => { try { localStorage.removeItem(k); } catch (er) {} });
  if ((typeof Photo !== 'undefined')) await Photo.clearAll();
  location.reload();
});

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- Démarrage ----------
$('ver').textContent = VERSION;
syncCompass();
fillInputs();
redraw();
if (!current.prvs.length && !current.id && current.zoom < 10) locate(true); else locate(false);
if (current.id) askOldVector(true).then(() => { compute(); if (sol && sol.ok) fitFigure(); fillInputs(); ensureWx(false); });
window.addEventListener('online', () => { if (current.id) ensureWx(false); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && current.id) ensureWx(false); });
// Mise à jour automatique : vérifie une nouvelle version à chaque retour sur l'appli et recharge dès qu'elle est installée
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').then(reg => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}

$('qZero').addEventListener('click', () => { zeroWind = !zeroWind; store.set('vl.zeroWind', zeroWind); current.offsetManual = null; compute(); redraw(); syncQuick(); fillInputs(true); if ($('windsBox') && !$('windsBox').classList.contains('hidden')) renderWinds(); toast(zeroWind ? 'Vent forcé à 0 partout (test)' : 'Vents de la prévision'); });
