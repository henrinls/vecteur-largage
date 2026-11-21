'use strict';
// Tableau des vents : vents en un point choisi sur la carte (21 nov. 2026, demande d'Henri).
// Fichier identique dans Setup PSV, prepo-PA, vecteur-largage et trace-isv. Information seulement : la carte et les calculs
// ne changent pas. Par défaut (à chaque ouverture par le bouton 🌬), le tableau reste au point habituel de l'appli.
// opts : { map, open(), close(), isOpen(), onPick(p | null), restoreBanner() }
(function (root) {
  const $ = id => document.getElementById(id);
  let o = null, active = false, pt = null, mk = null;
  function marker() {
    if (!o) return;
    const show = !!pt && o.isOpen();
    if (show) {
      if (!mk) mk = L.circleMarker([pt.lat, pt.lng], { radius: 7, color: '#1e90ff', weight: 3, fillColor: '#fff', fillOpacity: 1, interactive: false });
      mk.setLatLng([pt.lat, pt.lng]); if (!o.map.hasLayer(mk)) mk.addTo(o.map);
    } else if (mk && o.map.hasLayer(mk)) o.map.removeLayer(mk);
  }
  function sync() { if ($('t_unpick')) $('t_unpick').classList.toggle('hidden', !pt); marker(); }
  function stop() { active = false; $('banner').classList.add('hidden'); if (o.restoreBanner) o.restoreBanner(); }
  function start() {
    o.close(); marker(); active = true;
    const b = $('banner'); b.textContent = 'Touche la carte à l\'endroit où tu veux les vents.'; b.classList.remove('hidden');
    const c = document.createElement('button'); c.className = 'bcancel'; c.textContent = '✕'; c.title = 'Annuler'; /* 22 nov. 2026 (Henri) : croix en haut à droite */
    c.onclick = e => { e.stopPropagation(); stop(); o.open(); sync(); };
    b.classList.add('hasx'); b.append(c);
  }
  function set(p) { pt = p; o.onPick(p); sync(); }
  function init(opts) {
    o = opts;
    $('t_pick').addEventListener('click', start);
    $('t_unpick').addEventListener('click', () => set(null));
    $('t_close').addEventListener('click', () => setTimeout(marker, 0));
    sync();
  }
  // À appeler au début du clic sur la carte de l'appli : true = le clic a servi à choisir le point des vents
  function onMapClick(e) { if (!active) return false; stop(); set({ lat: e.latlng.lat, lng: e.latlng.lng }); o.open(); sync(); return true; }
  // À l'ouverture du tableau par le bouton 🌬 : retour au point habituel
  function reset() { if (active) stop(); if (pt) { pt = null; if (o) o.onPick(null); } sync(); }
  root.WindPick = { init, onMapClick, reset, sync, get point() { return pt; }, isActive: () => active };
})(typeof window !== 'undefined' ? window : globalThis);
