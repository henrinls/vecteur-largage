'use strict';
// Aperçu d'un PDF dans l'appli (21 nov. 2026, demande d'Henri) — identique dans Setup PSV, prepo-PA, vecteur-largage et trace-isv.
// pdf.js (Mozilla, vendor/pdfjs, chargé seulement au premier aperçu, gardé hors-ligne par le service worker) dessine chaque
// page dans une image : marche aussi sur iPhone, où un PDF dans un cadre n'affiche que la première page.
(function (root) {
  let lib = null, box = null, zoom = 1, cur = null;
  const load = () => lib || (lib = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/pdfjs/pdf.min.js';
    s.onload = () => { const L = root.pdfjsLib; if (!L) return rej(new Error('pdf.js')); L.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'; res(L); };
    s.onerror = () => { lib = null; rej(new Error('pdf.js')); }; document.head.append(s);
  }));
  function css() {
    const st = document.createElement('style');
    st.textContent = '#pdfView{position:fixed;inset:0;z-index:5000;background:#111;display:flex;flex-direction:column}' +
      '#pdfView .pvbar{display:flex;gap:8px;align-items:center;padding:calc(10px + env(safe-area-inset-top)) 10px 8px;background:#1b1b1b;border-bottom:1px solid #333}' +
      '#pdfView .pvbar b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ddd;font-size:13px}' +
      '#pdfView .pvbar button{height:38px;min-width:44px;padding:0 10px;border-radius:10px;background:#2a2a2a;border:1px solid #555;color:#fff;font-weight:700}' +
      '#pdfView .pvpages{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:10px 0 calc(20px + env(safe-area-inset-bottom))}' +
      '#pdfView canvas{display:block;margin:0 auto 12px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.6)}' +
      '#pdfView .pvmsg{color:#bbb;text-align:center;padding:40px 20px}';
    document.head.append(st);
  }
  function build() {
    css(); box = document.createElement('div'); box.id = 'pdfView';
    box.innerHTML = '<div class="pvbar"><button data-a="close">✕ Fermer</button><b></b><button data-a="out">－</button><button data-a="in">＋</button></div><div class="pvpages"></div>';
    box.addEventListener('click', e => { const a = e.target.closest('button') && e.target.closest('button').dataset.a; if (a === 'close') hide(); if (a === 'in') setZoom(zoom * 1.5); if (a === 'out') setZoom(zoom / 1.5); });
    document.body.append(box);
  }
  function setZoom(z) {
    const pg = box.querySelector('.pvpages'), fx = (pg.scrollLeft + pg.clientWidth / 2) / Math.max(1, pg.scrollWidth), fy = (pg.scrollTop + pg.clientHeight / 2) / Math.max(1, pg.scrollHeight);
    zoom = Math.max(1, Math.min(4, z)); pg.querySelectorAll('canvas').forEach(c => { c.style.width = (c._w * zoom) + 'px'; c.style.height = (c._h * zoom) + 'px'; });
    pg.scrollLeft = fx * pg.scrollWidth - pg.clientWidth / 2; pg.scrollTop = fy * pg.scrollHeight - pg.clientHeight / 2;
  }
  function hide() { if (box) box.remove(); box = null; if (cur) { try { cur.destroy(); } catch (e) {} cur = null; } }
  async function show(file) {
    hide(); build(); zoom = 1; box.querySelector('b').textContent = file.name || 'PDF';
    const pg = box.querySelector('.pvpages'); pg.innerHTML = '<p class="pvmsg">Préparation de l\'aperçu…</p>';
    try {
      const L = await load(), doc = await L.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; cur = doc;
      if (!box) return; pg.innerHTML = '';
      const W = Math.min(pg.clientWidth - 16, 900), dpr = Math.min(3, window.devicePixelRatio || 1);
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i), v0 = page.getViewport({ scale: 1 }), s = W / v0.width, v = page.getViewport({ scale: s * dpr * 2 });
        const c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height);
        c._w = W; c._h = W * v0.height / v0.width; c.style.width = c._w + 'px'; c.style.height = c._h + 'px';
        if (!box) return; pg.append(c);
        await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
      }
    } catch (e) { if (box) pg.innerHTML = '<p class="pvmsg">Aperçu impossible sur cet appareil. Utilise « Partager / Enregistrer ».</p>'; }
  }
  root.PdfView = { show, hide };
})(typeof window !== 'undefined' ? window : globalThis);
