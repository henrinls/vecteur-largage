/* undo.js — boutons « Annuler la dernière action » ↶ et « Rétablir » ↷ (flèches comme dans Office), communs à Setup PSV, prepo-PA, vecteur-largage et trace-isv.
   26 nov. 2026, demande d'Henri. Principe : à chaque enregistrement (persist), l'appli donne une photo de son état (zone ouverte + réglages) ;
   si elle a changé, la photo d'avant est empilée. Le bouton remet la dernière photo empilée.
   - La vue de la carte (centre, zoom, rotation) n'est pas une action : jamais annulée.
   - Les valeurs que l'appli recalcule toute seule (altitudes, mémoires de calcul…) ne comptent pas pour décider s'il y a eu une action
     (liste IGNORE + cfg.ignore), mais elles sont gardées dans la photo.
   - Changements très rapprochés (< 400 ms) = une seule action ; juste après une annulation (0,3 s), les recalculs automatiques ne comptent pas.
   - Rétablir (↷, grisé tant que rien n'a été annulé) refait l'action annulée ; une nouvelle action vide les actions à rétablir.
   - Changer de zone vide la pile (on n'annule pas d'une zone à l'autre). 50 actions au plus.
   - Raccourcis clavier Cmd+Z / Ctrl+Z (annuler), Cmd+Maj+Z / Ctrl+Y (rétablir), sur ordinateur, hors champ de saisie. */
const Undo = (() => {
  const IGNORE = ['center', 'zoom', 'bearing', 'updated', 'elevAuto'], MAX = 50, GROUP = 400, AFTER = 300;
  let cfg = null, stack = [], redoStack = [], lastFull = null, lastCmp = null, lastKey = null, tRec = 0, tUndo = 0, busy = false;
  function cmpStr(obj) { const ig = new Set(IGNORE.concat(cfg.ignore || [])); return JSON.stringify(obj, (k, v) => (ig.has(k) ? undefined : v)); }
  function sync() {
    const b = document.getElementById('btnUndo'), r = document.getElementById('btnRedo');
    if (b) { b.disabled = !stack.length; b.title = stack.length ? `Annuler la dernière action (${stack.length})` : 'Rien à annuler'; }
    if (r) { r.disabled = !redoStack.length; r.title = redoStack.length ? `Rétablir l'action annulée (${redoStack.length})` : 'Rien à rétablir'; }
  }
  function record() {
    if (!cfg || busy) return;
    let st; try { st = cfg.state(); } catch (e) { return; } if (!st) return;
    const full = JSON.stringify(st.obj), cmp = cmpStr(st.obj), now = Date.now();
    if (st.key !== lastKey) { stack = []; redoStack = []; lastKey = st.key; lastFull = full; lastCmp = cmp; tRec = now; sync(); return; }
    if (cmp === lastCmp) { lastFull = full; return; } /* seulement des valeurs recalculées : on garde la photo à jour, sans action */
    const merge = (now - tRec < GROUP && stack.length) || now - tUndo < AFTER;
    if (!merge) { stack.push(lastFull); if (stack.length > MAX) stack.shift(); redoStack = []; } /* nouvelle action : plus rien à rétablir */
    lastFull = full; lastCmp = cmp; tRec = now; sync();
  }
  function apply(s, msg) {
    busy = true;
    try { cfg.restore(JSON.parse(s)); } catch (e) { console.error(e); }
    busy = false; tUndo = Date.now();
    try { const st = cfg.state(); lastKey = st.key; lastFull = JSON.stringify(st.obj); lastCmp = cmpStr(st.obj); } catch (e) {}
    sync(); if (cfg.toast) cfg.toast(msg);
  }
  function undo() {
    if (!cfg) return;
    if (!stack.length) { if (cfg.toast) cfg.toast('Rien à annuler'); return; }
    redoStack.push(lastFull); apply(stack.pop(), 'Dernière action annulée');
  }
  function redo() {
    if (!cfg) return;
    if (!redoStack.length) { if (cfg.toast) cfg.toast('Rien à rétablir'); return; }
    stack.push(lastFull); apply(redoStack.pop(), 'Action rétablie');
  }
  function init(c) {
    cfg = c; const b = document.getElementById('btnUndo'), r = document.getElementById('btnRedo');
    if (b) b.addEventListener('click', e => { e.stopPropagation(); undo(); }); if (r) r.addEventListener('click', e => { e.stopPropagation(); redo(); });
    document.addEventListener('keydown', e => {
      const k = (e.key || '').toLowerCase(); if (!(e.metaKey || e.ctrlKey) || e.altKey || (k !== 'z' && k !== 'y')) return;
      const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault(); if (k === 'y' || e.shiftKey) redo(); else undo();
    });
    record();
  }
  const ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 14 4 9l5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_REDO = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" style="transform:scaleX(-1)"><path d="M9 14 4 9l5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return { init, record, undo, redo, ICON, ICON_REDO, size: () => stack.length, redoSize: () => redoStack.length };
})();
