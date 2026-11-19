'use strict';
// Déclinaison magnétique : modèle WMM2025 (NOAA / British Geological Survey), coefficients officiels, valable 2025-2029.
// Calcul : potentiel en harmoniques sphériques (Schmidt), repère géocentrique, à l'altitude 0.
(function (root) {
  const G = [0, -29351.8, -1410.8, -2556.6, 2951.1, 1649.3, 1361, -2404.1, 1243.8, 453.6, 895, 799.5, 55.7, -281.1, 12.1, -233.2, 368.9, 187.2, -138.7, -142, 20.9, 64.4, 63.8, 76.9, -115.7, -40.9, 14.9, -60.7, 79.5, -77, -8.8, 59.3, 15.8, 2.5, -11.1, 14.2, 23.2, 10.8, -17.5, 2, -21.7, 16.9, 15, -16.8, 0.9, 4.6, 7.8, 3, -0.2, -2.5, -13.1, 2.4, 8.6, -8.7, -12.9, -1.3, -6.4, 0.2, 2, -1, -0.6, -0.9, 1.5, 0.9, -2.7, -3.9, 2.9, -1.5, -2.5, 2.4, -0.6, -0.1, -0.6, -0.1, 1.1, -1, -0.2, 2.6, -2, -0.2, 0.3, 1.2, -1.3, 0.6, 0.6, 0.5, -0.1, -0.4, -0.2, -1.3, -0.7], H = [0, 0, 4545.4, 0, -3133.6, -815.1, 0, -56.6, 237.5, -549.5, 0, 278.6, -133.9, 212, -375.6, 0, 45.4, 220.2, -122.9, 43, 106.1, 0, -18.4, 16.8, 48.8, -59.8, 10.9, 72.7, 0, -48.9, -14.4, -1, 23.4, -7.4, -25.1, -2.3, 0, 7.1, -12.6, 11.4, -9.7, 12.7, 0.7, -5.2, 3.9, 0, -24.8, 12.2, 8.3, -3.3, -5.2, 7.2, -0.6, 0.8, 10, 0, 3.3, 0, 2.4, 5.3, -9.1, 0.4, -4.2, -3.8, 0.9, -9.1, 0, 0, 2.9, -0.6, 0.2, 0.5, -0.3, -1.2, -1.7, -2.9, -1.8, -2.3, 0, -1.3, 0.7, 1, -1.4, 0, 0.6, -0.1, 0.8, 0.1, -1, 0.1, 0.2], GD = [0, 12, 9.7, -11.6, -5.2, -8, -1.3, -4.2, 0.4, -15.6, -1.6, -2.4, -6, 5.6, -7, 0.6, 1.4, 0, 0.6, 2.2, 0.9, -0.2, -0.4, 0.9, 1.2, -0.9, 0.3, 0.9, 0, -0.1, -0.1, 0.5, -0.1, -0.8, -0.8, 0.8, -0.1, 0.2, 0, 0.5, -0.1, 0.3, 0.2, 0, 0.2, 0, -0.1, 0.1, 0.3, -0.3, 0, 0.3, -0.1, 0.1, -0.1, 0.1, 0, 0.1, 0.1, 0, -0.3, 0, -0.1, -0.1, 0, 0, 0, 0, 0, 0, 0, -0.1, 0, 0, -0.1, -0.1, -0.1, -0.1, 0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, -0.1, 0, -0.1], HD = [0, 0, -21.5, 0, -27.7, -12.1, 0, 4, -0.3, -4.1, 0, -1.1, 4.1, 1.6, -4.4, 0, -0.5, 2.2, 0.4, 1.7, 1.9, 0, 0.3, -1.6, -0.4, 0.9, 0.7, 0.9, 0, 0.6, 0.5, -0.8, 0, -1, 0.6, -0.2, 0, -0.2, 0.5, -0.4, 0.4, -0.5, -0.6, 0.3, 0.2, 0, -0.3, 0.3, -0.3, 0.3, 0.2, -0.1, -0.2, 0.4, 0.1, 0, 0, 0, -0.2, 0.1, -0.1, 0.1, 0, -0.1, 0.2, 0, 0, 0, 0.1, 0, 0.1, 0, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, -0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, -0.1], NMAX = 12, EPOCH = 2025;
  const idx = (n, m) => n * (n + 1) / 2 + m;
  const A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F), RE = 6371.2;
  function legendre(x, c) { // P[n][m](x), x = cos(colatitude), c = sin(colatitude) ; semi-normalisés de Schmidt
    const P = []; for (let n = 0; n <= NMAX; n++) P.push(new Array(n + 1).fill(0));
    P[0][0] = 1; P[1][0] = x; P[1][1] = c;
    for (let n = 2; n <= NMAX; n++) {
      P[n][n] = Math.sqrt((2 * n - 1) / (2 * n)) * c * P[n - 1][n - 1];
      for (let m = 0; m < n; m++) {
        const a = (2 * n - 1) * x * P[n - 1][m], b = n - 2 >= m ? Math.sqrt((n - 1) * (n - 1) - m * m) * P[n - 2][m] : 0;
        P[n][m] = (a - b) / Math.sqrt(n * n - m * m);
      }
    }
    return P;
  }
  function potential(r, th, lam, t) { // V / RE
    const P = legendre(Math.cos(th), Math.sin(th));
    let V = 0;
    for (let n = 1; n <= NMAX; n++) {
      const f = Math.pow(RE / r, n + 1);
      for (let m = 0; m <= n; m++) {
        const k = idx(n, m), g = G[k] + t * GD[k], h = H[k] + t * HD[k];
        V += f * (g * Math.cos(m * lam) + h * Math.sin(m * lam)) * P[n][m];
      }
    }
    return V;
  }
  function declination(lat, lng, date) {
    const d = date || new Date(), y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)), y1 = new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1));
    const t = d.getUTCFullYear() + (d - y0) / (y1 - y0) - EPOCH;
    const phi = lat * Math.PI / 180, lam = lng * Math.PI / 180;
    const Rc = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2), p = Rc * Math.cos(phi), z = Rc * (1 - E2) * Math.sin(phi);
    const r = Math.hypot(p, z), phic = Math.asin(z / r), th = Math.PI / 2 - phic;
    const e = 1e-6;
    // composantes géocentriques (nT) : X nord, Y est, Z vers le bas
    const X = RE * (potential(r, th + e, lam, t) - potential(r, th - e, lam, t)) / (2 * e) / r;
    const Y = -RE * (potential(r, th, lam + e, t) - potential(r, th, lam - e, t)) / (2 * e) / (r * Math.sin(th));
    const Z = RE * (potential(r + 1e-3, th, lam, t) - potential(r - 1e-3, th, lam, t)) / 2e-3;
    const psi = phic - phi; // passage au repère géodésique (rotation autour de l'axe est)
    const Xg = X * Math.cos(psi) - Z * Math.sin(psi);
    return Math.atan2(Y, Xg) * 180 / Math.PI; // + = Est
  }
  root.magDeclination = declination;
})(typeof window !== 'undefined' ? window : globalThis);
