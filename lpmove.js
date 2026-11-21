/* lpmove.js — commun aux applis carte (Setup PSV, prepo-PA, vecteur-largage, trace-isv), fichier identique dans les 4.
   21 nov. 2026 (Henri) : pour déplacer quelque chose, appui long puis glisser (comme avant), OU appui long puis relâcher sans
   bouger → petit menu « Déplacer » (et d'autres choix selon l'objet) ; « Déplacer » → on peut naviguer sur la carte, puis on
   touche l'endroit voulu. Le geste est rejoué comme un glissement du point appuyé jusqu'au point touché (onStart, onMove(appui),
   onMove(touché), onEnd), donc chaque objet se comporte exactement comme s'il avait été glissé à la main.
   Utilisé par longPressDrag (app.js) : marker._lpMenu(press) peut fournir ses propres choix. */
const LPMove = (() => {
  let pending = null, menu = null, bar = null;
  const css = document.createElement('style');
  css.textContent = `#lpMenu{position:fixed;z-index:3000;background:rgba(22,22,22,.97);border:1px solid #666;border-radius:12px;padding:6px;display:flex;flex-direction:column;gap:6px;min-width:150px;box-shadow:0 4px 16px rgba(0,0,0,.6)}
#lpMenu button{background:#2c2c2c;color:#fff;border:1px solid #555;border-radius:9px;padding:10px 14px;font-size:15px;font-weight:600;text-align:left}
#lpMenu button.lpc{color:#aaa;font-weight:500}
#lpBar{position:fixed;z-index:3000;left:50%;transform:translateX(-50%);top:calc(86px + env(safe-area-inset-top));background:#ffd400;color:#111;font-weight:600;padding:8px 12px;border-radius:10px;max-width:92vw;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.5)}
#lpBar button{display:inline-block;margin-left:10px;background:#111;color:#ffd400;border:1px solid #111;padding:6px 14px;font-weight:700;border-radius:9px}`;
  document.head.appendChild(css);
  function close() { if (menu) { menu.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); } }
  function outside(e) { if (menu && !menu.contains(e.target)) close(); }
  function open(x, y, items) {
    close(); if (!items || !items.length) return;
    menu = document.createElement('div'); menu.id = 'lpMenu';
    items.concat([{ label: 'Annuler', cls: 'lpc', fn: () => {} }]).forEach(it => {
      const b = document.createElement('button'); b.textContent = it.label; if (it.cls) b.className = it.cls;
      b.addEventListener('click', e => { e.stopPropagation(); close(); it.fn(); }); menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight, W = innerWidth, H = innerHeight;
    menu.style.left = Math.max(8, Math.min(W - w - 8, x - w / 2)) + 'px'; menu.style.top = Math.max(8, Math.min(H - h - 8, y - h - 24)) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }
  function cancel() { pending = null; if (bar) { bar.remove(); bar = null; } }
  function pick(text, fn) {
    cancel(); pending = fn;
    bar = document.createElement('div'); bar.id = 'lpBar'; bar.innerHTML = `<span></span><button>✕ Annuler</button>`;
    bar.querySelector('span').textContent = text || 'Touche la carte à l\'endroit voulu';
    bar.querySelector('button').addEventListener('click', e => { e.stopPropagation(); cancel(); });
    document.body.appendChild(bar);
  }
  /* Le toucher qui choisit l'endroit est pris avant la carte (phase de capture) : il ne pose rien d'autre. Un glissement de
     carte (navigation) n'est pas un choix. */
  document.addEventListener('click', e => {
    if (!pending || typeof map === 'undefined') return;
    const c = map.getContainer(); if (!c.contains(e.target) || (e.target.closest && e.target.closest('.leaflet-control'))) return;
    if (map.dragging && map.dragging.moved && map.dragging.moved()) return;
    e.stopPropagation(); e.preventDefault();
    const r = c.getBoundingClientRect(), ll = map.containerPointToLatLng([e.clientX - r.left, e.clientY - r.top]), f = pending;
    cancel(); f({ lat: ll.lat, lng: ll.lng });
  }, true);
  /* Menu par défaut d'un objet déplaçable : « Déplacer » */
  function defaultItems(marker, press, onMove, onEnd, onStart) {
    return [{ label: '✥ Déplacer', fn: () => pick(null, ll => replay(marker, press, ll, onMove, onEnd, onStart)) }];
  }
  function replay(marker, press, ll, onMove, onEnd, onStart) {
    if (onStart) onStart();
    if (marker.setLatLng) marker.setLatLng(press); onMove({ lat: press.lat, lng: press.lng });
    if (marker.setLatLng) marker.setLatLng(ll); onMove({ lat: ll.lat, lng: ll.lng });
    onEnd();
  }
  return { open, close, pick, cancel, defaultItems, replay, get active() { return !!pending; } };
})();
