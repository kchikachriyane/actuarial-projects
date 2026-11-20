// Non-life reserving engine: simulated triangle + Chain Ladder, London Chain, Taylor Separation, Mack.
// All data is generated from a seeded random generator: it is illustrative and does not come from any insurer.
(function (root) {
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function normal(rng) { // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Simulate a paid triangle: claim counts per accident year x development pattern x calendar-year inflation x noise.
  function simulate(opts) {
    const o = Object.assign({ firstYear: 1993, n: 32, seed: 2026, inflation: 0.015, growth: 0.02, baseCount: 900, sevBase: 12, noise: 0.08 }, opts || {});
    const rng = mulberry32(o.seed);
    const n = o.n;
    // development pattern: share of an accident year's payments made in development period j (sums to 1)
    const raw = [];
    for (let j = 0; j < n; j++) raw.push(j === 0 ? 0.30 : 0.42 * Math.pow(0.62, j - 1) + 0.0004);
    const s = raw.reduce((a, b) => a + b, 0);
    const pattern = raw.map(x => x / s);
    const counts = [], inc = [], cum = [];
    for (let i = 0; i < n; i++) {
      counts.push(Math.round(o.baseCount * Math.pow(1 + o.growth, i) * Math.exp(0.05 * normal(rng))));
      inc.push([]); cum.push([]);
      let c = 0;
      for (let j = 0; j < n - i; j++) {
        const k = i + j; // calendar-year index
        const x = counts[i] * o.sevBase * pattern[j] * Math.pow(1 + o.inflation, k) * Math.exp(o.noise * normal(rng) - o.noise * o.noise / 2);
        const v = Math.round(x * 10) / 10; // thousands, one decimal
        inc[i].push(v); c += v; cum[i].push(Math.round(c * 10) / 10);
      }
    }
    const years = Array.from({ length: n }, (_, i) => o.firstYear + i);
    return { years, counts, inc, cum, n, truth: { pattern, inflation: o.inflation } };
  }

  const latest = cum => cum.map(r => r[r.length - 1]);

  // Chain Ladder (volume-weighted link ratios)
  function chainLadder(cum) {
    const n = cum.length, f = [];
    for (let j = 0; j < n - 1; j++) {
      let a = 0, b = 0;
      for (let i = 0; i < n - j - 1; i++) { a += cum[i][j + 1]; b += cum[i][j]; }
      f.push(b > 0 ? a / b : 1);
    }
    const full = cum.map((r, i) => { const x = r.slice(); for (let j = n - i; j < n; j++) x.push(x[j - 1] * f[j - 1]); return x; });
    const ult = full.map(r => r[n - 1]);
    const lat = latest(cum);
    const reserve = ult.map((u, i) => u - lat[i]);
    const cdf = []; let c = 1; for (let j = n - 2; j >= 0; j--) { c *= f[j]; cdf[j] = c; } cdf[n - 1] = 1;
    return { f, cdf, full, ult, reserve, total: reserve.reduce((a, b) => a + b, 0) };
  }

  // London Chain (Benjamin & Eagles): C(j+1) = lambda_j * C(j) + alpha_j, fitted by OLS per development period.
  function londonChain(cum, minPts) {
    minPts = minPts || 4;
    const n = cum.length, lam = [], alp = [];
    const cl = chainLadder(cum);
    for (let j = 0; j < n - 1; j++) {
      const xs = [], ys = [];
      for (let i = 0; i < n - j - 1; i++) { xs.push(cum[i][j]); ys.push(cum[i][j + 1]); }
      if (xs.length >= minPts) {
        const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
        let sxy = 0, sxx = 0; for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
        const l = sxx > 0 ? sxy / sxx : cl.f[j];
        lam.push(l); alp.push(my - l * mx);
      } else { lam.push(cl.f[j]); alp.push(0); } // too few points in the tail: fall back to the Chain Ladder factor
    }
    const full = cum.map((r, i) => { const x = r.slice(); for (let j = n - i; j < n; j++) x.push(lam[j - 1] * x[j - 1] + alp[j - 1]); return x; });
    const ult = full.map(r => r[n - 1]);
    const lat = latest(cum);
    const reserve = ult.map((u, i) => u - lat[i]);
    return { lambda: lam, alpha: alp, full, ult, reserve, total: reserve.reduce((a, b) => a + b, 0) };
  }

  // Taylor arithmetic separation method on incremental payments per claim.
  // s(i,j) = r_j * lambda_(i+j), sum r_j = 1. Future calendar indices extrapolated with a log-linear trend.
  function taylorSeparation(inc, counts, fitLast) {
    const n = inc.length;
    fitLast = fitLast || 15;
    const s = inc.map((r, i) => r.map(v => v / counts[i]));
    const d = new Array(n).fill(0), v = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) { d[i + j] += s[i][j]; v[j] += s[i][j]; }
    const r = new Array(n).fill(0), lam = new Array(n).fill(0);
    let sumRAfter = 0, sumLamFrom = 0;
    for (let k = n - 1; k >= 0; k--) {
      lam[k] = d[k] / (1 - sumRAfter);
      sumLamFrom += lam[k];
      r[k] = v[k] / sumLamFrom;
      sumRAfter += r[k];
    }
    // log-linear trend on the last `fitLast` calendar indices
    const ks = [], ys = [];
    for (let k = n - fitLast; k < n; k++) { ks.push(k); ys.push(Math.log(lam[k])); }
    const mk = ks.reduce((a, b) => a + b) / ks.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let sxy = 0, sxx = 0; for (let t = 0; t < ks.length; t++) { sxy += (ks[t] - mk) * (ys[t] - my); sxx += (ks[t] - mk) ** 2; }
    const slope = sxy / sxx, icpt = my - slope * mk;
    const lamFut = k => Math.exp(icpt + slope * k);
    const reserve = [];
    for (let i = 0; i < n; i++) { let x = 0; for (let j = n - i; j < n; j++) x += counts[i] * r[j] * lamFut(i + j); reserve.push(x); }
    return { r, lambda: lam, inflation: Math.exp(slope) - 1, lamFut, reserve, total: reserve.reduce((a, b) => a + b, 0) };
  }

  // Mack (1993) standard error of Chain Ladder reserves.
  function mack(cum) {
    const n = cum.length, cl = chainLadder(cum), f = cl.f, sig2 = [];
    for (let j = 0; j < n - 1; j++) {
      const m = n - j - 1; // number of link ratios in column j
      if (m > 1) {
        let s = 0; for (let i = 0; i < m; i++) s += cum[i][j] * (cum[i][j + 1] / cum[i][j] - f[j]) ** 2;
        sig2.push(s / (m - 1));
      } else sig2.push(NaN);
    }
    // last sigma^2: Mack's extrapolation
    for (let j = 0; j < n - 1; j++) if (isNaN(sig2[j])) {
      const a = sig2[j - 1], b = sig2[j - 2];
      sig2[j] = Math.min(a * a / b, Math.min(a, b));
    }
    const colSum = j => { let s = 0; for (let i = 0; i < n - j - 1; i++) s += cum[i][j]; return s; };
    const S = Array.from({ length: n - 1 }, (_, j) => colSum(j));
    const mse = [], se = [];
    for (let i = 0; i < n; i++) {
      const Cf = cl.full[i]; let t = 0;
      for (let j = n - i - 1; j < n - 1; j++) t += (sig2[j] / (f[j] * f[j])) * (1 / Cf[j] + 1 / S[j]);
      mse.push(cl.ult[i] * cl.ult[i] * t); se.push(Math.sqrt(cl.ult[i] * cl.ult[i] * t));
    }
    // total MSE (Mack's formula with covariance terms)
    let tot = 0;
    for (let i = 0; i < n; i++) {
      tot += mse[i];
      let sumU = 0; for (let k = i + 1; k < n; k++) sumU += cl.ult[k];
      let t = 0; for (let j = n - i - 1; j < n - 1; j++) t += (2 * sig2[j] / (f[j] * f[j])) / S[j];
      tot += cl.ult[i] * sumU * t;
    }
    const total = cl.total, seTot = Math.sqrt(tot);
    // log-normal fitted to mean and SE
    const s2 = Math.log(1 + (seTot / total) ** 2), mu = Math.log(total) - s2 / 2, sd = Math.sqrt(s2);
    const z995 = 2.5758293035489, z975 = 1.959963984540054;
    const q = z => Math.exp(mu + sd * z);
    return { sigma2: sig2, se, seTotal: seTot, cv: seTot / total, reserve: cl.reserve, total, logn: { mu, sd }, var995: q(z995), ci95: [q(-z975), q(z975)], cl };
  }

  root.Reserving = { simulate, chainLadder, londonChain, taylorSeparation, mack, latest };
  if (typeof module !== 'undefined') module.exports = root.Reserving;
})(typeof window !== 'undefined' ? window : globalThis);
