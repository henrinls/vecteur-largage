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
const VERSION = '0.27.1';
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
  hOpen: 1000, relMode: 'FL', relFL: 140, relAGL: 4000,                  // utilisation
  hOpenLast: 1500                                                         // v0.27.0 : ouverture des paras de fin de passage pour le pointillé « ouverture haute » (Henri)
};
const PROFILE_KEYS = ['vff', 'openLoss', 'perpTime', 'vz', 'glide', 'hMin', 'margin', 'sep', 'acMs', 'acType', 'hOpen', 'relMode', 'relFL', 'relAGL', 'hOpenLast'];
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
  v.push('temperature_2m'); if (!minimal) v.push('relative_humidity_2m'); // humidité : pas dans la requête allégée (secours si refusée)
  if (!minimal && src.kind === 'mf') [20, 50, 100, 150, 200].forEach(h => v.push(`temperature_${h}m`));
  PLEV.forEach(p => v.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `temperature_${p}hPa`, `geopotential_height_${p}hPa`, ...(minimal ? [] : [`relative_humidity_${p}hPa`])));
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
  const rec = { date, fetched: Date.now(), model: used.name, elev: js.elevation, hourly: js.hourly, rh: Object.keys(js.hourly).some(k => /^relative_humidity/.test(k)) };
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
  hl.forEach(h => add(h, val(`wind_speed_${h}m`), val(`wind_direction_${h}m`), val(h === 10 ? 'temperature_2m' : `temperature_${h}m`), { RH: h === 10 ? val('relative_humidity_2m') : null }));
  const topH = lv.length ? lv[lv.length - 1].h : 0;
  const pz = [];
  PLEV.forEach(p => {
    const z = val(`geopotential_height_${p}hPa`); if (z == null) return;
    pz.push({ p, z });
    const h = z - elevUsed;
    if (h > topH + 30) add(h, val(`wind_speed_${p}hPa`), val(`wind_direction_${p}hPa`), val(`temperature_${p}hPa`), { p, RH: val(`relative_humidity_${p}hPa`) });
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
const SHOW_DEFAULT = { relax: true, label: true, rose: false, nm: false };
function upgrade(z) {
  if (!z) return z;
  z.params = Object.assign({}, DEFAULT_PARAMS, z.params || {});
  z.show = Object.assign({}, SHOW_DEFAULT, typeof z.show === 'object' && z.show ? z.show : {});
  z.prvs = Array.isArray(z.prvs) ? z.prvs : [];
  if (!z.dz || typeof z.dz.lat !== 'number') z.dz = null; // centre de la DZ (verticale terrain)
  z.axis = Object.assign({ on: false, mag: 0, both: true }, z.axis || {}); delete z.axis.ref;
  if (z.elevManual !== null && typeof z.elevManual !== 'number') z.elevManual = null;
  if (z.prvManual === undefined) z.prvManual = null;
  if (z.headingOverride === undefined) z.headingOverride = null; // cap vrai imposé à la main (Zones › Cap de largage, ou rotation par le vert / le rouge)
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
  if (typeof Undo !== 'undefined') Undo.record(); /* undo.js : photo de l'état après chaque enregistrement */
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
const NM = 1852;
const fmtNm = m => (Math.round(m / NM * 10) / 10).toFixed(1).replace('.', ',');
const CARD8 = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const card8 = dirTrue => CARD8[Math.round(n360(dirTrue - declCur()) / 45) % 8]; // point cardinal ou demi-point le plus proche (en magnétique)
const AU8 = { N: 'au N', NE: 'au NE', E: "à l'E", SE: 'au SE', S: 'au S', SO: 'au SO', O: "à l'O", NO: 'au NO' };
// Cercles tous les 0,1 NM jusqu'à 2 NM autour du centre de la DZ (Henri) : pointillés pour les dixièmes,
// trait plein pour 0,5 et 1,5, trait plus gras pour 1 et 2 ; valeur écrite sur chaque cercle aux 4 points cardinaux
function nmRingStyle(k) { return k % 10 === 0 ? { w: 2.2, dash: null, op: .95 } : k % 5 === 0 ? { w: 1.4, dash: null, op: .9 } : { w: 1, dash: [3, 5], op: .7 }; }
const nmLabel = k => (k % 10 === 0 ? String(k / 10) : (k / 10).toFixed(1).replace('.', ','));
function nmRings() {
  const c = current.dz, mpp = mPerPx(c), gap = 0.1 * NM / mpp; // écart entre deux cercles, en pixels
  for (let k = 1; k <= 20; k++) {
    const st = nmRingStyle(k), major = k % 5 === 0;
    if (!major && gap < 5) continue; // trop serrés à ce zoom : seulement 0,5 / 1 / 1,5 / 2
    L.circle(LL(c), { radius: k * 0.1 * NM, color: '#fff', weight: st.w, opacity: st.op, dashArray: st.dash ? st.dash.join(' ') : null, fill: false, interactive: false }).addTo(grads);
    if (major || gap >= 14) [[0, 1], [1, 0], [0, -1], [-1, 0]].forEach(([dx, dy]) => L.marker(LL(Geo.fromLocal(c, { x: dx * k * 0.1 * NM, y: dy * k * 0.1 * NM })), { interactive: false, icon: L.divIcon({ className: 'nmlbl', iconSize: [0, 0], html: `<span>${nmLabel(k)}</span>` }) }).addTo(grads)); // valeur aux 4 points cardinaux
  }
}
function dzText(sol, short) { // Henri : « 2,0 NM avant · décalé 0,2 NM au N », « Verticale · décalé 0,2 NM au N », « 0,5 NM après »
  const d = sol && sol.dzInfo; if (!d) return '';
  const a = Math.abs(d.along) / NM < 0.05 ? 'Verticale' : `${fmtNm(Math.abs(d.along))} ${d.along >= 0 ? 'avant' : 'après'}`; // en nautiques, sans l'unité (Henri)
  return d.lat / NM < 0.05 ? `${a} · plein axe` : `${a} · décalé ${fmtNm(d.lat)} ${short ? card8(d.dir) : AU8[card8(d.dir)]}`; // Henri : « 2,0 NM avant · plein axe », « Verticale · plein axe »
}
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
  // Centre de la DZ : distance du point vert avant la verticale (le long de l'axe) et décalage de l'axe (perpendiculaire), en nautiques
  out.dzInfo = null;
  if (z.dz) {
    const D = Geo.toLocal(ch.prv, z.dz), along = (D.x - A.x) * u.x + (D.y - A.y) * u.y; // > 0 : la verticale est devant le vert
    const P = { x: A.x + along * u.x, y: A.y + along * u.y }, off = { x: P.x - D.x, y: P.y - D.y }, lat = Math.hypot(off.x, off.y);
    out.dzInfo = { along, lat, dir: lat > 1 ? n360(Math.atan2(off.x, off.y) * 180 / Math.PI) : null };
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
const map = L.map('map', { zoomControl: false, maxZoom: 22, zoomSnap: 0.05, attributionControl: true,
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
  const phOn = !!($('bmPhoto') && $('bmPhoto').classList.contains('on')); $('bmEsri').classList.toggle('on', !phOn && basemap === 'esri'); $('bmIgn').classList.toggle('on', !phOn && basemap === 'ign');
  if (msg) toast(basemap === 'ign' ? 'Fond : photos aériennes IGN (France)' : 'Fond : satellite Esri (monde)');
}
setBasemap(basemap);
$('bmEsri').addEventListener('click', () => { if (typeof Photo !== 'undefined') Photo.hide(); setBasemap('esri', true); }); /* photo calée = 3e choix du fond (21 nov. 2026) */
$('bmIgn').addEventListener('click', () => { if (typeof Photo !== 'undefined') Photo.hide(); setBasemap('ign', true); }); /* photo calée = 3e choix du fond (21 nov. 2026) */
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
map.on('rotate', () => { syncCompass(); if (typeof drawBarb === 'function') { drawBarb(); drawGreenBarb(); } current.bearing = map.getBearing(); clearTimeout(rotT); rotT = setTimeout(persist, 400); });

const fig = L.layerGroup().addTo(map);
const grads = L.layerGroup().addTo(map);
let placing = null, posMarker = null; // placing : null | 'P' (PRV) | 'D' (centre de la DZ)
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
/* v0.27.0 (Henri) : si les paras de fin de passage ouvraient à p.hOpenLast (1 500 m par défaut) au lieu de la même hauteur que les autres,
   jusqu'où irait le rouge ? Même axe (cap, côté et place gardés), même PRV, seul l'ouverture change ; le vert ne bouge pas.
   Renvoie { end, d } : d > 0 = vecteur rallongé de d mètres (pointillé noir + trait), d < 0 = raccourci (trait rouge sur le vecteur). */
function highEnd(s, prof, rec) {
  const p = current.params, H = +p.hOpenLast;
  if (!s || !s.ok || !(H > +p.hOpen) || !(s.hRel > H)) return null;
  const z2 = Object.assign({}, current, { params: Object.assign({}, p, { hOpen: H }), headingOverride: s.heading, reversed: false, offsetManual: s.offsetUsed, tManual: s.tUsed, prvManual: s.prv.id });
  const s2 = solve(z2, prof, rec); if (!s2 || !s2.ok) return null;
  const u = s.u, e1 = Geo.toLocal(s.prv, s.end), e2 = Geo.toLocal(s.prv, s2.end), a = Geo.toLocal(s.prv, s.start);
  const t1 = e1.x * u.x + e1.y * u.y, t2 = e2.x * u.x + e2.y * u.y, ta = a.x * u.x + a.y * u.y, d = t2 - t1;
  if (Math.abs(d) < 1) return { end: s.end, d: 0 };
  const t = Math.max(ta, t2); /* jamais avant le vert */
  const sp = s.exits && s.exits.s, n = sp ? Math.floor((s.length + t - t1) / sp + 1e-6) + 1 : null; /* v0.27.1 (Henri) : nombre total de sorties, même intervalle (secondes) entre chaque */
  return { end: Geo.fromLocal(s.prv, { x: e1.x + (t - t1) * u.x, y: e1.y + (t - t1) * u.y }), d: t - t1, H, n };
}
function compute() {
  wxRec = wxCached(current.id, current.when.slice(0, 10));
  const elev = elevOf(current, wxRec);
  prof = wxProfile(wxRec, current.when, elev);
  const key = JSON.stringify([current.id, current.when, current.prvs, current.params, current.axis, current.elevManual, current.prvManual,
    current.headingOverride, current.reversed, current.offsetManual, current.tManual, elev, wxRec && wxRec.fetched, zeroWind, current.dz]);
  if (key !== solKey) { sol = solve(current, prof, wxRec); solKey = key; try { sol.hi = highEnd(sol, prof, wxRec); } catch (e) { sol.hi = null; } }
  if (sol.ok) current.vector = { when: current.when, start: sol.start, end: sol.end, heading: sol.heading, length: Math.round(sol.length), decl: sol.decl, prv: sol.prv.id };
}
/* Cartouche « Cap avion » sous les boutons ronds (21 nov. 2026, repris de trace-isv à la demande d'Henri) ;
   un appui ouvre le réglage du cap de largage à la main */
function capInfo() {
  const el = $('capInfo'); if (!el) return;
  if (!sol || !sol.ok) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  /* v0.25.4 (Henri) : les infos du vecteur (sorties, écart entre sorties, position du vert) passent ici ; plus d'étiquette sur le vecteur */
  const ne = sol.exits ? sol.exits.n : 1, dtx = sol.exits && sol.exits.dt ? ` · ${fmt1(sol.exits.dt)} s` : '', dzl = dzText(sol, true); // v0.25.5 (Henri) : « Vert 1,0 avant · décalé 0,2 N » sur une ligne
  el.innerHTML = `<div>Cap avion : <b class="vcap">${hdg(sol.heading)}</b> / ${fmtInt(sol.length)} m</div><div class="vexits">${ne} sortie${ne > 1 ? 's' : ''}${dtx}</div>${dzl ? `<div class="vdz">Vert ${dzl}</div>` : ''}`; el.classList.remove('hidden');
}
function draw(light) {
  if (typeof Photo !== 'undefined') Photo.sync();
  fig.clearLayers(); grads.clearLayers();
  compute();
  if (current.show.nm && current.dz) nmRings();
  updateInfo(); syncQuick(); syncPlaceBtn(); syncJump(); fillInputs(true); capInfo();
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
    drawHighEnd();
  }
  syncRotHandles(); drawGreenBarb();
  placeMarkers();
}
/* v0.25.0 (Henri, comme trace-isv) : appui long sur le vert ou le rouge puis glisser = faire TOURNER le vecteur autour de son milieu.
   Poignées persistantes (jamais recréées pendant le geste, sinon le téléphone perd le doigt) ; le cap ainsi donné est un cap « à la main »
   (headingOverride, vrai), le sens inversé et le décalage manuel sont remis à zéro ; la longueur et la place sont recalculées. */
const rotIcon = L.divIcon({ className: 'vrot', iconSize: [40, 40], iconAnchor: [20, 20], html: '<span></span>' });
let rotH = { g: null, r: null }, rotPivot = null;
function rotTo(which, ll) {
  if (!rotPivot) return; const v = Geo.toLocal(rotPivot, ll); if (Math.hypot(v.x, v.y) < 1) return;
  let h = Math.atan2(v.x, v.y) * 180 / Math.PI; if (which === 'g') h += 180;
  current.headingOverride = n360(h); current.reversed = false; current.offsetManual = null; draw(true);
}
/* pointillé noir + trait perpendiculaire (ou trait rouge sur le vecteur) de l'ouverture haute des derniers (v0.27.0) */
function hiTick(toPx, fromPx, half) { /* extrémités du trait perpendiculaire au vecteur, centré sur le point hi.end, demi-longueur half (px) */
  const E = toPx(sol.hi.end), A = toPx(sol.start), B = toPx(sol.end); let l = Math.hypot(B.x - A.x, B.y - A.y), ax = l > 0.5 ? { x: (B.x - A.x) / l, y: (B.y - A.y) / l } : null;
  if (!ax) { const q = toPx(Geo.fromLocal(sol.start, { x: sol.u.x * 1000, y: sol.u.y * 1000 })), m = Math.hypot(q.x - A.x, q.y - A.y) || 1; ax = { x: (q.x - A.x) / m, y: (q.y - A.y) / m }; }
  return [{ x: E.x - ax.y * half, y: E.y + ax.x * half }, { x: E.x + ax.y * half, y: E.y - ax.x * half }].map(fromPx);
}
function hiSide(toPx) { /* côté du texte : perpendiculaire au vecteur, à l'opposé de la ZMT (centre de DZ, sinon PRV) */
  const E = toPx(sol.hi.end), A = toPx(sol.start), B = toPx(sol.end), l = Math.hypot(B.x - A.x, B.y - A.y) || 1; let n = { x: -(B.y - A.y) / l, y: (B.x - A.x) / l };
  const Z = toPx(current.dz || sol.prv); if ((Z.x - E.x) * n.x + (Z.y - E.y) * n.y > 0) n = { x: -n.x, y: -n.y }; return { E, n };
}
const hiText = h => h.n ? `${h.n} sortie${h.n > 1 ? 's' : ''}` : '';
function drawHighEnd() {
  const h = sol && sol.ok && sol.hi; if (!h || !h.d) return;
  const px = ll => map.latLngToContainerPoint(LL(ll)), ll = q => { const r = map.containerPointToLatLng([q.x, q.y]); return [r.lat, r.lng]; };
  const tk = hiTick(px, ll, 9);
  if (h.d > 0) {
    L.polyline([LL(sol.end), LL(h.end)], { color: '#fff', weight: 4.5, opacity: .55, dashArray: '7 6', interactive: false }).addTo(fig);
    L.polyline([LL(sol.end), LL(h.end)], { color: '#000', weight: 2.5, dashArray: '7 6', interactive: false }).addTo(fig);
    L.polyline(tk, { color: '#fff', weight: 5.5, opacity: .7, interactive: false }).addTo(fig);
    L.polyline(tk, { color: '#000', weight: 3, interactive: false }).addTo(fig);
  } else {
    L.polyline(tk, { color: '#000', weight: 5.5, opacity: .6, interactive: false }).addTo(fig);
    L.polyline(tk, { color: C_END, weight: 3, interactive: false }).addTo(fig);
  }
  /* v0.27.1 (Henri) : nombre total de sorties si les derniers ouvrent à cette hauteur, écrit à côté du trait, en petit, sans cartouche
     (même format que « ouverture OSO » de trace-isv) : noir si le vecteur s'allonge, rouge s'il raccourcit */
  const txt = hiText(h); if (!txt) return;
  const sd = hiSide(px), P = { x: sd.E.x + sd.n.x * 14, y: sd.E.y + sd.n.y * 14 }, r = map.containerPointToLatLng([P.x, P.y]);
  const tr = `translate(${sd.n.x >= 0 ? '0' : '-100%'},${sd.n.y > 0.7 ? '0' : sd.n.y < -0.7 ? '-100%' : '-50%'})`;
  L.marker(r, { interactive: false, icon: L.divIcon({ className: 'hilab', iconSize: [0, 0], html: `<b class="${h.d > 0 ? 'onlight' : ''}" style="color:${h.d > 0 ? '#000' : C_END};transform:${tr}">${txt}</b>` }) }).addTo(fig);
}
function syncRotHandles() {
  const ok = sol && sol.ok && current.show.vec !== false;
  ['g', 'r'].forEach(k => {
    const p = ok ? (k === 'g' ? sol.start : sol.end) : null;
    if (!p) { if (rotH[k]) { map.removeLayer(rotH[k]); rotH[k] = null; } return; }
    if (!rotH[k]) {
      const m = rotH[k] = L.marker(LL(p), { icon: rotIcon, zIndexOffset: 750 }).addTo(map);
      longPressDrag(m, ll => rotTo(k, ll), () => { rotPivot = null; persist(); redraw(); fillInputs(); toast('Cap de largage choisi à la main. « Auto » (cadre du cap › Cap de largage) pour revenir en automatique.'); },
        () => { rotPivot = { lat: (sol.start.lat + sol.end.lat) / 2, lng: (sol.start.lng + sol.end.lng) / 2 }; });
    } else if (!rotH[k]._lpDragging) rotH[k].setLatLng(LL(p));
  });
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
    const p = pt(e); start = { x: p.clientX, y: p.clientY }; marker._lpMoved = false;
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
    /* 21 nov. 2026 : rien ne bouge tant que le doigt n'a pas glissé (sinon, relâché sur place = menu « Déplacer », lpmove.js) */
    if (!marker._lpMoved) { if (Math.hypot(p.clientX - start.x, p.clientY - start.y) <= MOVE_TOL) return; marker._lpMoved = true; }
    const r = map.getContainer().getBoundingClientRect();
    const ll = map.containerPointToLatLng([p.clientX - r.left, p.clientY - r.top]);
    marker.setLatLng(ll); onMove({ lat: ll.lat, lng: ll.lng });
  };
  const up = () => {
    clearTimeout(timer); timer = null; off();
    if (marker._lpDragging) {
      marker._lpDragging = false; el.classList.remove('lifting'); map.dragging.enable();
      suppressClickUntil = Date.now() + 400;
      if (marker._lpMoved || typeof LPMove === 'undefined') onEnd();
      else { /* relâché sans glisser : menu « Déplacer » (puis toucher la carte), ou les choix propres à l'objet (marker._lpMenu) */
        const r = map.getContainer().getBoundingClientRect(), q = map.containerPointToLatLng([start.x - r.left, start.y - r.top]), P = { lat: q.lat, lng: q.lng };
        LPMove.open(start.x, start.y, marker._lpMenu ? marker._lpMenu(P) : LPMove.defaultItems(marker, P, onMove, onEnd, onStart)); }
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
let vecHit = null, vecLabel = null, dzMarker = null;
/* v0.25.6 (Henri) : barbule cyan du vent au sol à côté du centre de la DZ, comme la ZMT de trace-isv (même dessin : demi-barre 5 kt, barre 10 kt, triangle 50 kt,
   empennage côté au vent ; rond si calme). Carte et PDF ; vent du profil à 10 m (prévision affichée, « Vent 0 » compris). */
function groundWind() { if (!prof || !prof.lv || !prof.lv.length) return null; const w = spdDir(windAt(prof, 10)); return isFinite(w.spd) ? w : null; }
function barbGeom(kt, C, d, s) {
  const n = { x: -d.y, y: d.x }, L0 = 16 * s, T = { x: C.x - d.x * L0 / 2, y: C.y - d.y * L0 / 2 }, H = { x: C.x + d.x * L0 / 2, y: C.y + d.y * L0 / 2 };
  const P = (a, m) => ({ x: T.x + d.x * a + n.x * m, y: T.y + d.y * a + n.y * m });
  const lines = [[T, H]], tris = [];
  let k5 = Math.round(kt / 5), a = 0; const F50 = Math.floor(k5 / 10); k5 -= F50 * 10; const B10 = Math.floor(k5 / 2), B5 = k5 % 2;
  if (!F50 && !B10 && !B5) return { lines: [], tris, calm: true, T: C };
  for (let i = 0; i < F50; i++) { tris.push([P(a, 0), P(a + 4 * s, 0), P(a, 9 * s)]); a += 5 * s; }
  for (let i = 0; i < B10; i++) { const b = P(a, 9 * s); lines.push([P(a, 0), { x: b.x - d.x * 2.5 * s, y: b.y - d.y * 2.5 * s }]); a += 3.5 * s; }
  if (B5) { if (!F50 && !B10) a += 3.5 * s; const b = P(a, 5 * s); lines.push([P(a, 0), { x: b.x - d.x * 1.4 * s, y: b.y - d.y * 1.4 * s }]); }
  return { lines, tris, T };
}
function barbBox(g) { const pts = g.lines.flat().concat(g.tris.flat()); if (g.calm) pts.push({ x: g.T.x - 3, y: g.T.y - 3 }, { x: g.T.x + 3, y: g.T.y + 3 }); return { x0: Math.min(...pts.map(q => q.x)), y0: Math.min(...pts.map(q => q.y)), x1: Math.max(...pts.map(q => q.x)), y1: Math.max(...pts.map(q => q.y)) }; }
function barbWind(toPx, wIn, llIn) { /* sens écran du vent (au sol par défaut, ou wIn au point llIn) et sa force (kt) */
  const w = wIn || groundWind(), at = llIn || current.dz; if (!w || !at || !isFinite(w.spd) || !isFinite(w.dir)) return null;
  const z = toPx(at), r = (w.dir + 180) * Math.PI / 180, far = toPx(Geo.fromLocal(at, { x: Math.sin(r) * 1000, y: Math.cos(r) * 1000 }));
  const d = { x: far.x - z.x, y: far.y - z.y }, l = Math.hypot(d.x, d.y) || 1; return { z, d: { x: d.x / l, y: d.y / l }, kt: w.spd * KT };
}
/* barbule placée à droite de la cible : bord gauche en x0, centrée verticalement sur cy */
function barbRight(bw, s, left, cy) { const g0 = barbGeom(bw.kt, { x: 0, y: 0 }, bw.d, s), b = barbBox(g0), dx = left - b.x0, dy = cy - (b.y0 + b.y1) / 2, mv = q => ({ x: q.x + dx, y: q.y + dy });
  return { lines: g0.lines.map(l => l.map(mv)), tris: g0.tris.map(t => t.map(mv)), calm: g0.calm, T: mv(g0.T) }; }
/* barbule centrée sur (cx, cy) */
function barbAt(bw, s, cx, cy) { const g0 = barbGeom(bw.kt, { x: 0, y: 0 }, bw.d, s), b = barbBox(g0), dx = cx - (b.x0 + b.x1) / 2, dy = cy - (b.y0 + b.y1) / 2, mv = q => ({ x: q.x + dx, y: q.y + dy });
  return { lines: g0.lines.map(l => l.map(mv)), tris: g0.tris.map(t => t.map(mv)), calm: g0.calm, T: mv(g0.T) }; }
function barbSvg(g) { /* élément DOM de la barbule g (coordonnées du marqueur) */
  const B = barbBox(g), x0 = B.x0 - 2, y0 = B.y0 - 2, x1 = B.x1 + 2, y1 = B.y1 + 2, f = q => `${(q.x - x0).toFixed(1)},${(q.y - y0).toFixed(1)}`, body = g.lines.map(([a, b]) => `M${f(a)}L${f(b)}`).join('');
  const d = document.createElement('div'); d.className = 'barbIn';
  Object.assign(d.style, { position: 'absolute', left: `${x0.toFixed(1)}px`, top: `${y0.toFixed(1)}px`, width: `${(x1 - x0).toFixed(1)}px`, height: `${(y1 - y0).toFixed(1)}px`, pointerEvents: 'none' });
  d.innerHTML = `<svg width="${x1 - x0}" height="${y1 - y0}" style="overflow:visible;display:block"><path d="${body}" stroke="#000" stroke-width="2.6" stroke-linecap="round" fill="none" opacity=".55"/>${g.tris.map(t => `<path d="M${t.map(f).join('L')}Z" fill="#00e5ff" stroke="#000" stroke-width=".6"/>`).join('')}<path d="${body}" stroke="#00e5ff" stroke-width="1.1" stroke-linecap="round" fill="none"/>${g.calm ? `<circle cx="${(g.T.x - x0).toFixed(1)}" cy="${(g.T.y - y0).toFixed(1)}" r="2.5" stroke="#00e5ff" stroke-width="1.1" fill="none"/>` : ''}</svg>`;
  return d;
}
/* v0.25.7 (Henri, comme trace-isv) : barbule du vent À LA HAUTEUR DE LARGAGE à côté du vert, perpendiculairement au vecteur, côté opposé à la ZMT (centre de DZ, sinon PRV) */
function greenBarbPos(toPx, gap) {
  const A = toPx(sol.start), B = toPx(sol.end), l = Math.hypot(B.x - A.x, B.y - A.y);
  let n = l > 0.5 ? { x: -(B.y - A.y) / l, y: (B.x - A.x) / l } : (() => { const q = toPx(Geo.fromLocal(sol.start, { x: sol.u.x * 1000, y: sol.u.y * 1000 })), m = Math.hypot(q.x - A.x, q.y - A.y) || 1; return { x: -(q.y - A.y) / m, y: (q.x - A.x) / m }; })();
  const Z = toPx(current.dz || sol.prv); if ((Z.x - A.x) * n.x + (Z.y - A.y) * n.y > 0) n = { x: -n.x, y: -n.y };
  return { A, c: { x: A.x + n.x * gap, y: A.y + n.y * gap } };
}
function drawGreenBarb() {
  const el = rotH.g && rotH.g.getElement(); if (!el) return; el.querySelectorAll('.barbIn').forEach(e => e.remove());
  if (!sol || !sol.ok || !sol.windRel) return;
  const px = ll => map.latLngToContainerPoint(LL(ll)), bw = barbWind(px, sol.windRel, sol.start); if (!bw) return;
  const p = greenBarbPos(px, 24); el.appendChild(barbSvg(barbAt(bw, 1, 20 + p.c.x - p.A.x, 20 + p.c.y - p.A.y)));
}
function drawBarb() { /* dans le marqueur du centre de la DZ : suit la cible au zoom, au pincement et au glissement */
  const el = dzMarker && dzMarker.getElement(); if (!el) return;
  el.querySelectorAll('.barbIn').forEach(e => e.remove()); /* seulement celle de la ZMT (le vert a la sienne) */
  const bw = barbWind(ll => map.latLngToContainerPoint(LL(ll))); if (!bw) return;
  const g = barbRight(bw, 1, 38, 15), B = barbBox(g), x0 = B.x0 - 2, y0 = B.y0 - 2, x1 = B.x1 + 2, y1 = B.y1 + 2, f = q => `${(q.x - x0).toFixed(1)},${(q.y - y0).toFixed(1)}`;
  const body = g.lines.map(([a, b]) => `M${f(a)}L${f(b)}`).join('');
  const d = document.createElement('div'); d.className = 'barbIn';
  Object.assign(d.style, { position: 'absolute', left: `${x0.toFixed(1)}px`, top: `${y0.toFixed(1)}px`, width: `${(x1 - x0).toFixed(1)}px`, height: `${(y1 - y0).toFixed(1)}px`, pointerEvents: 'none' });
  d.innerHTML = `<svg width="${x1 - x0}" height="${y1 - y0}" style="overflow:visible;display:block"><path d="${body}" stroke="#000" stroke-width="2.6" stroke-linecap="round" fill="none" opacity=".55"/>${g.tris.map(t => `<path d="M${t.map(f).join('L')}Z" fill="#00e5ff" stroke="#000" stroke-width=".6"/>`).join('')}<path d="${body}" stroke="#00e5ff" stroke-width="1.1" stroke-linecap="round" fill="none"/>${g.calm ? `<circle cx="${(g.T.x - x0).toFixed(1)}" cy="${(g.T.y - y0).toFixed(1)}" r="2.5" stroke="#00e5ff" stroke-width="1.1" fill="none"/>` : ''}</svg>`;
  el.appendChild(d);
}

const dzIcon = L.divIcon({ className: 'dzc', iconSize: [30, 30], iconAnchor: [15, 15], html: '<span></span>' });
function syncDzMarker() {
  if (current.dz) {
    if (!dzMarker) { dzMarker = L.marker(LL(current.dz), { icon: dzIcon, zIndexOffset: 700 }).addTo(map); longPressDrag(dzMarker, ll => { current.dz = ll; draw(true); }, () => { persist(); redraw(); fillInputs(); }); }
    else if (!dzMarker._lpDragging) dzMarker.setLatLng(LL(current.dz));
  } else if (dzMarker) { map.removeLayer(dzMarker); dzMarker = null; }
  drawBarb();
}
function placeMarkers() {
  syncDzMarker();
  const usedId = sol && sol.prv ? sol.prv.id : null;
  Object.keys(prvMarkers).forEach(id => { if (!current.prvs.find(p => p.id === id)) { map.removeLayer(prvMarkers[id]); delete prvMarkers[id]; } });
  current.prvs.forEach(p => {
    let m = prvMarkers[p.id];
    if (!m) { m = prvMarkers[p.id] = L.marker(LL(p), { icon: prvIcon(p.id === usedId), zIndexOffset: 800 }).addTo(map); m._used = p.id === usedId; longPressAction(m, () => prvMenu(p.id)); m.on('click', ev => { L.DomEvent.stop(ev); prvTap(p.id); }); }
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
    if (vecLabel && map.hasLayer(vecLabel)) map.removeLayer(vecLabel); // v0.25.4 : plus d'étiquette sur le vecteur (infos dans le cartouche du cap)
    /* v0.25.1 (Henri) : plus d'appui long sur le cartouche (ancienne fenêtre de saisie du cap supprimée) : le cap se règle dans Zones › Cap de largage */
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
  if (dzMarker) { map.removeLayer(dzMarker); dzMarker = null; }
  Object.keys(prvMarkers).forEach(id => { map.removeLayer(prvMarkers[id]); delete prvMarkers[id]; });
  if (vecHit && map.hasLayer(vecHit.line)) map.removeLayer(vecHit.line);
  if (vecLabel && map.hasLayer(vecLabel)) map.removeLayer(vecLabel);
}
function setManualPoint(ll) {
  if (!sol || !sol.ok) return;
  const q = Geo.toLocal(sol.prv, ll);
  current.offsetManual = q.x * sol.r.x + q.y * sol.r.y; current.tManual = q.x * sol.u.x + q.y * sol.u.y;
}
/* v0.24.3 (Henri) : un appui court sur un PRV non actif le rend actif (choisi à la main) ; sur le PRV actif, rien (appui long = menu) */
function prvTap(id) {
  if (Date.now() < suppressClickUntil) return; /* fin d'un appui long */
  if (sol && sol.prv && sol.prv.id === id) return;
  if (!current.prvs.find(x => x.id === id)) return;
  current.prvManual = id; current.offsetManual = null; persist(); redraw(); toast('PRV choisi à la main. « PRV auto » pour revenir au choix automatique.');
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
// Cap à la main (onglet Zones › Cap de largage) : champ + boutons −5 −1 +1 +5 et Auto (v0.25.0)
function capMagNow() { return sol && sol.ok ? n360(sol.heading - sol.decl) : null; }
function setCapMag(v) { if (!sol || !sol.ok || isNaN(v)) return; current.headingOverride = n360(v + sol.decl); current.reversed = false; current.offsetManual = null; persist(); redraw(); }
function syncCapField() {
  const el = $('z_cap'); if (!el) return; const m = capMagNow(), man = typeof current.headingOverride === 'number';
  if (document.activeElement !== el) el.value = man && m != null ? Math.round(m) : '';
  el.placeholder = m != null ? String(Math.round(m)) : '';
  $('capHint').textContent = m == null ? '' : man ? `Cap choisi à la main : ${Math.round(m)}° M.` : `Cap automatique (${sol.why}) : ${Math.round(m)}° M. Le modifier ici le fixe à la main.`;
}
document.querySelectorAll('[data-cap]').forEach(b => b.addEventListener('click', () => { const m = capMagNow(); if (m == null) return; setCapMag(Math.round(m) + +b.dataset.cap); }));
$('z_cap').addEventListener('change', e => { const t = e.target.value.trim(); if (t === '') { current.headingOverride = null; current.reversed = false; current.offsetManual = null; persist(); redraw(); return; } setCapMag(parseFloat(t.replace(',', '.'))); });
$('z_capAuto').addEventListener('click', () => { current.headingOverride = null; current.reversed = false; current.offsetManual = null; persist(); redraw(); toast('Cap de largage automatique'); });
function addPrv(p) {
  current.prvs.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lat: p.lat, lng: p.lng });
  persist(); redraw();
  toast(`PRV placé (${current.prvs.length}). Appui long sur un PRV : l'utiliser comme référence ou le supprimer.`);
  ensureWx(false);
}

// Points à faire tenir à l'écran (et dans le PDF) : vecteur, PRV, zone de relaxation affichée
function figurePoints() {
  if (!sol || !sol.ok) return current.prvs.map(p => ({ lat: p.lat, lng: p.lng }));
  const pts = [sol.start, sol.end]; if (sol.hi && sol.hi.d > 0) pts.push(sol.hi.end); /* v0.27.0 : bout du pointillé d'ouverture haute dans le cadrage */
  if (current.show.relax && relaxPts) relaxPts.forEach(p => pts.push(p));
  if (current.show.rose) { const ro = roseOf(sol); [0, 90, 180, 270].forEach(a => pts.push(Geo.fromLocal(ro.c, { x: (ro.R + 60) * Math.sin(a * Math.PI / 180), y: (ro.R + 60) * Math.cos(a * Math.PI / 180) }))); }
  // PRV : seulement s'ils sont dans le cercle de relaxation (sinon ils réduiraient trop le zoom)
  const inCircle = ll => { if (!sol.relax) return false; const q = Geo.toLocal(sol.prv, ll); return Math.hypot(q.x - sol.relax.c.x, q.y - sol.relax.c.y) <= sol.relax.R; };
  current.prvs.forEach(p => { if (inCircle(p)) pts.push({ lat: p.lat, lng: p.lng }); });
  if (current.dz && inCircle(current.dz)) pts.push(current.dz);
  return pts;
}
function freeRect() {
  // marges serrées (20 nov. 2026) : la figure remplit l'écran, ses bords peuvent frôler les boutons.
  // Tout en coordonnées de la carte (les rectangles des boutons sont ramenés à l'origine de la carte : sur iPhone,
  // la page peut être décalée et la carte ne commence pas forcément au bord de l'écran)
  const W = map.getSize().x, H = map.getSize().y, m = 4, c = map.getContainer().getBoundingClientRect();
  const rel = el => { const q = el.getBoundingClientRect(); return { left: q.left - c.left, right: q.right - c.left, top: q.top - c.top, bottom: q.bottom - c.top, width: q.width }; };
  // bord droit de la colonne de boutons = le plus à droite de ses BOUTONS : sur iPhone (Safari), une colonne qui passe
  // sur 2 ou 3 colonnes en paysage garde la largeur d'une seule (bug flex-wrap) → la figure passait sous les boutons
  const qr = Math.max(rel($('quick')).right, ...[...$('quick').querySelectorAll('button')].map(rel).filter(q => q.width).map(q => q.right));
  const l = Math.max(m, qr + m), r = W - 6;
  // haut : seuls les boutons du haut situés au-dessus de la zone libre comptent (en paysage, Manœuvre/Zones sont
  // au-dessus de la colonne de gauche : la figure peut monter jusqu'au bas des boutons ronds N/AXE/⤢/⌖)
  let t = m;
  const tops = [...document.querySelectorAll('#top button, #capInfo')].map(rel).filter(q => q.width);
  tops.forEach(q => { if (q.right > l && q.left < r) t = Math.max(t, q.bottom + m); });
  return { l, t, r, b: H - 22, tops };
}
// Zones libres candidates : A = sous les boutons du haut, toute la largeur ; B = tout en haut, mais à gauche des
// boutons ronds (en paysage, la figure peut monter jusqu'en haut de l'écran à gauche de N/AXE/⤢/⌖ — photo d'Henri du 20 nov.).
// Le cadrage garde celle qui donne la plus grande figure.
function freeRects() {
  const A = freeRect(), m = 4;
  let rb = Infinity; A.tops.forEach(q => { if (q.left > A.l && q.top < A.t) rb = Math.min(rb, q.left - m); });
  const B = { l: A.l, t: m, r: Math.min(A.r, rb), b: A.b };
  return B.r - B.l >= 120 && B.t < A.t ? [A, B] : [A];
}
// Étiquettes (degrés, chiffres, hauteurs…) : leur débord en pixels au-delà de la figure est réservé en plus,
// sinon le cadrage serré les cache sous les boutons (« 180° » devenu « 80° », 20 nov. 2026)
const FIT_LABELS = '.glabel span, .vlabel, .hilab b'; /* v0.27.1 : le nombre de sorties de l'ouverture haute aussi */
function labelOverhang(x0, x1, y0, y1) {
  const o = { l: 0, r: 0, t: 0, b: 0 }; if (!FIT_LABELS) return o;
  const c = map.getContainer().getBoundingClientRect();
  document.querySelectorAll(FIT_LABELS).forEach(el => {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
    const lx0 = r.left - c.left, lx1 = r.right - c.left, ly0 = r.top - c.top, ly1 = r.bottom - c.top;
    o.l = Math.max(o.l, x0 - lx0); o.r = Math.max(o.r, lx1 - x1); o.t = Math.max(o.t, y0 - ly0); o.b = Math.max(o.b, ly1 - y1);
  });
  return o;
}
function fitFigure() {
  const pts = figurePoints(); if (pts.length < 2) return;
  map.invalidateSize({ animate: false }); // taille réelle de l'écran (portrait / paysage)
  const c0 = map.getCenter(), z0 = map.getZoom(); let best = null;
  freeRects().forEach(R => {
    map.setView(c0, z0, { animate: false }); fitInto(pts, R);
    if (!best || map.getZoom() > best.z + 0.01) best = { c: map.getCenter(), z: map.getZoom(), R };
  });
  map.setView(best.c, best.z, { animate: false });
  fitCheck(pts, best.R);
  redraw();
}
// Contrôle après cadrage : boîte réelle (points + étiquettes mesurées à l'écran) dans la zone choisie ; sinon on décale,
// et si elle est trop grande on dézoome d'un cran (photo d'Henri du 20 nov. : figure passée sous la colonne de boutons)
function fitCheck(pts, R) {
  for (let k = 0; k < 6; k++) {
    draw();
    const P = pts.map(p => map.latLngToContainerPoint(LL(p)));
    let x0 = Math.min(...P.map(p => p.x)), x1 = Math.max(...P.map(p => p.x)), y0 = Math.min(...P.map(p => p.y)), y1 = Math.max(...P.map(p => p.y));
    const o = labelOverhang(x0, x1, y0, y1); x0 -= o.l; x1 += o.r; y0 -= o.t; y1 += o.b;
    if (x1 - x0 > R.r - R.l + 1 || y1 - y0 > R.b - R.t + 1) { map.setZoom(map.getZoom() - 0.05, { animate: false }); continue; }
    const dx = x0 < R.l ? R.l - x0 : x1 > R.r ? R.r - x1 : 0, dy = y0 < R.t ? R.t - y0 : y1 > R.b ? R.b - y1 : 0;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    map.panBy([-dx, -dy], { animate: false });
  }
}
function fitInto(pts, R) {
  for (let pass = 0; pass < 3; pass++) { // 3 passes : les étiquettes sont remesurées après chaque zoom
    draw(); // étiquettes à jour pour ce zoom
    const P = pts.map(p => map.latLngToContainerPoint(LL(p)));
    const x0 = Math.min(...P.map(p => p.x)), x1 = Math.max(...P.map(p => p.x));
    const y0 = Math.min(...P.map(p => p.y)), y1 = Math.max(...P.map(p => p.y));
    const o = labelOverhang(x0, x1, y0, y1);
    const aw = Math.max(80, R.r - R.l - o.l - o.r), ah = Math.max(80, R.b - R.t - o.t - o.b);
    const k = Math.min(aw / Math.max(x1 - x0, 1), ah / Math.max(y1 - y0, 1));
    const z = Math.min(19, Math.floor((map.getZoom() + Math.log2(k)) * 20) / 20); // zoom au 1/20 près
    const centerLL = map.containerPointToLatLng([(x0 + x1) / 2, (y0 + y1) / 2]);
    map.setView(centerLL, z, { animate: false });
    // centre de la figure au centre de la zone libre, décalé du débord des étiquettes
    const S = map.getSize(), cx = S.x / 2, cy = S.y / 2, ax = (R.l + R.r + o.l - o.r) / 2, ay = (R.t + R.b + o.t - o.b) / 2;
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
  $('dzInfo').textContent = current.dz ? (sol && sol.ok && sol.dzInfo ? 'Point vert : ' + dzText(sol) + '.' : 'Centre de la DZ placé.') : 'Pas encore de centre de DZ : les distances en nautiques ne s\'affichent pas.';
  $('btnDzDel').classList.toggle('hidden', !current.dz);
  const ex = sol && sol.ok && sol.exits;
  // Panneau 🕑 volontairement court (Henri, 19/11/2026) : nombre de sorties et alerte vent sous voile ; le détail est dans l'onglet Zones (axisInfo)
  $('whyInfo').innerHTML = sol && sol.ok ? (ex && ex.dt ? `<b>${ex.n} sortie${ex.n > 1 ? 's' : ''}</b>, une toutes les <b>${ex.dt} s</b>.` : '') +
    (sol.canopyWind.spd >= sol.Va ? ' <b class="warn">Vent sous voile plus fort que la voile : ouvrir au vent du PRV.</b>' : '') : '';
  $('elevAuto').textContent = (typeof current.elevAuto === 'number' ? `automatique : ${current.elevAuto} m (${Math.round(current.elevAuto / 0.3048)} ft)` : 'automatique : inconnue (pas encore de prévision)') + (typeof current.elevManual === 'number' ? ` · retenue : ${current.elevManual} m (${Math.round(current.elevManual / 0.3048)} ft)` : ''); // même affichage dans les 3 applis
}

// ---------- Interface ----------
// Élément absent (ex. page en cache d'une version plus ancienne) : on renvoie un élément fantôme
// plutôt que de planter toute l'appli.
function $(id) { return document.getElementById(id) || document.createElement('div'); }
function setBanner(t) { const b = $('banner'); if (!t) b.classList.add('hidden'); else { b.textContent = t; b.classList.remove('hidden', 'hasx'); addPlaceCancel(); } }
// Pendant un placement (toucher la carte), bouton « ✕ Annuler » dans le bandeau (21 nov. 2026, demande d'Henri)
function addPlaceCancel() {
  let p = null; try { p = placing; } catch (e) { return; } // placing pas encore déclaré au tout début
  const b = $('banner'); if (!p || b.querySelector('.bcancel')) return;
  const c = document.createElement('button'); c.className = 'bcancel'; c.textContent = '✕'; c.title = 'Annuler'; /* Henri : plus de gros bouton Annuler, une croix en haut à droite du bandeau */
  c.onclick = e => { e.stopPropagation(); cancelPlacing(); toast('Placement annulé'); };
  b.classList.add('hasx'); b.append(c);
}
function cancelPlacing() { placing = null; placeBanner(); syncPlaceBtn(); redraw(); }
let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3200); }
const numIn = el => parseFloat(String(el.value).replace(',', '.'));
const HYP = ['vff', 'openLoss', 'perpTime', 'hMin', 'sep']; // vitesses sous voile à part : on saisit Vh et Vz, la finesse en découle
function setParam(k, v) { current.params[k] = v; profile[k] = v; store.set('vl.profile', profile); zones.forEach(applyProfile); store.set('vl.zones', zones); }
function fillInputs(only) {
  const p = current.params;
  HYP.concat(['hOpen', 'hOpenLast']).forEach(k => { const el = $('p_' + k); if (el && document.activeElement !== el) el.value = String(p[k]).replace('.', ','); });
  // largage : FL et m sol liés (on garde la valeur saisie en dernier, l'autre est recalculée avec la prévision)
  const elev = elevOf(current, wxRec);
  const agl = p.relMode === 'AGL' ? +p.relAGL : flToAgl(+p.relFL, prof, elev), fl = p.relMode === 'FL' ? +p.relFL : aglToFl(+p.relAGL, prof, elev);
  ['p_relFL', 'j_relFL'].forEach(id => { if (document.activeElement !== $(id)) $(id).value = Math.round(fl); });
  ['p_relAGL', 'j_relAGL'].forEach(id => { if (document.activeElement !== $(id)) $(id).value = Math.round(agl); });
  if (document.activeElement !== $('j_hOpen')) $('j_hOpen').value = p.hOpen;
  fillAc();
  if (document.activeElement !== $('p_vh')) $('p_vh').value = fmt1((+p.vz) * (+p.glide));
  if (document.activeElement !== $('p_vz')) $('p_vz').value = fmt1(+p.vz);
  $('glideInfo').textContent = `Finesse ${fmt1(+p.glide)}`;
  syncCapField();
  if (only) return;
  $('z_axisOn').checked = !!current.axis.on; $('z_axisBoth').checked = current.axis.both !== false;
  if (document.activeElement !== $('z_axisMag')) $('z_axisMag').value = current.axis.on ? Math.round(current.axis.mag) : (current.axis.mag || '');
  $('axisRow').classList.toggle('dim', !current.axis.on);
  if (document.activeElement !== $('z_elev')) $('z_elev').value = typeof current.elevManual === 'number' ? current.elevManual : '';
  syncQuick(); syncJump();
  $('zoneName').textContent = current.name + (current.id ? '' : ' (non enregistrée)');
}
HYP.concat(['hOpen', 'hOpenLast']).forEach(k => {
  $('p_' + k).addEventListener('input', e => { const v = numIn(e.target); if (isNaN(v)) return; setParam(k, v); persist(); redraw(); });
  $('p_' + k).addEventListener('blur', () => fillInputs(true));
});
// Sous voile : on saisit la vitesse horizontale et la vitesse verticale ; la finesse (gardée pour le calcul) = Vh ÷ Vz
$('p_vh').addEventListener('input', e => { const v = numIn(e.target); const vz = +current.params.vz; if (isNaN(v) || !(v > 0) || !(vz > 0)) return; setParam('glide', v / vz); persist(); redraw(); $('glideInfo').textContent = `Finesse ${fmt1(v / vz)}`; });
$('p_vz').addEventListener('input', e => { const v = numIn(e.target); if (isNaN(v) || !(v > 0)) return; const vh = (+current.params.vz) * (+current.params.glide); setParam('vz', v); setParam('glide', vh / v); persist(); redraw(); $('glideInfo').textContent = `Finesse ${fmt1(vh / v)}`; });
['p_vh', 'p_vz'].forEach(id => $(id).addEventListener('blur', () => fillInputs(true)));
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
  $('qRelax').classList.toggle('on', !!current.show.relax); $('qNm').classList.toggle('on', !!current.show.nm); $('qTicks').classList.toggle('on', !!current.show.rose);
  $('qRev').classList.toggle('on', !!current.reversed);
  $('qPrv').textContent = 'PRV auto'; $('qPrv').classList.toggle('hidden', !current.prvManual); // n'apparaît qu'après un choix manuel
  $('qVecAuto').disabled = !vecManual(); /* v0.25.3 : dans le sous-menu du bouton Vecteur, grisé quand rien n'est à la main */ $('qVec').classList.toggle('on', !!vecPopOpen);
  $('qWinds').classList.toggle('on', !$('windsBox').classList.contains('hidden'));
}
function quick(fn, msg) { fn(); syncQuick(); persist(); redraw(); if (msg) toast(msg()); }
/* v0.25.4 : bouton « Infos du vecteur » retiré (infos dans le cartouche du cap) */
$('qNm').addEventListener('click', () => { if (!current.dz) return toast('Place d\'abord le centre de la DZ (☰ Zones)'); quick(() => { current.show.nm = !current.show.nm; }, () => current.show.nm ? 'Cercles tous les 0,1 NM autour de la DZ' : 'Cercles NM masqués'); });
$('qTicks').addEventListener('click', () => quick(() => { current.show.rose = !current.show.rose; }, () => current.show.rose ? 'Rosace en degrés magnétiques autour du vecteur' : 'Rosace masquée'));
$('qRelax').addEventListener('click', () => quick(() => { current.show.relax = !current.show.relax; }, () => current.show.relax ? 'Zone de relaxation affichée' : 'Zone de relaxation masquée'));
/* v0.25.3 (Henri, comme trace-isv) : bouton Vecteur → « Vect. auto » et « ⇅ Sens » à droite du bouton ; ⇅ aussi à côté du cap à la main */
var vecPopOpen = false;
function syncVecPop() { const p = $('vecPop'); p.classList.toggle('hidden', !vecPopOpen); $('qVec').classList.toggle('on', vecPopOpen); if (!vecPopOpen) return;
  const r = $('qVec').getBoundingClientRect(); p.style.left = `${Math.round(r.right + 6)}px`; p.style.top = `${Math.round(r.top + r.height / 2 - 25)}px`; }
function closeVecPop() { if (vecPopOpen) { vecPopOpen = false; syncVecPop(); } }
$('qVec').addEventListener('click', () => { vecPopOpen = !vecPopOpen; syncQuick(); syncVecPop(); });
document.addEventListener('pointerdown', e => { if (vecPopOpen && !$('vecPop').contains(e.target) && e.target !== $('qVec')) closeVecPop(); }, true);
['qVecAuto', 'qRev'].forEach(id => $(id).addEventListener('click', () => setTimeout(closeVecPop, 0)));
$('z_capRev').addEventListener('click', () => $('qRev').click());
$('qRev').addEventListener('click', () => quick(() => { current.reversed = !current.reversed; current.offsetManual = null; },
  () => current.reversed ? (current.axis.on && !current.axis.both ? '⚠️ Sens inversé : la zone n\'autorise pas cet axe dans ce sens' : 'Sens de l\'axe inversé') : 'Sens normal'));
$('qPrv').addEventListener('click', () => { if (!current.prvManual) return toast('PRV automatique (le plus au vent). Touche un autre PRV pour le choisir à la main.'); quick(() => { current.prvManual = null; current.offsetManual = null; }, () => 'PRV automatique (le plus au vent)'); });
function vecManual() { return typeof current.offsetManual === 'number' || typeof current.headingOverride === 'number' || !!current.reversed || current.tManual != null; }
/* « Vect. auto » : tout ce qui a été réglé à la main sur le vecteur revient en automatique (place, cap, sens) ; le PRV garde son propre bouton « PRV auto » et l'axe imposé par la zone reste */
$('qVecAuto').addEventListener('click', () => quick(() => { current.offsetManual = null; current.tManual = null; current.headingOverride = null; current.reversed = false; }, () => 'Vecteur automatique : cap et place recalculés'));

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
  if (have && !force && (current.holdWx || (Date.now() - have.fetched < 3600e3 && have.rh !== undefined))) return have; /* prévision d'avant l'humidité (rh absent) : retéléchargée */ // vecteur gardé : prévision figée
  if (wxBusy) return have; wxBusy = true; $('wxInfo').innerHTML = 'Téléchargement de la prévision…';
  try { const r = await wxFetch(current, date); delete wxFailed[date]; persist(); return r; }
  catch (e) { wxFailed[date] = true; toast(have ? 'Pas de réseau : prévision gardée, téléchargée le ' + fmtFetched(have.fetched) : 'Prévision impossible à télécharger (réseau ?)'); return have; }
  finally { wxBusy = false; redraw(); setTimeout(() => fillInputs(true), 0); syncJump(); }
}
function setWhen(w) { current.holdWx = false; current.when = w; setTimeout(() => { try { syncTUse(); } catch (e) { } }, 0); current.offsetManual = null; persist(); redraw(); syncJump(); ensureWx(false); }
$('qWhen').addEventListener('click', () => { const b = $('jumpBox'); b.style.left = Math.round(Math.max($('quick').getBoundingClientRect().right, ...[...$('quick').querySelectorAll('button')].map(x => x.getBoundingClientRect().right)) + 6) + 'px'; /* boutons, pas la colonne (bug flex-wrap de Safari) */ b.classList.toggle('hidden'); }); // fenêtre calée à droite de la colonne, quelle que soit sa largeur
$('jumpOk').addEventListener('click', () => { $('jumpBox').classList.add('hidden'); if (sol && sol.ok) fitFigure(); });
$('j_minus').addEventListener('click', () => setWhen(shiftWhen(current.when, -1)));
$('j_plus').addEventListener('click', () => setWhen(shiftWhen(current.when, 1)));
$('j_now').addEventListener('click', () => { current.holdWx = false; current.when = nowWhen(); persist(); syncJump(); ensureWx(true); });
$('j_date').addEventListener('change', e => { if (e.target.value) setWhen(e.target.value + current.when.slice(10)); });
$('j_hour').addEventListener('change', e => setWhen(current.when.slice(0, 11) + e.target.value + ':00'));

// ---------- Tableau des vents (date et heure indépendantes de la carte) ----------
let tWhen = null;
/* Point choisi sur la carte pour le tableau (windpick.js, v0.17.0) : prévision d'un seul point, gardée en mémoire seulement */
let windPt = null; const pickMem = {}, pickFailed = {};
const pickKey = (p, date) => p.lat.toFixed(4) + ',' + p.lng.toFixed(4) + '|' + date;
async function ensurePick(date) {
  const k = pickKey(windPt, date), have = pickMem[k]; if (have && Date.now() - have.fetched < 3600e3) return have;
  const z = { id: '__pick', center: { lat: windPt.lat, lng: windPt.lng }, prvs: [] };
  try { const rec = await wxFetch(z, date); store.del(wxKey('__pick', date)); delete wxMem[wxKey('__pick', date)]; pickMem[k] = rec; delete pickFailed[k]; return rec; } catch (e) { pickFailed[k] = true; return have; }
}
function renderWinds() {
  const date = tWhen.slice(0, 10), k = windPt ? pickKey(windPt, date) : null;
  const rec = windPt ? pickMem[k] : wxCached(current.id, date), elev = windPt ? (rec && typeof rec.elev === 'number' ? rec.elev : 0) : elevOf(current, rec), pr = wxProfile(rec, tWhen, elev);
  $('t_date').value = date; $('t_hour').value = tWhen.slice(11, 13);
  $('t_info').innerHTML = windPt
    ? (rec ? wxStatus(rec, tWhen) : pickFailed[k] ? '⚠️ Prévision impossible à télécharger pour ce point (réseau ?).' : 'Prévision en cours de téléchargement…') + ` · <b>au point choisi</b> (${windPt.lat.toFixed(4)}, ${windPt.lng.toFixed(4)})` + (rec ? ` · terrain ${Math.round(elev)} m` : '')
    : wxStatus(rec, tWhen) + (rec ? ` · terrain ${Math.round(elev)} m` : '');
  const tb = $('windsTable').querySelector('tbody'); tb.innerHTML = '';
  if (!pr) { tb.innerHTML = '<tr><td colspan="6" class="mut">Pas de donnée pour cette heure.</td></tr>'; return; }
  windRows(pr, elev).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.lab}</td><td>${fmtInt(r.h)} m</td><td>${hdgN(r.dir)}</td><td>${Math.round(r.spd * KT)} kt</td><td>${fmt1(r.spd)} m/s</td><td>${r.T == null ? '–' : Math.round(r.T) + ' °C'}</td><td>${r.RH == null ? '–' : Math.round(r.RH) + ' %'}</td>`; // unité à côté de chaque chiffre
    tb.append(tr);
  });
}
function windRows(pr, elev) { // une ligne par tranche de 1 000 ft (FL), de la surface à ~10 000 m sol
  const rows = [], add = (lab, h) => { const w = spdDir(windAt(pr, h)); rows.push({ lab, h, dir: w.dir, spd: w.spd, T: tempAt(pr, h), RH: (() => { const q = pr.lv.filter(l => l.RH != null); return q.length ? interpLv({ lv: q }, h, 'RH') : null; })() }); /* humidité : seulement entre les niveaux qui en ont */ };
  add('Sol (10 m)', 10);
  const fl0 = Math.ceil(aglToFl(30, pr, elev) / 10) * 10;
  for (let fl = Math.max(10, fl0); fl <= 400; fl += 10) { const h = flToAgl(fl, pr, elev); if (h > 10000) break; if (h > 20) add('FL' + String(fl).padStart(3, '0'), h); }
  return rows;
}
/* v0.24.4 (Henri, repris de trace-isv) : choisir dans le tableau des vents la date et l'heure du CALCUL (bouton 🕑 du haut, vecteur) */
function syncTUse() { const b = $('t_use'); if (b) b.classList.toggle('hidden', !tWhen || tWhen === current.when || $('windsBox').classList.contains('hidden')); }
async function setTWhen(w) { tWhen = w; syncTUse(); renderWinds(); if (windPt) { const p0 = windPt; await ensurePick(w.slice(0, 10)); if (windPt === p0) renderWinds(); return; } const d = w.slice(0, 10); if (!wxCached(current.id, d) || Date.now() - wxCached(current.id, d).fetched > 3600e3 || wxCached(current.id, d).rh === undefined) { await ensureWx(false, d); renderWinds(); } }
$('qWinds').addEventListener('click', () => { const b = $('windsBox'); if (!b.classList.contains('hidden')) { b.classList.add('hidden'); syncQuick(); WindPick.sync(); return; } WindPick.reset(); b.classList.remove('hidden'); syncQuick(); setTWhen(current.when); });
WindPick.init({ map, isOpen: () => !$('windsBox').classList.contains('hidden'),
  open: () => { $('windsBox').classList.remove('hidden'); syncQuick(); setTWhen(tWhen || current.when); },
  close: () => { $('windsBox').classList.add('hidden'); syncQuick(); },
  onPick: p => { windPt = p; if (!$('windsBox').classList.contains('hidden')) setTWhen(tWhen || current.when); }, restoreBanner: () => placeBanner() });
$('t_close').addEventListener('click', () => { $('windsBox').classList.add('hidden'); syncQuick(); });
$('t_minus').addEventListener('click', () => setTWhen(shiftWhen(tWhen, -1)));
$('t_plus').addEventListener('click', () => setTWhen(shiftWhen(tWhen, 1)));
$('t_now').addEventListener('click', () => setTWhen(nowWhen()));
$('t_use').addEventListener('click', () => { const w = tWhen; setWhen(w); syncTUse(); toast(`Calcul à la date et l'heure du tableau : ${fmtWhen(w)}`); });
$('t_date').addEventListener('change', e => { if (e.target.value) setTWhen(e.target.value + tWhen.slice(10)); });
$('t_hour').addEventListener('change', e => setTWhen(tWhen.slice(0, 11) + e.target.value + ':00'));

// ---------- Placement des PRV : en touchant la carte ----------
function syncPlaceBtn() { $('btnPlaceP').classList.toggle('on', placing === 'P'); $('btnPlaceDZ').classList.toggle('on', placing === 'D'); }
function placeBanner() { setBanner(placing === 'P' ? 'Touche la carte pour placer le point de rendez-vous.' : placing === 'D' ? 'Touche la carte pour placer le centre de la DZ (verticale terrain).' : null); }
function setDz(p, how) { current.dz = { lat: p.lat, lng: p.lng }; persist(); fillInputs(); redraw(); toast(`Centre de la DZ placé ${how}. Appui long dessus pour le déplacer.`); }
$('btnPlaceDZ').addEventListener('click', () => {
  if (placing === 'D') { placing = null; placeBanner(); syncPlaceBtn(); return; }
  if (!current.id) return toast('Crée d\'abord une zone (＋ Nouvelle zone)');
  stopMeasure(); placing = 'D'; syncPlaceBtn(); placeBanner(); closeSheet();
});
$('btnDzGps').addEventListener('click', () => {
  if (!current.id) return toast('Crée d\'abord une zone (＋ Nouvelle zone)');
  if (!navigator.geolocation) return toast('Géolocalisation indisponible');
  $('btnDzGps').textContent = '🛰 Recherche…';
  navigator.geolocation.getCurrentPosition(pos => { $('btnDzGps').textContent = '🛰 Ma position (GPS)'; setDz({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 'à ta position'); },
    () => { $('btnDzGps').textContent = '🛰 Ma position (GPS)'; toast('Position refusée ou indisponible'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
});
$('btnDzDel').addEventListener('click', async () => { if (!current.dz) return; if (!(await ask('Supprimer le centre de la DZ ?'))) return; current.dz = null; persist(); fillInputs(); redraw(); });
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
var measSusp = null; /* placement mis de côté pendant la mesure 📏 */
function stopMeasure() {
  Object.assign(meas, { active: false, a: null, b: null, ma: null, mb: null, line: null, halo: null, lbl: null });
  map.getContainer().classList.remove('measuring');
  measLayer.clearLayers(); measBox(null); $('qMeasure').classList.remove('on');
  if (measSusp) { placing = measSusp; measSusp = null; placeBanner(); syncPlaceBtn(); redraw(); toast('Retour au placement en cours'); }
}
$('qMeasure').addEventListener('click', () => {
  if (meas.active) { stopMeasure(); return; }
  if (placing) { measSusp = placing; placing = null; placeBanner(); syncPlaceBtn(); redraw(); } /* 22 nov. 2026 (Henri) : mesure possible pendant un placement, il reprend en quittant la mesure */
  meas.active = true; $('qMeasure').classList.add('on'); map.getContainer().classList.add('measuring');
  measBox('Mesure : touche le <b>1er point</b>');
});
// Points de mesure déplaçables (comme les portes) : la mesure se met à jour pendant le glissement
const measIcon = L.divIcon({ className: 'measpt', iconSize: [34, 34], iconAnchor: [17, 17], html: '<span></span>' });
function measMarker(key) {
  const m = L.marker(LL(meas[key]), { draggable: false, icon: measIcon, zIndexOffset: 900 }).addTo(measLayer);
  longPressDrag(m, ll => { meas[key] = ll; updateMeasure(); }, () => { const q = snapMeasure(meas[key]); if (q !== meas[key]) { meas[key] = q; m.setLatLng([q.lat, q.lng]); updateMeasure(); } });
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
// Pendant la mesure (21 nov. 2026, demande d'Henri) : les autres points ne réagissent plus au doigt (classe « measuring »
// sur la carte, voir style.css), et un point de mesure posé à moins de 22 px d'un point existant se cale exactement dessus.
function snapMeasure(p) {
  const P = map.latLngToContainerPoint([p.lat, p.lng]); let best = p, bd = 22;
  map.eachLayer(l => {
    if (measLayer.hasLayer(l) || !l.getLatLng || (L.Circle && l instanceof L.Circle)) return;
    if (l instanceof L.Marker) { const sz = l.options.icon && l.options.icon.options && l.options.icon.options.iconSize; if (!sz || !(+sz[0] > 0)) return; } // étiquettes : pas de cible
    else if (!(l instanceof L.CircleMarker)) return;
    const ll = l.getLatLng(), d = P.distanceTo(map.latLngToContainerPoint(ll));
    if (d < bd) { bd = d; best = { lat: ll.lat, lng: ll.lng }; }
  });
  return best;
}
function measureClick(p) {
  p = snapMeasure(p);
  if (!meas.a) { meas.a = p; meas.ma = measMarker('a'); measBox('Mesure : touche le <b>2e point</b>'); return; }
  if (!meas.b) { meas.b = p; meas.mb = measMarker('b'); updateMeasure(); }
  // une fois les deux points posés, on les déplace au doigt ; un appui sur la carte ne fait rien
}

map.on('click', e => {
  if (Date.now() < suppressClickUntil) return; // fin d'un déplacement de point : pas un appui
  if ((typeof Photo !== 'undefined') && Photo.onMapClick(e)) return; // calage d'une photo aérienne en cours
  if ((typeof WindPick !== 'undefined') && WindPick.onMapClick(e)) return; // point choisi pour le tableau des vents
  if (!placing && meas.active) { measureClick({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
  if (!placing) return;
  if (!current.id) { if (!namingZone) { namingZone = true; askZoneName().then(ok => { namingZone = false; if (ok) map.fire('click', e); }); } return; } // nom d'abord, puis le point
  const p = { lat: e.latlng.lat, lng: e.latlng.lng }, what = placing;
  placing = null; placeBanner(); syncPlaceBtn();
  if (what === 'D') setDz(p, 'sur la carte'); else addPrv(p);
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
setTimeout(() => { if (!current.id && (current.prvs && current.prvs.length)) askZoneName('Ta zone en cours n\'est pas enregistrée. Donne-lui un nom pour la garder (elle s\'enregistre ensuite toute seule) :'); }, 1500);

// Rotation portrait ↔ paysage : recadrage automatique, une fois la rotation finie (iOS envoie plusieurs « resize »
// pendant l'animation : un recadrage trop tôt utilisait une taille d'écran intermédiaire → figure minuscule en paysage)
let lastLand = innerWidth > innerHeight, fitT = 0, fitPending = false;
function onResize() {
  clearTimeout(fitT);
  const land = innerWidth > innerHeight; if (land !== lastLand) { lastLand = land; fitPending = true; }
  fitT = setTimeout(() => {
    map.invalidateSize({ animate: false });
    if (fitPending) { fitPending = false; if (figurePoints().length >= 2) { fitFigure(); setTimeout(() => { map.invalidateSize({ animate: false }); fitFigure(); }, 700); } }
  }, 500);
}
['resize', 'orientationchange'].forEach(ev => window.addEventListener(ev, onResize));
if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

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
// Zone jamais nommée (appli ouverte puis point posé directement) : on demande son nom AVANT le premier point,
// et elle s'enregistre ensuite toute seule (20 nov. 2026 — Laura avait préparé un saut dans une « Nouvelle zone (non enregistrée) »)
let namingZone = false;
async function askZoneName(msg) {
  if (current.id) return true;
  const n = await ask(msg || 'Nom de la zone (ex. Bouloc) ? Elle s\'enregistre ensuite toute seule.', current.name && current.name !== 'Nouvelle zone' ? current.name : '');
  if (!n || !String(n).trim()) return false;
  current.name = String(n).trim(); current.id = 'z' + Date.now(); current.updated = Date.now();
  zones.push(clone(current)); store.set('vl.zones', zones); persist(); fillInputs(); renderZones();
  toast(`Zone « ${current.name} » enregistrée`); return true;
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
    b.className = 'res club'; b.innerHTML = `<b>🪂 ${esc(k.n)}</b><br><small>${esc(k.t || 'Club FFP')} · ${esc(k.v)}</small>`;
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
  if (current.dz) { const c = toC(current.dz), r = 9 * u; g.save(); g.strokeStyle = '#000'; g.lineWidth = 5 * u; g.beginPath(); g.arc(c.x, c.y, r, 0, 2 * Math.PI); g.moveTo(c.x - 1.7 * r, c.y); g.lineTo(c.x + 1.7 * r, c.y); g.moveTo(c.x, c.y - 1.7 * r); g.lineTo(c.x, c.y + 1.7 * r); g.stroke();
    g.strokeStyle = '#ff8c00'; g.lineWidth = 2.4 * u; g.stroke(); g.restore();
    const bw = barbWind(toC); if (bw) { const bg = barbRight(bw, u, c.x + 1.7 * r + 5 * u, c.y); g.save(); g.lineCap = 'round'; /* v0.25.6 : barbule du vent au sol, comme trace-isv */
      const st = (col, w) => { g.strokeStyle = col; g.lineWidth = w; bg.lines.forEach(([p, q]) => { g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); }); if (bg.calm) { g.beginPath(); g.arc(bg.T.x, bg.T.y, 2.5 * u, 0, 2 * Math.PI); g.stroke(); } };
      st('rgba(0,0,0,.55)', 2.6 * u); bg.tris.forEach(t => { g.beginPath(); g.moveTo(t[0].x, t[0].y); t.slice(1).forEach(q => g.lineTo(q.x, q.y)); g.closePath(); g.fillStyle = '#00e5ff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = .6 * u; g.stroke(); }); st('#00e5ff', 1.1 * u); g.restore(); } } // centre de la DZ : même dessin qu'à l'écran (cible orange, v0.24.2)
  current.prvs.forEach(p => { const used = sol.prv && p.id === sol.prv.id; g.save(); g.globalAlpha = used ? 1 : 0.5; dot(p, C_PRV, 9); /* v0.24.2 : PRV utilisé jaune plein, les autres jaunes transparents */ g.restore(); });
  { const a = toC(sol.start), b = toC(sol.end);
    g.save(); g.lineCap = 'round'; g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 10 * u; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.strokeStyle = '#000'; g.lineWidth = 5 * u; g.stroke(); g.restore();
    { const h = sol.hi; if (h && h.d) { /* v0.27.0 : ouverture haute des derniers, comme à l'écran */
      const E = toC(h.end), A0 = toC(sol.start), B0 = toC(sol.end), l = Math.hypot(B0.x - A0.x, B0.y - A0.y) || 1, ax = { x: (B0.x - A0.x) / l, y: (B0.y - A0.y) / l }, hf = 9 * u;
      const T1 = { x: E.x - ax.y * hf, y: E.y + ax.x * hf }, T2 = { x: E.x + ax.y * hf, y: E.y - ax.x * hf }, seg = (P, Q, col, w, dash) => { g.save(); g.lineCap = 'butt'; g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash || []); g.beginPath(); g.moveTo(P.x, P.y); g.lineTo(Q.x, Q.y); g.stroke(); g.restore(); };
      if (h.d > 0) { seg(B0, E, 'rgba(255,255,255,.55)', 4.5 * u, [7 * u, 6 * u]); seg(B0, E, '#000', 2.5 * u, [7 * u, 6 * u]); seg(T1, T2, 'rgba(255,255,255,.7)', 5.5 * u); seg(T1, T2, '#000', 3 * u); }
      else { seg(T1, T2, 'rgba(0,0,0,.6)', 5.5 * u); seg(T1, T2, C_END, 3 * u); }
      const txt = hiText(h); if (txt) { const sd = hiSide(toC), P = { x: sd.E.x + sd.n.x * 14 * u, y: sd.E.y + sd.n.y * 14 * u }; g.save(); g.font = `bold ${11 * u}px sans-serif`;
        g.textAlign = sd.n.x >= 0 ? 'left' : 'right'; g.textBaseline = sd.n.y > 0.7 ? 'top' : sd.n.y < -0.7 ? 'bottom' : 'middle'; g.lineJoin = 'round';
        g.lineWidth = 3 * u; g.strokeStyle = h.d > 0 ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.85)'; g.strokeText(txt, P.x, P.y); g.fillStyle = h.d > 0 ? '#000' : C_END; g.fillText(txt, P.x, P.y); g.restore(); } } }
    dot(sol.start, C_START, 9); dot(sol.end, C_END, 9); // même taille que les PRV, comme à l'écran
    { const bw = sol.windRel && barbWind(toC, sol.windRel, sol.start); if (bw) { const p = greenBarbPos(toC, 24 * u), bg = barbAt(bw, u, p.c.x, p.c.y); g.save(); g.lineCap = 'round'; /* v0.25.7 : vent de largage à côté du vert */
      const st = (col, w) => { g.strokeStyle = col; g.lineWidth = w; bg.lines.forEach(([p0, q]) => { g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(q.x, q.y); g.stroke(); }); if (bg.calm) { g.beginPath(); g.arc(bg.T.x, bg.T.y, 2.5 * u, 0, 2 * Math.PI); g.stroke(); } };
      st('rgba(0,0,0,.55)', 2.6 * u); bg.tris.forEach(t => { g.beginPath(); g.moveTo(t[0].x, t[0].y); t.slice(1).forEach(q => g.lineTo(q.x, q.y)); g.closePath(); g.fillStyle = '#00e5ff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = .6 * u; g.stroke(); }); st('#00e5ff', 1.1 * u); g.restore(); } }
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, ne = sol.exits ? sol.exits.n : 1;
    /* PDF : jamais de cartouche sur la carte, tout est dans le bandeau d'informations */ }
  if (current.show.nm && current.dz) { // cercles NM autour de la DZ, comme à l'écran (traits plus épais)
    const c = toC(current.dz), pm = pxPerM(current.dz), gap = 0.1 * NM * pm / u;
    for (let k = 1; k <= 20; k++) {
      const st = nmRingStyle(k), major = k % 5 === 0; if (!major && gap < 5) continue;
      g.save(); g.strokeStyle = '#fff'; g.globalAlpha = st.op; g.lineWidth = st.w * 1.8 * u; g.setLineDash(st.dash ? st.dash.map(d => d * 1.6 * u) : []);
      g.beginPath(); g.arc(c.x, c.y, k * 0.1 * NM * pm, 0, 2 * Math.PI); g.stroke(); g.restore();
      if (major || gap >= 14) [0, 90, 180, 270].forEach(dg => { const an = pageAngle(dg), rr = k * 0.1 * NM * pm; shadowText(nmLabel(k), c.x + rr * Math.sin(an), c.y - rr * Math.cos(an), '#fff', 11, 'center'); }); // aux 4 points cardinaux, comme à l'écran
    }
  }
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
  tx(`Vecteur ${hdg(sol.heading)} · ${fmtInt(sol.length)} m${sol.dzInfo ? ' · vert : ' + dzText(sol) : ''}`, col1, l0 + lh * 2.4, '#fff', fs, true);
  tx(`${exP.n} sortie${exP.n > 1 ? 's' : ''}${exP.dt ? ` · une toutes les ${fmt1(exP.dt)} s (${fmtInt(exP.s)} m au sol, séparation ${exP.sep} m)` : ''}`, col1, l0 + lh * 3.4, C_PRVUSED, fs, true);
  tx(`Largage FL${Math.round(sol.flRel)} = ${fmtInt(sol.hRel)} m sol · ouverture ${fmtInt(p.hOpen)} m sol`, col1, l0 + lh * 4.4, C_END, fs, true);
  tx(`PRV ${sol.prvAuto ? 'automatique' : 'choisi à la main'} · ${sol.why}${current.reversed ? ' · sens inversé' : ''}`, col1, l0 + lh * 5.4, '#ffd400', fs);
  [
    (zeroWind ? 'TEST VENT FORCÉ À 0 · ' : '') + `Vent de largage : ${hdg(sol.windRel.dir)} ${Math.round(sol.windRel.spd * KT)} kt (${fmt1(sol.windRel.spd)} m/s) · ${acName()} ${Math.round(p.acMs * KT)} kt badin (${Math.round(sol.tas * KT)} kt vraie)`,
    `Chute ${p.vff} m/s · perte à l'ouverture ${p.openLoss} m`,
    `${p.perpTime} s perpendiculaire (sauf le dernier) · sous voile Vh ${fmt1((+p.vz) * (+p.glide))} m/s, Vz ${fmt1(+p.vz)} m/s (finesse ${fmt1(+p.glide)})`,
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
  const cols = [['Niveau', 15], ['Hauteur sol', 42], ['Axe (M)', 78], ['Force', 102], ['', 124], ['Temp.', 152], ['Hum.', 177]];
  let y = 35; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); cols.forEach(([t, x]) => doc.text(t, x, y)); doc.setFont('helvetica', 'normal');
  windRows(prof, elev).forEach((r, i) => {
    y += 6.6; if (y > 285) { doc.addPage('a4', 'portrait'); y = 20; }
    if (i % 2 === 0) { doc.setFillColor(238, 238, 238); doc.rect(13, y - 4.6, 184, 6.4, 'F'); }
    [r.lab, fmtInt(r.h).replace(/[\u202f\u00a0]/g, ' ') + ' m', hdgN(r.dir), Math.round(r.spd * KT) + ' kt', fmt1(r.spd) + ' m/s', r.T == null ? '–' : Math.round(r.T) + ' °C', r.RH == null ? '–' : Math.round(r.RH) + ' %'].forEach((t, k) => doc.text(t, cols[k][1], y));
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
/* Aperçu du PDF dans l'appli (pdfview.js, 21 nov. 2026) */
$('pdfPreview').addEventListener('click', () => { if (pdfFile) PdfView.show(pdfFile); });
$('pdfShare').addEventListener('click', async () => {
  if (!pdfFile) return;
  try {
    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) { await navigator.share({ files: [pdfFile] }); /* sans title : iOS en ferait un .txt en plus */ }
    else { const url = URL.createObjectURL(pdfFile); const a = document.createElement('a'); a.href = url; a.download = pdfFile.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    $('pdfReady').classList.add('hidden');
  } catch (e) { if (e && e.name !== 'AbortError') toast('Partage impossible'); }
});


// ---------- Sauvegarde (20 nov. 2026) : zones et paramètres dans deux fichiers séparés ----------
// Donner ses zones à quelqu'un ne touche jamais à sa paramètres : onglet Zones = fichier des zones, onglet Paramètres = fichier de les paramètres.
// Nom du fichier : AAAAMMJJ_Vecteur_Largage_<Zones|Parametres>_<Prénom>.json — le prénom est demandé à l'export (le dernier est proposé).
async function shareJson(obj, name) {
  const file = new File([JSON.stringify(obj, null, 1)], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] }); /* sans title : iOS en ferait un .txt en plus */
    else { const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  } catch (e) { if (e && e.name !== 'AbortError') toast('Export impossible'); }
}
async function exportKind(kind) { /* v (Henri, 25/11/2026) : kind 'zone' = seulement la zone ouverte (même format que « zones », réimportable pareil) */
  persist(); const one = kind === 'zone'; if (one && !(current.id && zones.some(z => z.id === current.id))) { toast('Donne d\'abord un nom à la zone ouverte (elle n\'est pas encore enregistrée)'); return; }
  const n = await ask('Ton prénom (il sera dans le nom du fichier, pour savoir de qui il vient) :', store.get('vl.author', ''));
  if (n === null) return;
  const who = String(n).trim(); store.set('vl.author', who);
  const obj = { app: 'vecteur-largage', kind, v: 4, exported: new Date().toISOString(), author: who };
  if (one) obj.kind = 'zones';
  if (kind === 'zones' || one) { obj.zones = one ? zones.filter(z => z.id === current.id) : zones;
    /* v0.24.0 (Henri, 25/11/2026) : la prévision du vecteur enregistré part avec la zone ; à l'import elle est gardée telle quelle
       (« Garder ce vecteur » ne retélécharge rien ; « Mettre à jour à maintenant » prend la prévision du moment) */
    obj.wx = {}; obj.zones.forEach(z => { const d = z.vector && z.vector.when ? String(z.vector.when).slice(0, 10) : null; if (!d) return; const r = wxCached(z.id, d); if (r && r.hourly) obj.wx[z.id + '|' + d] = r; }); }
  else obj.profile = profile;
  await shareJson(obj, `${dateStamp()}_Vecteur_Largage_${one ? 'Zone_' + safeName(current.name || 'zone') : kind === 'zones' ? 'Zones' : 'Parametres'}${who ? '_' + safeName(who) : ''}.json`);
}
async function readJsonFile(input) {
  const f = input.files && input.files[0]; if (!f) return null;
  try { return JSON.parse(await f.text()); } catch (er) { toast('Fichier illisible'); return null; }
}
const fromWho = d => d && d.author ? ` de ${d.author}` : '';
$('btnExportZones').addEventListener('click', () => exportKind('zones'));
$('btnExportZone').addEventListener('click', () => exportKind('zone'));
$('btnExportProf').addEventListener('click', () => exportKind('profile'));
$('btnImportZones').addEventListener('click', () => { $('importZonesFile').value = ''; $('importZonesFile').click(); });
$('btnImportProf').addEventListener('click', () => { $('importProfFile').value = ''; $('importProfFile').click(); });
// Importer des zones : toujours une fusion, jamais d'écrasement. Une zone déjà présente (même zone) reste telle quelle.
// Les zones importées prennent TA paramètres. Pour repartir d'un fichier, effacer d'abord les zones puis importer.
$('importZonesFile').addEventListener('change', async e => {
  const d = await readJsonFile(e.target); if (!d) return;
  if (!Array.isArray(d.zones)) { toast(d.profile ? 'Ce fichier contient des paramètres : importe-le depuis l\'onglet Paramètres' : 'Fichier illisible'); return; }
  let added = 0, kept = 0;
  d.zones.map(upgrade).forEach(z => {
    if (!z.id) z.id = 'z' + Date.now() + Math.random().toString(36).slice(2, 6);
    if (zones.some(x => x.id === z.id)) { kept++; return; }
    applyProfile(z); zones.push(z); added++;
    Object.keys(d.wx || {}).forEach(k => { const [zid, day] = k.split('|'); if (zid !== z.id || !d.wx[k] || !d.wx[k].hourly) return; const key = wxKey(z.id, day); wxMem[key] = d.wx[k]; store.set(key, d.wx[k]); }); /* v0.24.0 : prévision de l'export */
  });
  store.set('vl.zones', zones); renderZones(); redraw();
  toast(`Zones${fromWho(d)} : ${added} ajoutée(s)${kept ? `, ${kept} déjà présente(s) gardée(s) telles quelles` : ''}`);
});
// Importer des paramètres : remplace tes paramètres (on n'en a qu'une) ; les zones ne bougent pas.
$('importProfFile').addEventListener('change', async e => {
  const d = await readJsonFile(e.target); if (!d) return;
  if (!d.profile || typeof d.profile !== 'object') { toast(Array.isArray(d.zones) ? 'Ce fichier contient des zones : importe-le depuis l\'onglet Zones' : 'Fichier illisible'); return; }
  PROFILE_KEYS.forEach(k => { if (d.profile[k] !== undefined) profile[k] = d.profile[k]; }); store.set('vl.profile', profile);
  zones.forEach(applyProfile); store.set('vl.zones', zones); applyProfile(current); persist(); fillInputs(); redraw();
  toast(`Paramètres${fromWho(d)} importés`);
});
// Effacer : les zones seulement (et la zone en cours) — les paramètres sont gardés (pas de bouton pour l'effacer : la modifier à la main).
$('btnWipe').addEventListener('click', async () => {
  if (!(await ask('Effacer TOUTES les zones enregistrées (et la zone en cours) ? C\'est définitif. Tes paramètres sont gardés. Pense à exporter les zones avant si besoin.'))) return;
  Object.keys(localStorage).filter(k => k.startsWith('vl.') && !/^vl\.(profile|author|lastParams|mig\.)/.test(k)).forEach(k => { try { localStorage.removeItem(k); } catch (er) {} });
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
  // Nouvelle version installée : recharger, mais jamais pendant qu'une question est affichée (sinon la réponse est perdue et la question revient)
  const reloadWhenFree = () => { const d = document.getElementById('dialog'); if (d && !d.classList.contains('hidden')) { setTimeout(reloadWhenFree, 400); return; } location.reload(); };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; reloadWhenFree(); } });
  navigator.serviceWorker.register('sw.js').then(reg => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}

$('qZero').addEventListener('click', () => { zeroWind = !zeroWind; store.set('vl.zeroWind', zeroWind); current.offsetManual = null; compute(); redraw(); syncQuick(); fillInputs(true); if ($('windsBox') && !$('windsBox').classList.contains('hidden')) renderWinds(); toast(zeroWind ? 'Vent forcé à 0 partout (test)' : 'Vents de la prévision'); });

/* Titres de paragraphe (h3) collés sous les onglets quand on fait défiler le menu (21 nov. 2026, commun à toutes les applis) */
(function () {
  const s = document.getElementById('sheet'), t = s && s.querySelector('.tabs'); if (!t) return;
  const f = () => { if (t.offsetHeight) s.style.setProperty('--h3top', ((parseFloat(getComputedStyle(t).top) || 0) + t.offsetHeight) + 'px'); };
  if (window.ResizeObserver) new ResizeObserver(f).observe(t); window.addEventListener('resize', f); f();
})();

/* Zoom au pincement du trackpad (Mac) : le navigateur l'envoie en « wheel » avec ctrlKey, et Leaflet le divise
   tellement (deltaY / 6 sur Mac) que le zoom est très lent. On le traite ici, plus réactif (21 nov. 2026, commun aux applis carte).
   Sans effet sur iPhone (pincement tactile) ni sur la molette de la souris. */
(function () {
  const el = map.getContainer(); let acc = 0, pt = null, raf = 0;
  el.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    acc += -e.deltaY * (e.deltaMode === 1 ? 0.25 : 0.012); pt = map.mouseEventToContainerPoint(e);
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0; const z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), map.getZoom() + acc)); acc = 0;
      if (Math.abs(z - map.getZoom()) > 1e-3) map.setZoomAround(pt, z, { animate: false });
    });
  }, { capture: true, passive: false });
})();
/* v0.25.0 (Henri) : le cadre du cap en haut ouvre l'onglet Zones au chapitre « Cap de largage » (axe imposé, puis cap à la main) */
$('capInfo').addEventListener('click', () => { openSheet('zones'); setTimeout(() => { const s = $('capSec'), sh = $('sheet'), tb = sh.querySelector('.tabs'); if (!s) return; sh.scrollTop += s.getBoundingClientRect().top - sh.getBoundingClientRect().top - (tb ? tb.offsetHeight + 30 : 80); }, 60); /* titre juste sous les onglets (titres et onglets collants) */ });

/* 26 nov. 2026 (Henri, toutes les applis carte) : boutons ↶ ↷ à côté de « Paramètres » qui annule la dernière action (undo.js) */
$('btnUndo').innerHTML = Undo.ICON; $('btnRedo').innerHTML = Undo.ICON_REDO; /* et ↷ juste à côté pour rétablir l'action annulée */
Undo.init({ toast, ignore: ['vector'], state: () => ({ key: current.id || '', obj: current }),
  restore: o => {
    current = upgrade(Object.assign(o, { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing() }));
    if (current.params) { PROFILE_KEYS.forEach(k => { if (k in current.params) profile[k] = current.params[k]; }); store.set('vl.profile', profile); zones.forEach(applyProfile); }
    resetMarkers(); placing = null; setBanner(null); stopMeasure(); fillInputs(); /* Henri : ni onglet, ni fenêtre, ni zoom ne changent */ redraw(); persist();
  } });
