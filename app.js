'use strict';
// Filet de sécurité : toute erreur s'affiche au lieu de laisser une carte vide
window.addEventListener('error', e => {
  const t = document.getElementById('toast');
  if (t) { t.textContent = 'Erreur : ' + (e.message || 'inconnue') + ' — ferme et rouvre l\'appli'; t.classList.remove('hidden'); }
});
const VERSION = '0.1.0';
const APP_ID = 'vl';
// Fonds de carte : Esri (monde entier) ou photos aériennes IGN (France, licence ouverte : hors-ligne et PDF autorisés)
const BASEMAPS = {
  esri: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Imagerie © Esri, Maxar, Earthstar Geographics', maxNative: 19 },
  ign: { url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', attr: 'Photos aériennes © IGN – Géoplateforme', maxNative: 19 }
};
const TILE_CACHE = 'vl-tiles-v1';
// Réglages de la manœuvre (communs à toutes les zones) : secteur de finale, vent max, prépo par vent nul et au vent max
const DEFAULT_PARAMS = {
  sector: 30, vmax: 7,
  d0: 250, s0: 80, h0: 300,     // prépo par vent nul : profondeur, déport latéral, hauteur (m)
  dM: 80, sM: 30, hM: 150,      // prépo au vent max
  zoneFrac: 0,                  // zone de prépo : 0 = simple point ; sinon diamètre = largeur du secteur à cette fraction
  ticks: true
};
const PROFILE_KEYS = ['sector', 'vmax', 'd0', 's0', 'h0', 'dM', 'sM', 'hM', 'zoneFrac'];
const C_TARGET = '#ff2020', C_SECTOR = '#ff8c00', C_PREPO = '#ff2020', C_PATH = '#ffd400', C_REP = '#ffffff';
const isDark = c => c === '#000000';

// ---------- Stockage (clés pa.* : séparées de Setup PSV, même site) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Enregistrement impossible sur cet appareil'); } }
};
const clone = o => JSON.parse(JSON.stringify(o));
const SHOW_DEFAULT = { sector: true, prepo: true, path: true, reperes: true };
function upgrade(z) {
  if (!z) return z;
  z.params = Object.assign({}, DEFAULT_PARAMS, z.params || {});
  z.show = Object.assign({}, SHOW_DEFAULT, typeof z.show === 'object' ? z.show : {});
  z.reperes = Array.isArray(z.reperes) ? z.reperes : [];
  z.side = z.side === 'G' ? 'G' : 'D';
  if (typeof z.windDir !== 'number') z.windDir = null;
  if (typeof z.windSpeed !== 'number') z.windSpeed = 0;
  return z;
}
let zones = store.get('vl.zones', []).map(upgrade);
let current = upgrade(store.get('vl.current', null)) || newZone(null);
// La copie de base (v0.1) pouvait contenir des zones PSV vides : on ne garde que les zones PA
zones = zones.filter(z => !z.gateA || z.target);
store.set('vl.zones', zones);
if (current.gateA && !current.target) current = newZone(null);

// ---------- Manœuvre : réglages communs à toutes les zones ----------
let profile = store.get('vl.profile', null) || {};
PROFILE_KEYS.forEach(k => { if (profile[k] === undefined) profile[k] = DEFAULT_PARAMS[k]; });
Object.keys(profile).forEach(k => { if (!PROFILE_KEYS.includes(k)) delete profile[k]; }); // restes de la copie PSV
store.set('vl.profile', profile);
function applyProfile(z) { if (z && z.params) PROFILE_KEYS.forEach(k => { z.params[k] = profile[k]; }); }
applyProfile(current); zones.forEach(applyProfile); store.set('vl.zones', zones);

function newZone(center) {
  return upgrade({
    id: null, name: 'Nouvelle zone',
    center: center || { lat: 46.6, lng: 2.4 }, zoom: center ? 17 : 6,
    target: null, windDir: null, windSpeed: 0, side: 'D', reperes: [],
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

const hdg = h => String(Math.round(((h % 360) + 360) % 360)).padStart(3, '0') + '°';
function cardOf(h) { h = ((h % 360) + 360) % 360; if (h >= 315 || h <= 45) return 'N'; if (h >= 135 && h <= 225) return 'S'; return h < 180 ? 'E' : 'O'; }
const fmt1 = v => (Math.round(v * 10) / 10).toString().replace('.', ',');

// ---------- Figure (calcul pur, réutilisé par la carte et le PDF) ----------
// Repère local centré sur la cible (x = Est, y = Nord, en m).
// Le vent vient de windDir : on pose face au vent (cap de finale = windDir), en arrivant du côté sous le vent.
function hasTarget() { return !!current.target; }
function hasWind() { return typeof current.windDir === 'number'; }
function finalHeading() { return hasWind() ? ((current.windDir % 360) + 360) % 360 : 0; }
function prepoAt(v) { // prépo pour un vent de v m/s, interpolée en ligne droite entre vent nul et vent max
  const p = current.params, vm = Math.max(0.1, +p.vmax || 7), k = Math.min(1, Math.max(0, (+v || 0) / vm));
  const lerp = (a, b) => (+a || 0) + ((+b || 0) - (+a || 0)) * k;
  const d = lerp(p.d0, p.dM), s = lerp(p.s0, p.sM), h = lerp(p.h0, p.hM);
  const W = finalHeading() * Math.PI / 180;
  const down = { x: -Math.sin(W), y: -Math.cos(W) };      // vers l'aval du vent (d'où l'on arrive en finale)
  const right = { x: Math.cos(W), y: -Math.sin(W) };      // droite du parachutiste face à la cible, face au vent
  const sg = current.side === 'G' ? -1 : 1;
  const v2 = { x: d * down.x + sg * s * right.x, y: d * down.y + sg * s * right.y };
  return { v: v2, ll: Geo.fromLocal(current.target, v2), d, s, h, dist: Math.hypot(v2.x, v2.y) };
}
function figure() {
  if (!hasTarget() || !hasWind()) return null;
  const p = current.params, half = Math.max(1, +p.sector || 30) / 2;
  const cur = prepoAt(current.windSpeed);
  const R = Math.max(20, cur.dist);
  const W = finalHeading(), back = W + 180;
  const arc = [];
  for (let a = -half; a <= half + 0.01; a += half / 8) {
    const r = (back + a) * Math.PI / 180;
    arc.push(Geo.fromLocal(current.target, { x: R * Math.sin(r), y: R * Math.cos(r) }));
  }
  const vm = Math.max(1, Math.round(+p.vmax || 7));
  const path = []; for (let v = 0; v <= vm; v++) path.push(Object.assign({ wind: v }, prepoAt(v)));
  const zoneR = (+p.zoneFrac || 0) > 0 ? (+p.zoneFrac) * R * Math.tan(half * Math.PI / 180) : 0;
  return { cur, R, arc, half, path, zoneR, W };
}
function repDist(r) { return current.target ? map.distance(LL(current.target), LL(r)) : 0; }
// Toutes les positions à faire tenir dans un cadrage
function figurePoints() {
  const pts = [];
  if (current.target) pts.push(current.target);
  const f = figure();
  if (f) {
    pts.push(...f.arc, f.cur.ll);
    if (current.params.ticks !== false) { // cercle gradué autour de la cible, chiffres compris
      const rr = Math.max(25, f.R * 0.45) * 1.3;
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; pts.push(Geo.fromLocal(current.target, { x: rr * Math.sin(a), y: rr * Math.cos(a) })); }
    }
    if (current.show.path) f.path.forEach(q => pts.push(q.ll));
  }
  if (current.show.reperes) current.reperes.forEach(r => pts.push(r));
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
let placing = null, posMarker = null; // placing : null | 'T' (cible) | 'R' (repère)
let markerT = null; const repMarkers = {};

function dotIcon(color, size, label, cls) {
  return L.divIcon({
    className: 'dot ' + (cls || ''),
    html: `<span style="background:${color};width:${size}px;height:${size}px"></span>${label ? `<b class="${isDark(color) ? 'onlight' : ''}" style="color:${color}">${label}</b>` : ''}`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2]
  });
}
const LL = p => [p.lat, p.lng];

let raf = 0;
function redraw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
let lightT = 0;
function drawLight() { const n = performance.now(); if (n - lightT > 60) { lightT = n; draw(); } }
const mPerPx = ll => 40075016.686 * Math.cos(ll.lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);

function draw() {
  fig.clearLayers(); grads.clearLayers();
  if ((typeof Photo !== 'undefined')) Photo.sync();
  updateInfo(); syncQuick(); syncPlaceBtn();
  if (!hasTarget()) {
    if (placing) placeBanner(); else setBanner('Pour commencer : ☰ → ＋ Nouvelle zone, puis place la cible.');
    placeMarkers(); return;
  }
  if (!placing) setBanner(hasWind() ? null : 'Règle le vent du jour : bouton 🌬 à gauche.');
  const f = figure(), sh = current.show;
  if (f) {
    // Graduations en degrés autour de la cible (pour lire la direction du vent)
    if (current.params.ticks !== false) degRing(current.target, Math.max(25, f.R * 0.45), '#ffffff');
    // Secteur de finale : sommet sur la cible, ouvert côté sous le vent, jusqu'à la prépo affichée
    if (sh.sector) {
      L.polygon([LL(current.target), ...f.arc.map(LL)], { color: C_SECTOR, weight: 2, fillColor: C_SECTOR, fillOpacity: .16, interactive: false }).addTo(fig);
    }
    // Chemin des prépos de 0 au vent max, gradué tous les 1 m/s
    if (sh.path && sh.prepo) {
      const pl = f.path.map(q => LL(q.ll));
      L.polyline(pl, { color: '#000', weight: 5, opacity: .45, interactive: false }).addTo(fig);
      L.polyline(pl, { color: C_PATH, weight: 2.5, interactive: false }).addTo(fig);
      const step = pathLabelStep(f);
      f.path.forEach(q => {
        L.circleMarker(LL(q.ll), { radius: 3, color: '#111', weight: 1, fillColor: C_PATH, fillOpacity: 1, interactive: false }).addTo(fig);
        if (q.wind % step === 0 || q.wind === f.path.length - 1)
          L.marker(LL(q.ll), { interactive: false, icon: L.divIcon({ className: 'plabel', iconSize: [0, 0], html: `<span>${q.wind}</span>` }) }).addTo(grads);
      });
    }
    // Prépo du vent saisi (point, ou zone si réglée) + sa hauteur
    if (sh.prepo) {
      if (f.zoneR > 0) L.circle(LL(f.cur.ll), { radius: f.zoneR, color: C_PREPO, weight: 2, fillOpacity: .12, dashArray: '5 5', interactive: false }).addTo(fig);
      L.marker(LL(f.cur.ll), { interactive: false, zIndexOffset: 500, icon: dotIcon(C_PREPO, 16, `${Math.round(f.cur.h)} m`, 'big') }).addTo(fig);
    }
  }
  placeMarkers();
}
function pathLabelStep(f) { // chiffres du chemin : pas plus serrés que ~26 px
  const a = map.latLngToContainerPoint(LL(f.path[0].ll)), b = map.latLngToContainerPoint(LL(f.path[f.path.length - 1].ll));
  const per = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, f.path.length - 1);
  return per >= 26 ? 1 : per >= 13 ? 2 : per >= 7 ? 5 : 100;
}
function degRing(center, radius, color) {
  const mpp = mPerPx(center);
  L.circle(LL(center), { radius, color, weight: 1.5, opacity: .8, fill: false, dashArray: '4 6', interactive: false }).addTo(grads);
  const degs = Geo.degTicks(radius / mpp);
  const pt = (deg, d) => { const a = deg * Math.PI / 180; return LL(Geo.fromLocal(center, { x: d * Math.sin(a), y: d * Math.cos(a) })); };
  const segs = [];
  degs.forEach(deg => {
    segs.push([pt(deg, radius), pt(deg, radius - 10 * mpp)]);
    L.marker(pt(deg, radius + 15 * mpp), { interactive: false,
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

// ---------- Cible et repères : appui long pour déplacer, appui court sur un repère = nom / suppression ----------
const targetIcon = L.divIcon({ className: 'target', iconSize: [34, 34], iconAnchor: [17, 17], html: '<span></span>' });
function repIcon(r) {
  const d = Math.round(repDist(r));
  return L.divIcon({ className: 'rep', iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<span></span><b>${r.name ? esc(r.name) + ' · ' : ''}${d} m</b>` });
}
function placeMarkers() {
  if (current.target) {
    if (!markerT) {
      markerT = L.marker(LL(current.target), { icon: targetIcon, zIndexOffset: 1000 }).addTo(map);
      longPressDrag(markerT, ll => { current.target = ll; drawLight(); }, () => { persist(); redraw(); });
    } else if (!isDragging(markerT)) markerT.setLatLng(LL(current.target));
  } else if (markerT) { map.removeLayer(markerT); markerT = null; }
  const shown = current.show.reperes ? current.reperes : [];
  Object.keys(repMarkers).forEach(id => { if (!shown.find(r => r.id === id)) { map.removeLayer(repMarkers[id]); delete repMarkers[id]; } });
  shown.forEach(r => {
    let m = repMarkers[r.id];
    if (!m) {
      m = repMarkers[r.id] = L.marker(LL(r), { icon: repIcon(r), zIndexOffset: 900 }).addTo(map);
      longPressDrag(m, ll => { const q = current.reperes.find(x => x.id === r.id); if (q) { q.lat = ll.lat; q.lng = ll.lng; m.setIcon(repIcon(q)); } },
        () => { persist(); redraw(); });
      m.on('click', () => { if (Date.now() < suppressClickUntil || placing || meas.active) return; editRepere(r.id); });
    } else if (!isDragging(m)) { m.setLatLng(LL(r)); m.setIcon(repIcon(r)); }
  });
}
function resetMarkers() {
  if (markerT) { map.removeLayer(markerT); markerT = null; }
  Object.keys(repMarkers).forEach(id => { map.removeLayer(repMarkers[id]); delete repMarkers[id]; });
}
async function editRepere(id) {
  const r = current.reperes.find(x => x.id === id); if (!r) return;
  const res = await ask(`Repère à ${Math.round(repDist(r))} m de la cible. Nom (facultatif) :`, r.name || '', 'Supprimer');
  if (res === 'DELETE') { current.reperes = current.reperes.filter(x => x.id !== id); persist(); redraw(); toast('Repère supprimé'); return; }
  if (res === null) return;
  r.name = res; if (repMarkers[id]) repMarkers[id].setIcon(repIcon(r)); persist();
}
function addRepere(p) {
  current.reperes.push({ id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lat: p.lat, lng: p.lng, name: '' });
  current.show.reperes = true; persist(); redraw();
  toast(`Repère placé à ${Math.round(repDist(p))} m de la cible. Touche-le pour le nommer ou le supprimer.`);
}
function setTarget(p) {
  current.target = p; persist(); redraw();
  if (!hasWind()) { openWind(); toast('Cible placée. Règle maintenant le vent du jour.'); }
  else { fitFigure(); toast('Cible placée. Appui long dessus pour la déplacer.'); }
}

// Cadre la figure dans la partie libre de l'écran (hors barre du haut, boutons de gauche, zoom),
// en tenant compte de la rotation de la carte (fitBounds de Leaflet l'ignore).
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
  const f = figure();
  $('axisInfo').textContent = !hasTarget() ? 'Cible pas encore placée.'
    : !hasWind() ? 'Vent du jour pas encore réglé (bouton 🌬 sur la carte).'
    : `Vent du ${hdg(current.windDir)} (${cardOf(current.windDir)}) · ${fmt1(current.windSpeed)} m/s · finale au ${hdg(finalHeading())} · prépo ${current.side === 'D' ? 'à droite' : 'à gauche'} : ${Math.round(f.cur.d)} m en profondeur, ${Math.round(f.cur.s)} m de déport, ${Math.round(f.cur.h)} m de hauteur`;
}

// ---------- Interface ----------
// Élément absent (ex. page en cache d'une version plus ancienne) : on renvoie un élément fantôme
// plutôt que de planter toute l'appli.
function $(id) { return document.getElementById(id) || document.createElement('div'); }
function setBanner(t) { const b = $('banner'); if (!t) b.classList.add('hidden'); else { b.textContent = t; b.classList.remove('hidden'); } }
let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2800); }
const numFields = PROFILE_KEYS;
function fillInputs(only) {
  const p = current.params;
  (only || numFields).forEach(k => { const el = $('p_' + k); if (el && document.activeElement !== el) el.value = p[k] == null ? '' : String(p[k]).replace('.', ','); });
  if (only) return;
  syncQuick(); syncWind();
  $('zoneName').textContent = current.name + (current.id ? '' : ' (non enregistrée)');
}
numFields.forEach(k => {
  $('p_' + k).addEventListener('input', e => {
    const v = parseFloat(String(e.target.value).trim().replace(',', '.'));
    if (isNaN(v)) return;
    current.params[k] = v; profile[k] = v; store.set('vl.profile', profile); // réglage de manœuvre : toutes les zones suivent
    zones.forEach(applyProfile); store.set('vl.zones', zones);
    persist(); redraw();
  });
  $('p_' + k).addEventListener('blur', () => fillInputs([k]));
});

// ---------- Bascules rapides sur la carte ----------
function syncQuick() {
  const sh = current.show;
  $('qSide').textContent = current.side === 'D' ? 'Prépo D ▶' : '◀ Prépo G';
  [['qSector', 'sector'], ['qPrepo', 'prepo'], ['qPath', 'path'], ['qReperes', 'reperes']].forEach(([id, k]) => $(id).classList.toggle('on', !!sh[k]));
  $('qTicks').classList.toggle('on', current.params.ticks !== false);
  $('qWind').innerHTML = hasWind() ? `🌬 ${hdg(current.windDir)}<br>${fmt1(current.windSpeed)} m/s` : '🌬 vent';
  $('qWind').classList.toggle('warn', !hasWind());
}
function quick(fn, msg) { fn(); syncQuick(); persist(); redraw(); if (msg) toast(msg()); }
$('qSide').addEventListener('click', () => quick(() => { current.side = current.side === 'D' ? 'G' : 'D'; }, () => `Prépo à ${current.side === 'D' ? 'droite' : 'gauche'} (face à la cible, face au vent)`));
const SHOW_NAMES = { sector: 'Secteur de finale', prepo: 'Prépo', path: 'Chemin des prépos 0 → vent max', reperes: 'Repères' };
[['qSector', 'sector'], ['qPrepo', 'prepo'], ['qPath', 'path'], ['qReperes', 'reperes']].forEach(([id, k]) =>
  $(id).addEventListener('click', () => quick(() => { current.show[k] = !current.show[k]; }, () => `${SHOW_NAMES[k]} ${current.show[k] ? 'affiché' : 'masqué'}`)));
$('qTicks').addEventListener('click', () => quick(() => { current.params.ticks = current.params.ticks === false; }, () => current.params.ticks ? 'Graduations affichées' : 'Graduations masquées'));

// ---------- Vent du jour : direction (d'où il vient) et force, réglables sur la carte ----------
function syncWind() {
  if (document.activeElement !== $('w_dir')) $('w_dir').value = hasWind() ? Math.round(current.windDir) : '';
  if (document.activeElement !== $('w_spd')) $('w_spd').value = fmt1(current.windSpeed || 0);
  $('windInfo').textContent = hasWind() ? `Finale au ${hdg(finalHeading())} (${cardOf(finalHeading())}), face au vent` : 'Indique d\'où vient le vent (en degrés).';
}
function openWind() { $('windBox').classList.remove('hidden'); syncWind(); }
function setWind(dir, spd) {
  if (dir !== undefined && !isNaN(dir)) current.windDir = ((Math.round(dir) % 360) + 360) % 360;
  if (spd !== undefined && !isNaN(spd)) current.windSpeed = Math.max(0, Math.round(spd * 10) / 10);
  persist(); syncWind(); redraw();
}
$('qWind').addEventListener('click', () => $('windBox').classList.contains('hidden') ? openWind() : $('windBox').classList.add('hidden'));
$('windOk').addEventListener('click', () => { $('windBox').classList.add('hidden'); if (hasTarget() && hasWind()) fitFigure(); });
document.querySelectorAll('[data-wdir]').forEach(b => b.addEventListener('click', () => setWind((hasWind() ? current.windDir : 0) + +b.dataset.wdir)));
document.querySelectorAll('[data-wspd]').forEach(b => b.addEventListener('click', () => setWind(undefined, (current.windSpeed || 0) + +b.dataset.wspd)));
const numIn = el => parseFloat(String(el.value).replace(',', '.'));
$('w_dir').addEventListener('change', e => setWind(numIn(e.target)));
$('w_spd').addEventListener('change', e => setWind(undefined, numIn(e.target)));
['w_dir', 'w_spd'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); }));

// ---------- Placement : cible et repères, en touchant la carte ou à ma position GPS ----------
function syncPlaceBtn() {
  $('btnPlaceT').classList.toggle('on', placing === 'T');
  $('btnPlaceR').classList.toggle('on', placing === 'R');
}
function placeBanner() { setBanner(!placing ? null : placing === 'T' ? 'Touche la carte pour placer la cible.' : 'Touche la carte pour placer le repère.'); }
['T', 'R'].forEach(k => $('btnPlace' + k).addEventListener('click', () => {
  if (placing === k) { placing = null; placeBanner(); syncPlaceBtn(); return; } // 2e appui : annule
  if (k === 'R' && !hasTarget()) return toast('Place d\'abord la cible');
  stopMeasure(); placing = k; syncPlaceBtn(); placeBanner(); closeSheet();
}));
function gpsHere(btn, then) {
  if (!navigator.geolocation) return toast('Géolocalisation indisponible');
  const old = btn.textContent; btn.textContent = '📡 Position…'; btn.disabled = true;
  navigator.geolocation.getCurrentPosition(pos => {
    btn.textContent = old; btn.disabled = false;
    const acc = Math.round(pos.coords.accuracy || 0);
    then({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    if (acc) setTimeout(() => toast(`Position prise (précision GPS ± ${acc} m)`), 2900);
  }, () => { btn.textContent = old; btn.disabled = false; toast('Position refusée ou indisponible'); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}
$('btnGpsT').addEventListener('click', () => gpsHere($('btnGpsT'), p => { closeSheet(); map.setView(LL(p), Math.max(map.getZoom(), 17)); setTarget(p); }));
$('btnGpsR').addEventListener('click', () => { if (!hasTarget()) return toast('Place d\'abord la cible'); gpsHere($('btnGpsR'), p => { closeSheet(); addRepere(p); }); });

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
  const a = meas.a, b = meas.b, d = map.distance(LL(a), LL(b)), c = capDeg(a, b), mid = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
  const txt = `${hdg(c)} · ${fmtDist(d)}`;
  if (!meas.line) {
    meas.halo = L.polyline([LL(a), LL(b)], { color: '#000', weight: 5, opacity: .5, interactive: false }).addTo(measLayer);
    meas.line = L.polyline([LL(a), LL(b)], { color: '#00e5ff', weight: 3, dashArray: '8 6', interactive: false }).addTo(measLayer);
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
  const p = { lat: e.latlng.lat, lng: e.latlng.lng }, k = placing;
  placing = null; placeBanner(); syncPlaceBtn();
  if (k === 'T') setTarget(p); else addRepere(p);
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
let lastTab = 'reglages';
function openSheet(tab) {
  lastTab = tab;
  $('sheet').classList.remove('hidden'); setSheetSize(sheetSize);
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['reglages', 'pilote'].forEach(t => $('tab-' + t).classList.toggle('hidden', t !== tab));
  if (tab === 'reglages') renderZones();
}
function closeSheet() { $('sheet').classList.add('hidden'); }
// Les deux boutons en haut à gauche ouvrent leur onglet ; second appui sur le même = fermer
function toggleTab(t) { if (!$('sheet').classList.contains('hidden') && lastTab === t) closeSheet(); else openSheet(t); }
$('btnManeuver').addEventListener('click', () => toggleTab('pilote'));
$('btnZones').addEventListener('click', () => toggleTab('reglages'));
$('btnClose').addEventListener('click', closeSheet);
document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => openSheet(b.dataset.tab)));


// Petite fenêtre : texte, champ facultatif, et un 3e bouton facultatif (renvoie 'DELETE')
function ask(text, def, delLabel) {
  return new Promise(res => {
    $('dlgText').textContent = text; $('dlgInput').value = def || ''; $('dialog').classList.remove('hidden');
    $('dlgInput').classList.toggle('hidden', def === undefined);
    $('dlgDel').classList.toggle('hidden', !delLabel); $('dlgDel').textContent = delLabel || '';
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
    } else if (z.target) {
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
  closeSheet(); fillInputs(); redraw(); if (hasTarget()) fitFigure(); persist();
}
// Nouvelle zone : on choisit d'abord où aller (rester ici, ma position ou recherche), puis on place la cible
async function startNewZone(center, zoom) {
  $('nzDlg').classList.add('hidden');
  const n = await ask('Nom de la nouvelle zone (ex. Bouloc) :', ''); if (!n) return;
  current = newZone(center); applyProfile(current); current.zoom = zoom || 17;
  current.name = n; current.id = 'z' + Date.now(); current.updated = Date.now();
  zones.push(clone(current)); store.set('vl.zones', zones);
  resetMarkers(); stopMeasure();
  map.setView([center.lat, center.lng], current.zoom);
  placing = 'T'; fillInputs(); persist(); redraw(); closeSheet();
  toast(`« ${n} » créée : touche la carte pour placer la cible`);
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
  ul.innerHTML = '<li class="mut">Recherche…</li>';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=8&accept-language=fr&q=' + encodeURIComponent(q));
    const js = await r.json(); ul.innerHTML = '';
    if (!js.length) ul.innerHTML = '<li class="mut">Rien trouvé.</li>';
    js.forEach(x => {
      const li = document.createElement('li'); const b = document.createElement('button');
      b.className = 'res'; b.textContent = x.display_name;
      b.onclick = () => startNewZone({ lat: +x.lat, lng: +x.lon }, 16);
      li.append(b); ul.append(li);
    });
  } catch (e) { ul.innerHTML = '<li class="mut">Recherche impossible (pas de réseau ?). Tu peux taper des coordonnées.</li>'; }
}
$('btnSearch').addEventListener('click', doSearch);
$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// ---------- Position ----------
function locate(center) {
  if (!navigator.geolocation) { toast('Géolocalisation indisponible'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (posMarker) posMarker.setLatLng(ll);
    else posMarker = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#2f80ff', fillOpacity: 1 }).addTo(map);
    if (center) map.setView(ll, Math.max(map.getZoom(), 17));
  }, () => { if (center) toast('Position refusée ou indisponible'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}
$('btnLocate').addEventListener('click', () => locate(true));

// Boussole : nord en haut. Bouton « Axe » : branche d'approche vers le haut (sens de vol vers le setup) ;
// si les deux branches ont des caps différents, chaque appui passe à l'autre.
// leaflet-rotate : setBearing(b) tourne la carte de +b, donc le cap h est en haut avec b = -h.
const normB = x => ((x % 360) + 360) % 360, diffB = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
function setMapBearing(b, msg) { map.setBearing(b); current.bearing = b; syncCompass(); persist(); if (msg) toast(msg); }
$('btnNorth').addEventListener('click', () => setMapBearing(0, 'Nord en haut'));

// Bouton « Axe » : axe de finale vers le haut (cap de finale = direction d'où vient le vent)
$('btnAxisUp').addEventListener('click', () => {
  if (!hasWind()) return toast('Règle d\'abord le vent du jour (🌬)');
  setMapBearing(normB(-finalHeading()), `Axe de finale (${hdg(finalHeading())}) vers le haut`);
});
$('btnFit').addEventListener('click', () => { if (hasTarget()) fitFigure(); else toast('Place d\'abord la cible'); });

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
// Photos gardées hors-ligne pour une zone : autour de la cible (700 m en détail, 2,5 km en large)
function offlineTiles(z, src) {
  const center = z.target || z.center;
  return [...new Set(tilesAround(center, 700, 12, 19, src).concat(tilesAround(center, 2500, 12, 16, src)))];
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
  const z = id === current.id ? current : zones.find(x => x.id === id); if (!z || !z.target) return;
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

// Cap (°) placé en haut de la page : le sens de vol sur la branche d'approche, vers le setup
// (on « monte » vers le setup puis l'axe de poser). 1re configuration affichée.

// Le haut de la page = l'axe de finale (sens de vol face au vent, vers la cible)
function pdfUpBearing() { return finalHeading(); }

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
  const fg = figure(), sh = current.show;
  if (fg) {
    if (current.params.ticks !== false) { // graduations autour de la cible
      const c = toC(current.target), Rr = Math.max(25, fg.R * 0.45) * pxPerM(current.target);
      g.save(); g.strokeStyle = '#fff'; g.globalAlpha = .8; g.lineWidth = 1.4 * u; g.setLineDash([4 * u, 6 * u]);
      g.beginPath(); g.arc(c.x, c.y, Rr, 0, 2 * Math.PI); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      Geo.degTicks(Rr / u, 40).forEach(deg => {
        const a = pageAngle(deg), l = 11 * u;
        g.beginPath(); g.moveTo(c.x + Rr * Math.sin(a), c.y - Rr * Math.cos(a)); g.lineTo(c.x + (Rr - l) * Math.sin(a), c.y - (Rr - l) * Math.cos(a)); g.stroke();
        shadowText(`${deg}°`, c.x + (Rr + 16 * u) * Math.sin(a), c.y - (Rr + 16 * u) * Math.cos(a), '#fff', 11, 'center');
      });
      g.restore();
    }
    if (sh.sector) {
      g.save(); g.beginPath(); const T = toC(current.target); g.moveTo(T.x, T.y);
      fg.arc.forEach(ll => { const q = toC(ll); g.lineTo(q.x, q.y); }); g.closePath();
      g.fillStyle = C_SECTOR; g.globalAlpha = .18; g.fill(); g.globalAlpha = 1; g.strokeStyle = C_SECTOR; g.lineWidth = 2.4 * u; g.stroke(); g.restore();
    }
    if (sh.path && sh.prepo) {
      g.save(); g.beginPath(); fg.path.forEach((q, i) => { const c = toC(q.ll); i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y); });
      g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 5 * u; g.stroke(); g.strokeStyle = C_PATH; g.lineWidth = 2.6 * u; g.stroke(); g.restore();
      fg.path.forEach(q => { const c = dot(q.ll, C_PATH, 3.2); shadowText(`${q.wind}`, c.x + 8 * u, c.y - 8 * u, C_PATH, 11); });
    }
    if (sh.prepo) {
      if (fg.zoneR > 0) {
        const c = toC(fg.cur.ll); g.save(); g.strokeStyle = C_PREPO; g.lineWidth = 2.2 * u; g.setLineDash([6 * u, 6 * u]);
        g.beginPath(); g.arc(c.x, c.y, fg.zoneR * pxPerM(fg.cur.ll), 0, 2 * Math.PI); g.stroke(); g.restore();
      }
      const c = dot(fg.cur.ll, C_PREPO, 8.5);
      shadowText(`${Math.round(fg.cur.h)} m`, c.x + 14 * u, c.y, C_PREPO, 15);
    }
  }
  // Cible
  { const c = toC(current.target); g.save();
    [[11, '#fff'], [8, C_TARGET], [4.5, '#fff'], [2, C_TARGET]].forEach(([r, col]) => { g.beginPath(); g.arc(c.x, c.y, r * u, 0, 2 * Math.PI); g.fillStyle = col; g.fill(); });
    g.lineWidth = 1.2 * u; g.strokeStyle = '#111'; g.beginPath(); g.arc(c.x, c.y, 11 * u, 0, 2 * Math.PI); g.stroke(); g.restore(); }
  // Repères : point + distance à la cible
  if (sh.reperes) current.reperes.forEach(r => {
    const c = toC(r); g.save(); g.translate(c.x, c.y); g.rotate(Math.PI / 4);
    g.fillStyle = C_REP; g.strokeStyle = '#111'; g.lineWidth = 1.4 * u; g.fillRect(-5 * u, -5 * u, 10 * u, 10 * u); g.strokeRect(-5 * u, -5 * u, 10 * u, 10 * u); g.restore();
    shadowText(`${r.name ? r.name + ' · ' : ''}${Math.round(repDist(r))} m`, c.x + 12 * u, c.y, C_REP, 13);
  });

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
  const mppC = 1 / pxPerM(current.target);
  const target = W * 0.18 * mppC, nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].reduce((a, b) => (b <= target ? b : a), 5);
  const barW = nice / mppC, sx = 30 * u, sy = by - 28 * u;
  g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(sx - 10 * u, sy - 16 * u, barW + 90 * u, 32 * u);
  g.fillStyle = '#fff'; g.fillRect(sx, sy - 4 * u, barW, 8 * u); g.fillStyle = '#111'; g.fillRect(sx + barW / 2, sy - 3 * u, barW / 2 - 1 * u, 6 * u); g.restore();
  tx(`${nice} m`, sx + barW + 10 * u, sy, '#fff', 12, true);

  // ---- Bandeau d'informations ----
  g.save(); g.fillStyle = 'rgba(12,12,12,.82)'; g.fillRect(0, by, W, band); g.restore();
  const p = current.params, r0 = Math.round;
  const col1 = 30 * u, col2 = W * 0.5, l0 = by + lh * 1.1;
  tx(`${current.name}`, col1, l0, '#fff', fs * 1.3, true);
  tx(`${new Date().toLocaleDateString('fr-FR')} · secteur de finale ${p.sector}°`, col1, l0 + lh * 1.2, '#bbb');
  if (fg) {
    tx(`Vent du ${hdg(current.windDir)} (${cardOf(current.windDir)}) · ${fmt1(current.windSpeed)} m/s · finale au ${hdg(finalHeading())}`, col1, l0 + lh * 2.4, C_SECTOR, fs, true);
    tx(`Prépo ${current.side === 'D' ? 'à droite' : 'à gauche'} : ${r0(fg.cur.d)} m prof. · ${r0(fg.cur.s)} m déport · ${r0(fg.cur.h)} m haut.`, col1, l0 + lh * 3.4, C_PREPO, fs, true);
  }
  [
    `Prépo vent nul : ${p.d0} m prof. · ${p.s0} m déport · ${p.h0} m haut.`,
    `Prépo vent max (${p.vmax} m/s) : ${p.dM} m prof. · ${p.sM} m déport · ${p.hM} m haut.`,
    (+p.zoneFrac > 0) ? `Zone de prépo : largeur du secteur à ${fmt1(+p.zoneFrac)} de la longueur` : 'Prépo : point',
    `Chemin jaune : prépos de 0 à ${p.vmax} m/s (chiffres = vent en m/s)`
  ].forEach((s2, i) => tx(s2, col2, l0 + i * lh, '#eee'));
  tx(`${BASEMAPS[basemap].attr} · vecteur-largage v${VERSION}`, W - 20 * u, H - 10 * u, '#888', 8, false, 'right');

  return { canvas: cv, landscape, fails };
}

let pdfFile = null;
$('btnPdf').addEventListener('click', async () => {
  if (!hasTarget() || !hasWind()) return toast('Place d\'abord la cible et règle le vent');
  const b = $('btnPdf'); b.disabled = true; const old = b.textContent; b.textContent = 'Préparation du PDF…';
  try {
    await loadJsPdf();
    const { canvas, landscape, fails } = await renderPdfCanvas();
    const doc = new window.jspdf.jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    const wmm = landscape ? 297 : 210, hmm = landscape ? 210 : 297;
    doc.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, wmm, hmm);
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
// Exporter : fichier .json (zones + manœuvre) proposé à la feuille de partage (Fichiers, AirDrop, mail…).
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
// Tout effacer (zones, manœuvre, zone en cours) — les photos gardées hors-ligne restent.
$('btnWipe').addEventListener('click', async () => {
  if (!(await ask('Effacer TOUTES les données (zones enregistrées, manœuvre, zone en cours) ? C\'est définitif. Pense à exporter avant si besoin.'))) return;
  ['vl.zones', 'vl.current', 'vl.profile', 'vl.lastParams'].forEach(k => { try { localStorage.removeItem(k); } catch (er) {} });
  if ((typeof Photo !== 'undefined')) await Photo.clearAll();
  location.reload();
});

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- Démarrage ----------
$('ver').textContent = VERSION;
syncCompass();
fillInputs();
if (hasTarget()) fitFigure();
redraw();
if (!current.target && !current.id && current.zoom < 10) locate(true); else locate(false);
// Mise à jour automatique : vérifie une nouvelle version à chaque retour sur l'appli et recharge dès qu'elle est installée
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').then(reg => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
