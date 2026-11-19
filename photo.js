'use strict';
// Photo aérienne importée (prise à la verticale) calée sur la carte par 2 points — commun à Setup PSV et prepo-PA.
// L'image est gardée dans le téléphone (IndexedDB), le calage dans la zone (current.photo).
const Photo = (() => {
  const DB = APP_ID + '-photos';
  let db = null, shownId = null, shownKey = null, img = null, bitmap = null, cal = null, calImg = null, calUrl = null;
  const idb = () => db || (db = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('img');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('img', mode); const q = fn(t.objectStore('img')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  const getBlob = id => tx('readonly', s => s.get(id));
  const putBlob = (id, b) => tx('readwrite', s => s.put(b, id));
  const delBlob = id => tx('readwrite', s => s.delete(id));

  // Pane dans le plan qui tourne avec la carte, entre les photos satellite et le tracé
  const pane = map.createPane('photoPane', map.getPane('rotatePane') || undefined);
  pane.style.zIndex = 300; pane.style.pointerEvents = 'none';

  // Calage : (u, v) pixels de la photo → lat/lng, à partir de 2 points (similitude : échelle + rotation)
  function project(ph) {
    const m = Geo.toLocal(ph.ll1, ph.ll2), i = { x: ph.u2 - ph.u1, y: -(ph.v2 - ph.v1) };
    const s = Math.hypot(m.x, m.y) / (Math.hypot(i.x, i.y) || 1), th = Math.atan2(m.y, m.x) - Math.atan2(i.y, i.x);
    const c = Math.cos(th) * s, sn = Math.sin(th) * s;
    return (u, v) => { const x = u - ph.u1, y = -(v - ph.v1); return Geo.fromLocal(ph.ll1, { x: x * c - y * sn, y: x * sn + y * c }); };
  }
  function corners(ph) { const p = project(ph); return [p(0, 0), p(ph.w, 0), p(0, ph.h), p(ph.w, ph.h)]; }
  const ready = ph => ph && ph.ll1 && ph.ll2 && ph.w;

  function position() {
    const ph = current.photo;
    if (!img || !ready(ph)) return;
    const [a, b, c] = corners(ph).map(ll => map.latLngToLayerPoint([ll.lat, ll.lng]));
    img.style.width = ph.w + 'px'; img.style.height = ph.h + 'px';
    img.style.transform = `matrix(${(b.x - a.x) / ph.w},${(b.y - a.y) / ph.w},${(c.x - a.x) / ph.h},${(c.y - a.y) / ph.h},${a.x},${a.y})`;
    img.style.opacity = ph.opacity == null ? 0.85 : ph.opacity;
  }
  map.on('zoomstart', () => { if (img) img.style.visibility = 'hidden'; });
  map.on('zoomend viewreset rotate moveend resize', () => { if (img) { position(); img.style.visibility = ''; } });

  // Appelé à chaque dessin : affiche la photo de la zone ouverte
  async function sync() {
    const ph = current.photo, want = current.id && ready(ph) && ph.show !== false ? current.id : null;
    const key = want && (want + ':' + (ph.ver || 0));
    if (key === shownKey) { position(); syncUi(); return; }
    shownKey = key; shownId = want;
    if (img) { URL.revokeObjectURL(img.src); img.remove(); img = null; }
    bitmap = null; syncUi();
    if (!want) return;
    const blob = await getBlob(want).catch(() => null);
    if (!blob || shownKey !== key) return;
    img = document.createElement('img'); img.className = 'photoLayer'; img.src = URL.createObjectURL(blob);
    pane.appendChild(img); position();
  }
  function syncUi() {
    const ph = current.photo, has = !!(current.id && ready(ph));
    $('photoCtl').classList.toggle('hidden', !has);
    $('btnPhoto').textContent = has ? '📷 Remplacer la photo' : '📷 Importer une photo';
    if (has) { $('photoShow').classList.toggle('on', ph.show !== false); $('photoShow').textContent = ph.show !== false ? '👁 Photo affichée' : '👁 Photo masquée'; $('photoOpacity').value = Math.round((ph.opacity == null ? 0.85 : ph.opacity) * 100); }
  }

  // ---- Import + calage en 4 appuis : photo P1 → carte P1 → photo P2 → carte P2 ----
  async function importFile(file) {
    if (!current.id) return toast('Crée ou ouvre d\'abord une zone');
    try {
      const bm = await createImageBitmap(file);
      const k = Math.min(1, 2400 / Math.max(bm.width, bm.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bm.width * k); cv.height = Math.round(bm.height * k);
      cv.getContext('2d').drawImage(bm, 0, 0, cv.width, cv.height);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
      cal = { id: current.id, blob, w: cv.width, h: cv.height, step: 1, pts: {} };
      startCal();
    } catch (e) { toast('Image illisible'); }
  }
  function startCal() { closeSheet(); stopMeasure(); showCalImg(); }
  function showCalImg() {
    const n = cal.step === 1 ? 1 : 2;
    $('calText').innerHTML = `<b>Point ${n} / 2 sur la photo</b> : touche un détail bien net et facile à retrouver sur la carte (angle de bâtiment, croisement, coin de piste…)${n === 2 ? ', <b>loin du premier</b>' : ''}.`;
    if (!calUrl) calUrl = URL.createObjectURL(cal.blob);
    $('calImg').src = calUrl; $('calBox').classList.remove('hidden'); drawCalMarks();
  }
  function drawCalMarks() {
    const box = $('calWrap'), im = $('calImg');
    box.querySelectorAll('.calmark').forEach(e => e.remove());
    [1, 2].forEach(n => { const p = cal.pts['i' + n]; if (!p) return;
      const m = document.createElement('span'); m.className = 'calmark'; m.textContent = n;
      m.style.left = (p.u / cal.w * im.clientWidth) + 'px'; m.style.top = (p.v / cal.h * im.clientHeight) + 'px'; box.appendChild(m); });
  }
  function calZoom(f) { const im = $('calImg'); const z = Math.max(1, Math.min(8, (+im.dataset.z || 1) * f)); im.dataset.z = z; im.style.width = (z * 100) + '%'; setTimeout(drawCalMarks, 30); }
  function onImgTap(e) {
    if (!cal || (cal.step !== 1 && cal.step !== 3)) return;
    const im = $('calImg'), r = im.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width * cal.w, v = (e.clientY - r.top) / r.height * cal.h;
    const n = cal.step === 1 ? 1 : 2; cal.pts['i' + n] = { u, v }; drawCalMarks();
    setTimeout(() => { $('calBox').classList.add('hidden'); cal.step++; setBanner(`Touche maintenant le point ${n} sur la carte (le même endroit que sur la photo).`); }, 250);
  }
  function onMapClick(e) {
    if (!cal || (cal.step !== 2 && cal.step !== 4)) return false;
    const n = cal.step === 2 ? 1 : 2; cal.pts['m' + n] = { lat: e.latlng.lat, lng: e.latlng.lng };
    setBanner(null);
    if (cal.step === 2) { cal.step = 3; showCalImg(); return true; }
    finishCal(); return true;
  }
  async function finishCal() {
    const P = cal.pts, dMap = map.distance([P.m1.lat, P.m1.lng], [P.m2.lat, P.m2.lng]);
    if (dMap < 15) { toast('Les deux points sont trop proches : recommence avec deux points plus éloignés'); cancelCal(); return; }
    await putBlob(cal.id, cal.blob);
    const old = current.photo || {};
    current.photo = { w: cal.w, h: cal.h, u1: P.i1.u, v1: P.i1.v, ll1: P.m1, u2: P.i2.u, v2: P.i2.v, ll2: P.m2,
      opacity: old.opacity == null ? 0.85 : old.opacity, show: true, ver: (old.ver || 0) + 1 };
    cancelCal(true); persist(); redraw();
    const c = corners(current.photo); map.fitBounds(L.latLngBounds(c.map(ll => [ll.lat, ll.lng])), { padding: [20, 20] });
    toast('Photo calée. Vérifie la superposition (transparence dans l\'onglet Zones) ; sinon « Recaler ».');
  }
  function cancelCal(keep) {
    $('calBox').classList.add('hidden'); setBanner(null);
    if (calUrl) { URL.revokeObjectURL(calUrl); calUrl = null; }
    if (!keep && cal) toast('Calage annulé');
    cal = null; $('calImg').dataset.z = 1; $('calImg').style.width = '100%';
  }
  async function recal() {
    if (!current.id || !ready(current.photo)) return;
    const blob = await getBlob(current.id).catch(() => null); if (!blob) return toast('Photo introuvable sur ce téléphone');
    cal = { id: current.id, blob, w: current.photo.w, h: current.photo.h, step: 1, pts: {} }; startCal();
  }
  async function removePhoto() {
    if (!current.id || !current.photo) return;
    if (!(await ask('Supprimer la photo aérienne de cette zone ?'))) return;
    await delBlob(current.id).catch(() => {}); current.photo = null; persist(); redraw(); sync();
  }
  async function clearAll() { try { const d = await idb(); d.close(); } catch (e) {} db = null; try { indexedDB.deleteDatabase(DB); } catch (e) {} }

  // ---- PDF : la photo est dessinée sous le tracé, avec sa transparence ----
  async function drawPdf(g, toC) {
    const ph = current.photo; if (!current.id || !ready(ph) || ph.show === false) return;
    const blob = await getBlob(current.id).catch(() => null); if (!blob) return;
    const bm = await createImageBitmap(blob);
    const [a, b, c] = corners(ph).map(toC);
    g.save(); g.globalAlpha = ph.opacity == null ? 0.85 : ph.opacity;
    g.transform((b.x - a.x) / ph.w, (b.y - a.y) / ph.w, (c.x - a.x) / ph.h, (c.y - a.y) / ph.h, a.x, a.y);
    g.drawImage(bm, 0, 0); g.restore();
  }

  // ---- Boutons de l'onglet Zones ----
  $('btnPhoto').addEventListener('click', () => { $('photoFile').value = ''; $('photoFile').click(); });
  $('photoFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) importFile(f); });
  $('photoShow').addEventListener('click', () => { if (!current.photo) return; current.photo.show = current.photo.show === false; persist(); sync(); });
  $('photoOpacity').addEventListener('input', e => { if (!current.photo) return; current.photo.opacity = (+e.target.value) / 100; position(); persist(); });
  $('photoRecal').addEventListener('click', recal);
  $('photoDel').addEventListener('click', removePhoto);
  $('calImg').addEventListener('click', onImgTap);
  $('calCancel').addEventListener('click', () => cancelCal());
  $('calZin').addEventListener('click', () => calZoom(2));
  $('calZout').addEventListener('click', () => calZoom(0.5));
  return { sync, onMapClick, drawPdf, clearAll, remove: id => delBlob(id).catch(() => {}) };
})();
Photo.sync();
