// showmenu.js — identique dans setup-psv, prepo-pa et vecteur-largage (25/11/2026, demande d'Henri, repris de trace-isv) :
// un seul bouton « Affichage » dans la colonne de gauche à la place des boutons d'affichage ; il ouvre la liste des interrupteurs.
// Les anciens boutons restent dans la page (masqués) : chaque interrupteur du menu les « clique », donc toute la logique de l'appli est
// inchangée, et leur classe « on » donne l'état. Un bouton que l'appli masque (classe hidden) n'apparaît pas dans le menu.
(function () {
  const $ = id => document.getElementById(id), txt = id => (($(id) && $(id).textContent) || '').replace('👁', '').trim();
  const S = (d, w) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="${w || 2}">${d}</svg>`;
  const EYE = S('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" stroke="#fff"/><circle cx="12" cy="12" r="3" stroke="#ff2020"/>');
  const DEFS = [
    { id: 'qShowA', label: () => `Porte 1 · ${txt('qShowA')}`, svg: EYE },
    { id: 'qShowB', label: () => `Porte 2 · ${txt('qShowB')}`, svg: EYE },
    { id: 'qRec', label: 'Point de snap', svg: S('<circle cx="12" cy="12" r="8" stroke="#ffd400" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="3" fill="#ffd400" stroke="#111"/>') },
    { id: 'qTicks', label: () => ($('qRelax') ? 'Rosace en degrés' : 'Graduations en degrés'), svg: S('<circle cx="12" cy="12" r="8" stroke="#fff"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="#fff"/>') },
    { id: 'qC20', label: 'Cercle des 20 m', svg: S('<circle cx="12" cy="12" r="6" stroke="#fff" stroke-width="1.2" stroke-dasharray="1.5 2.5"/><circle cx="12" cy="12" r="1.5" fill="#ff2020" stroke="none"/>') },
    { id: 'qSector', label: 'Secteur de finale', svg: S('<path d="M12 21L5 5a17 17 0 0 1 14 0z" stroke="#ff8c00"/>') },
    { id: 'qPrepo', label: 'Prépo', svg: S('<path d="M5 12h14M5 9v6M19 9v6" stroke="#ff2020" stroke-width="2.6"/>') },
    { id: 'qPath', label: 'Chemin 0 → vent max', svg: S('<path d="M4 18C8 16 10 10 20 6" stroke="#ffd400" stroke-dasharray="3 2"/>') },
    { id: 'qReperes', label: 'Repères', svg: S('<rect x="7" y="7" width="10" height="10" transform="rotate(45 12 12)" fill="#fff" stroke="#111"/>') },
    { id: 'qRelax', label: 'Zone de relaxation', svg: S('<circle cx="12" cy="12" r="8" stroke="#00e5ff" stroke-width="2.6"/>') },
    { id: 'qNm', label: 'Cercles NM', svg: S('<circle cx="12" cy="12" r="3" stroke="#fff"/><circle cx="12" cy="12" r="6" stroke="#fff" stroke-dasharray="2 2"/><circle cx="12" cy="12" r="9.5" stroke="#fff"/>') },
    { id: 'qHi', label: 'Ouverture haute des derniers', svg: S('<path d="M3 12h8" stroke="#fff" stroke-width="2.4"/><path d="M12 12h7" stroke="#fff" stroke-dasharray="2 2"/><path d="M20 8v8" stroke="#fff" stroke-width="2.4"/>') }];
  const items = DEFS.filter(d => $(d.id)); if (!items.length) return;
  const first = $(items[0].id), btn = document.createElement('button'); btn.id = 'qShowMenu'; btn.title = 'Choisir ce qui est affiché sur la carte'; btn.textContent = 'Affichage';
  const anchor = $('qRec') || first; /* Setup PSV : après les réglages des portes, à la place de « Snap » (ordre des boutons : conditions, réglages, affichages, mesure) */
  anchor.parentNode.insertBefore(btn, anchor.closest('.qpair') === anchor.parentNode ? anchor.parentNode : anchor);
  items.forEach(d => $(d.id).classList.add('smHidden'));
  const pop = document.createElement('div'); pop.id = 'showPop'; pop.className = 'hidden'; document.body.appendChild(pop);
  let open = false; const visible = d => !$(d.id).classList.contains('hidden'), lab = d => ($(d.id).dataset.sm || (typeof d.label === 'function' ? d.label() : d.label)); /* data-sm sur le bouton = libellé propre à l'appli */
  function render() {
    btn.classList.toggle('on', open); btn.classList.toggle('part', items.some(d => visible(d) && !$(d.id).classList.contains('on')));
    pop.classList.toggle('hidden', !open); if (!open) return; pop.textContent = '';
    const h = document.createElement('div'); h.className = 'sph'; h.innerHTML = '<b>Affichage</b><button class="spx" title="Fermer">✕</button>'; h.querySelector('button').addEventListener('click', e => { e.stopPropagation(); close(); }); pop.appendChild(h);
    items.filter(visible).forEach(d => { const on = $(d.id).classList.contains('on'), x = document.createElement('button'); x.className = on ? 'on' : ''; x.innerHTML = `${d.svg}<span></span>`; x.querySelector('span').textContent = lab(d); x.title = (on ? 'Masquer : ' : 'Afficher : ') + lab(d);
      x.addEventListener('click', e => { e.stopPropagation(); $(d.id).click(); setTimeout(render, 30); }); pop.appendChild(x); });
    const r = btn.getBoundingClientRect(); pop.style.maxWidth = `${Math.round(innerWidth - r.right - 12)}px`; pop.style.left = `${Math.round(r.right + 6)}px`; pop.style.top = `${Math.round(Math.max(8, Math.min(innerHeight - pop.offsetHeight - 8, r.top + r.height / 2 - pop.offsetHeight / 2)))}px`;
  }
  function close() { if (open) { open = false; render(); } }
  btn.addEventListener('click', e => { e.stopPropagation(); open = !open; render(); });
  document.addEventListener('pointerdown', e => { if (open && !pop.contains(e.target) && e.target !== btn) close(); }, true);
  const mo = new MutationObserver(() => { clearTimeout(mo.t); mo.t = setTimeout(render, 20); }); items.forEach(d => mo.observe($(d.id), { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true }));
  addEventListener('resize', () => { if (open) render(); });
  window.ShowMenu = { close, render };
  render();
})();
