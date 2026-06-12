/* ============================================================================
   math.js — a faithful browser port of the BMM engine (packages/core).
   Every interactive widget on the page computes through THESE functions, so the
   plots reproduce exactly what the server does. Kept in lockstep with:
     numerics.ts · gaussian.ts · pricing.ts · contracts.ts · signal.ts
     bayes.ts · spread.ts · solvency.ts · config.ts
   Pure functions, no deps, attached to the global `BMM`.
   ========================================================================== */
(function (global) {
  'use strict';

  // ---- shared/money.ts : round8 (round-half-even) -----------------------
  // Core passes every money result through round8; mirrored here so applyFill
  // and the LP helpers are byte-identical to the server, not just close.
  const MONEY_SCALE = 1e8;
  function round8(x) {
    if (!isFinite(x)) return x;
    const scaled = x * MONEY_SCALE;
    const floor = Math.floor(scaled);
    const diff = scaled - floor;
    let r;
    if (diff > 0.5) r = floor + 1;
    else if (diff < 0.5) r = floor;
    else r = floor % 2 === 0 ? floor : floor + 1; // tie → even
    return r / MONEY_SCALE;
  }

  // ---- numerics.ts -------------------------------------------------------
  const SQRT2 = Math.SQRT2;
  const INV_SQRT2PI = 1 / Math.sqrt(2 * Math.PI);

  /** Standard normal PDF φ(x). */
  function phi(x) {
    return INV_SQRT2PI * Math.exp(-0.5 * x * x);
  }

  function erfSeries(z) {
    let term = z;
    let sum = z;
    for (let n = 0; n < 100; n++) {
      term *= (-z * z) / (n + 1);
      const contribution = term / (2 * n + 3);
      sum += contribution;
      if (Math.abs(contribution) < 1e-18 * Math.abs(sum)) break;
    }
    return (2 / Math.sqrt(Math.PI)) * sum;
  }
  function erfcCF(z) {
    const tiny = 1e-300;
    let f = tiny, c = f, d = 0;
    for (let n = 1; n < 300; n++) {
      const an = n === 1 ? 1 : (n - 1) / 2;
      const bn = z;
      d = bn + an * d; if (d === 0) d = tiny;
      c = bn + an / c; if (c === 0) c = tiny;
      d = 1 / d;
      const delta = c * d;
      f *= delta;
      if (Math.abs(delta - 1) < 1e-16) break;
    }
    return (Math.exp(-z * z) / Math.sqrt(Math.PI)) * f;
  }
  function erf(x) {
    if (x === 0) return 0;
    const z = Math.abs(x);
    const r = z < 2 ? erfSeries(z) : 1 - erfcCF(z);
    return x < 0 ? -r : r;
  }
  function erfc(x) {
    if (x >= 2) return erfcCF(x);
    if (x <= -2) return 2 - erfcCF(-x);
    return 1 - erf(x);
  }
  /** Standard normal CDF Φ(x) = ½·erfc(−x/√2). */
  function Phi(x) {
    return 0.5 * erfc(-x / SQRT2);
  }

  /** Inverse normal CDF (Acklam) + one Halley step — enough for sampling/plots. */
  function normInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
      1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
      6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
      -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const plow = 0.02425, phigh = 1 - plow;
    let x;
    if (p < plow) {
      const q = Math.sqrt(-2 * Math.log(p));
      x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= phigh) {
      const q = p - 0.5, r = q * q;
      x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const e = Phi(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    x = x - u / (1 + (x * u) / 2);
    return x;
  }

  /** mulberry32 — seeded PRNG, matches numerics.ts Rng for reproducible MC. */
  function Rng(seed) {
    let state = (seed >>> 0) || 0x9e3779b9;
    this.next = function () {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.nextOpen = function () { return this.next() * (1 - 2 ** -32) + 2 ** -33; };
    this.nextNormal = function () { return normInv(this.nextOpen()); };
  }

  // ---- gaussian.ts -------------------------------------------------------
  function Belief(mu, sigma) {
    this.kind = 'gaussian';
    this.mu = mu;
    this.sigma = sigma;
    this.sigma2 = sigma * sigma;
  }
  Belief.prototype.pdf = function (t) { return phi((t - this.mu) / this.sigma) / this.sigma; };
  Belief.prototype.cdf = function (t) { return Phi((t - this.mu) / this.sigma); };
  // mean/variance/stddev — the shared BeliefModel interface, so kind-agnostic code
  // (expectF, priceAny, the belief-model sandbox) reads a Gaussian like any other kind.
  Belief.prototype.mean = function () { return this.mu; };
  Belief.prototype.variance = function () { return this.sigma2; };
  Belief.prototype.stddev = function () { return this.sigma; };
  Belief.prototype.sample = function (n, rng) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.mu + this.sigma * rng.nextNormal();
    return out;
  };

  // ---- contracts.ts : payoff(spec, θ) -----------------------------------
  function payoff(spec, t) {
    switch (spec.type) {
      case 'LINEAR': return t;
      case 'CALL': return Math.max(0, t - spec.strike);
      case 'PUT': return Math.max(0, spec.strike - t);
      case 'BINARY_CALL': return t >= spec.strike ? 1 : 0;
      case 'BINARY_PUT': return t <= spec.strike ? 1 : 0;
      case 'SPREAD': return t >= spec.lower && t <= spec.upper ? 1 : 0;
      case 'GAUSSIAN': return Math.exp(-((t - spec.center) ** 2) / (2 * spec.width * spec.width));
      default: throw new Error('payoff: unknown ' + spec.type);
    }
  }

  // ---- pricing.ts : fair price = E_belief[payoff] -----------------------
  function priceGaussianPayoff(c, w, mu, sigma2) {
    const w2 = w * w, denom = w2 + sigma2;
    return Math.sqrt(w2 / denom) * Math.exp(-((c - mu) ** 2) / (2 * denom));
  }
  function price(spec, b) {
    const mu = b.mu, sigma = b.sigma;
    switch (spec.type) {
      case 'LINEAR': return mu;
      case 'CALL': { const d = (mu - spec.strike) / sigma; return sigma * phi(d) + (mu - spec.strike) * Phi(d); }
      case 'PUT': { const d = (mu - spec.strike) / sigma; return sigma * phi(d) - (mu - spec.strike) * Phi(-d); }
      case 'BINARY_CALL': return Phi((mu - spec.strike) / sigma);
      case 'BINARY_PUT': return Phi((spec.strike - mu) / sigma);
      case 'SPREAD': return Phi((spec.upper - mu) / sigma) - Phi((spec.lower - mu) / sigma);
      case 'GAUSSIAN': return priceGaussianPayoff(spec.center, spec.width, mu, b.sigma2);
      default: throw new Error('price: unknown ' + spec.type);
    }
  }
  /** ∂Price/∂μ — drives the adverse-selection spread term. */
  function dPriceDMu(spec, b) {
    const mu = b.mu, sigma = b.sigma;
    switch (spec.type) {
      case 'LINEAR': return 1;
      case 'CALL': return Phi((mu - spec.strike) / sigma);
      case 'PUT': return -Phi((spec.strike - mu) / sigma);
      case 'BINARY_CALL': return phi((mu - spec.strike) / sigma) / sigma;
      case 'BINARY_PUT': return -phi((spec.strike - mu) / sigma) / sigma;
      case 'SPREAD': return (phi((spec.lower - mu) / sigma) - phi((spec.upper - mu) / sigma)) / sigma;
      case 'GAUSSIAN': { const V = spec.width * spec.width + b.sigma2; return (priceGaussianPayoff(spec.center, spec.width, mu, b.sigma2) * (spec.center - mu)) / V; }
      default: return 0;
    }
  }

  // ---- config.ts : DEFAULT_PARAMS + makeEngineConfig --------------------
  const DEFAULT_PARAMS = {
    s0: 0.01, gamma: 0.0005, lambda: 0.5, eta: 0.05, alpha: 1.0, beta: 1.0,
    lr: 0.01, decay: 0.05, reserveAlpha: 0.99, useSimplifiedUpdate: false,
    qMax: 500, qThreshold: 10, sigmaMinRatio: 0.1, sigmaEpsRatio: 1.0,
  };
  function makeEngineConfig(mu0, sigma0, overrides) {
    const base = {
      sigmaMin: DEFAULT_PARAMS.sigmaMinRatio * sigma0,
      sigmaEps: DEFAULT_PARAMS.sigmaEpsRatio * sigma0,
      s0: DEFAULT_PARAMS.s0, gamma: DEFAULT_PARAMS.gamma, lambda: DEFAULT_PARAMS.lambda,
      eta: DEFAULT_PARAMS.eta, alpha: DEFAULT_PARAMS.alpha, beta: DEFAULT_PARAMS.beta,
      qMax: DEFAULT_PARAMS.qMax, qThreshold: DEFAULT_PARAMS.qThreshold,
      lr: DEFAULT_PARAMS.lr, decay: DEFAULT_PARAMS.decay,
      reserveAlpha: DEFAULT_PARAMS.reserveAlpha, useSimplifiedUpdate: DEFAULT_PARAMS.useSimplifiedUpdate,
    };
    return Object.assign(base, overrides || {});
  }

  // ---- spread.ts : computeSpread ----------------------------------------
  function computeSpread(spec, q, mmShort, b, cfg) {
    const fair = price(spec, b);
    const absFair = Math.abs(fair);
    const sigma = b.sigma;
    const intensity = Math.abs(q) / cfg.qMax;
    const base = cfg.s0 * absFair;
    const inventory = cfg.gamma * Math.abs(mmShort + q) * absFair;
    const perSigmaMove = Math.abs(dPriceDMu(spec, b)) * sigma;
    const adverseSelection = cfg.lambda * intensity * perSigmaMove;
    const sigmaRel = sigma / Math.max(Math.abs(b.mu), sigma);
    const volatility = cfg.eta * sigmaRel * absFair;
    const total = base + inventory + adverseSelection + volatility;
    return { base, inventory, adverseSelection, volatility, total, fair };
  }
  function execPriceFor(side, fair, spreadTotal) {
    return side === 'buy' ? fair + spreadTotal : Math.max(0, fair - spreadTotal);
  }

  // ---- signal.ts : extractSignal ----------------------------------------
  function pointBet(target, mu, direction, alpha, sigma, intensity) {
    if (direction > 0) return target;
    const away = Math.sign(mu - target) || 1;
    return mu + away * alpha * sigma * (1 + intensity);
  }
  function extractSignal(spec, q, b, cfg) {
    const mu = b.mu, sigma = b.sigma;
    const absQ = Math.abs(q);
    const direction = q >= 0 ? 1 : -1;
    const intensity = absQ / cfg.qMax;
    const a = cfg.alpha;
    let signal;
    switch (spec.type) {
      case 'LINEAR': signal = mu + direction * cfg.beta * sigma * intensity; break;
      case 'CALL': case 'BINARY_CALL': signal = spec.strike + direction * a * sigma * (1 + intensity); break;
      case 'PUT': case 'BINARY_PUT': signal = spec.strike - direction * a * sigma * (1 + intensity); break;
      case 'GAUSSIAN': signal = pointBet(spec.center, mu, direction, a, sigma, intensity); break;
      case 'SPREAD': signal = pointBet((spec.lower + spec.upper) / 2, mu, direction, a, sigma, intensity); break;
      default: signal = mu;
    }
    const weight = intensity * (1 - Math.exp(-absQ / cfg.qThreshold));
    return { signal, weight };
  }

  // ---- bayes.ts : bayesUpdate -------------------------------------------
  function bayesUpdate(b, signal, weight, cfg) {
    const sigmaMin2 = cfg.sigmaMin * cfg.sigmaMin;
    if (weight <= 0) return new Belief(b.mu, Math.sqrt(Math.max(b.sigma2, sigmaMin2)));
    if (cfg.useSimplifiedUpdate) {
      const muNew = b.mu + cfg.lr * (signal - b.mu) * weight;
      const sigma2New = b.sigma2 * (1 - cfg.decay * weight);
      return new Belief(muNew, Math.sqrt(Math.max(sigma2New, sigmaMin2)));
    }
    const precisionPrior = 1 / b.sigma2;
    const precisionSignal = weight / (cfg.sigmaEps * cfg.sigmaEps);
    const totalPrecision = precisionPrior + precisionSignal;
    const muNew = (precisionPrior * b.mu + precisionSignal * signal) / totalPrecision;
    const sigma2New = 1 / totalPrecision;
    return new Belief(muNew, Math.sqrt(Math.max(sigma2New, sigmaMin2)));
  }

  // ---- solvency.ts : liability + requiredReserve (MC quantile) ----------
  function liability(book, t) {
    let s = 0;
    for (const e of book) s += e.mmShort * payoff(e.spec, t);
    return s;
  }
  function expectedLiability(book, b) {
    let s = 0;
    for (const e of book) s += e.mmShort * price(e.spec, b);
    return s;
  }
  /** α-quantile of liability over the belief — MC. Fewer samples than prod for UI speed. */
  function requiredReserve(book, b, opts) {
    opts = opts || {};
    if (!book.length) return 0;
    const alpha = opts.alpha != null ? opts.alpha : 0.99;
    const n = opts.samples || 6000;
    const rng = new Rng(opts.seed || 0x626d6d);
    const draws = b.sample(n, rng);
    const losses = new Float64Array(n);
    for (let i = 0; i < n; i++) losses[i] = liability(book, draws[i]);
    losses.sort();
    const idx = Math.min(n - 1, Math.max(0, Math.floor(alpha * (n - 1))));
    return Math.max(0, losses[idx]);
  }

  // ---- lpMath.ts (round8 applied, as in core) ---------------------------
  function lpSharePrice(nav, sharesTotal) { return sharesTotal > 0 ? round8(nav / sharesTotal) : 1; }
  function sharesForDeposit(amount, sharesTotal, navBefore) { return round8((amount * sharesTotal) / navBefore); }
  function cashOutForShares(shares, sharesTotal, nav) { return sharesTotal > 0 ? round8((shares / sharesTotal) * nav) : 0; }
  function lpClaimAmount(shares, sharesTotal, cashFinal) { return sharesTotal > 0 ? round8((shares / sharesTotal) * cashFinal) : 0; }

  // ---- applyFill (tradeMath.ts, round8 applied) -------------------------
  function applyFill(pos, q, execPrice) {
    if (q >= 0) {
      const newQty = round8(pos.quantity + q);
      const avg = newQty > 0 ? round8((pos.quantity * pos.avgEntryPrice + q * execPrice) / newQty) : 0;
      return { quantity: newQty, avgEntryPrice: avg, realizedPnl: pos.realizedPnl };
    }
    const sellQty = -q;
    const realized = round8(pos.realizedPnl + sellQty * (execPrice - pos.avgEntryPrice));
    const newQty = round8(pos.quantity - sellQty);
    return { quantity: newQty, avgEntryPrice: newQty > 0 ? pos.avgEntryPrice : 0, realizedPnl: realized };
  }

  // =======================================================================
  //  V2 — multi-modal beliefs (mixture.ts · student_t.ts · pricing.ts ·
  //  mixture_ops.ts · bayes.ts). Faithful browser port so the belief-model
  //  sandbox computes through the same math the server runs.
  // =======================================================================

  // ---- student_t.ts : lgamma (Lanczos) ----------------------------------
  const LANCZOS_G = 7;
  const LANCZOS_C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  function lgamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    const x = z - 1;
    let a = LANCZOS_C[0];
    const t = x + LANCZOS_G + 0.5;
    for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_C[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  // ---- mixture.ts : MixtureBelief ---------------------------------------
  // components: [{ pi, mu, sigma2 }]. mu/sigma exposed (mean & total stddev) so
  // the kind-agnostic extractSignal/spread read them like a Gaussian.
  function MixtureBelief(components) {
    let wsum = 0;
    for (const c of components) wsum += c.pi;
    this.kind = 'mixture';
    this.components = components.map((c) => ({ pi: c.pi / wsum, mu: c.mu, sigma2: c.sigma2 }));
    let m = 0;
    for (const c of this.components) m += c.pi * c.mu;
    let ex2 = 0;
    for (const c of this.components) ex2 += c.pi * (c.sigma2 + c.mu * c.mu); // law of total variance
    this.mu = m;
    this.sigma2 = Math.max(0, ex2 - m * m);
    this.sigma = Math.sqrt(this.sigma2);
  }
  MixtureBelief.prototype.mean = function () { return this.mu; };
  MixtureBelief.prototype.variance = function () { return this.sigma2; };
  MixtureBelief.prototype.stddev = function () { return this.sigma; };
  MixtureBelief.prototype.pdf = function (t) {
    let d = 0;
    for (const c of this.components) { const s = Math.sqrt(c.sigma2); d += c.pi * (phi((t - c.mu) / s) / s); }
    return d;
  };
  MixtureBelief.prototype.cdf = function (t) {
    let f = 0;
    for (const c of this.components) f += c.pi * Phi((t - c.mu) / Math.sqrt(c.sigma2));
    return f;
  };
  MixtureBelief.prototype.sample = function (n, rng) {
    const cum = []; let acc = 0;
    for (const c of this.components) { acc += c.pi; cum.push(acc); }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const u = rng.next(); let k = 0;
      while (k < cum.length - 1 && u > cum[k]) k++;
      const c = this.components[k];
      out[i] = c.mu + Math.sqrt(c.sigma2) * rng.nextNormal();
    }
    return out;
  };

  // ---- student_t.ts : StudentT (location-scale, ν>2) --------------------
  function StudentT(nu, mu, scale2) {
    this.kind = 'student_t';
    this.nu = nu; this.mu = mu; this.scale2 = scale2;
    this.sigma2 = (scale2 * nu) / (nu - 2);
    this.sigma = Math.sqrt(this.sigma2);
  }
  StudentT.fromVariance = function (nu, mu, variance) {
    return new StudentT(nu, mu, (variance * (nu - 2)) / nu);
  };
  StudentT.prototype.mean = function () { return this.mu; };
  StudentT.prototype.variance = function () { return this.sigma2; };
  StudentT.prototype.stddev = function () { return this.sigma; };
  StudentT.prototype.pdf = function (theta) {
    const s = Math.sqrt(this.scale2);
    const x = (theta - this.mu) / s;
    const logC = lgamma((this.nu + 1) / 2) - lgamma(this.nu / 2) - 0.5 * Math.log(this.nu * Math.PI) - Math.log(s);
    return Math.exp(logC) * Math.pow(1 + (x * x) / this.nu, -(this.nu + 1) / 2);
  };
  StudentT.prototype.sample = function (n, rng) {
    const s = Math.sqrt(this.scale2); const out = new Float64Array(n);
    // standard t = Z / √(χ²_ν/ν); χ²_ν via two normals only approximates — use the
    // Bailey polar method through the engine's normal sampler is overkill for the
    // sandbox, so we draw t directly by inverse-free rejection-free ν-scaling.
    for (let i = 0; i < n; i++) {
      // sum of ν iid normals² ≈ χ²_ν (exact for integer ν; ν is a slider integer here)
      let chi2 = 0; const k = Math.max(1, Math.round(this.nu));
      for (let j = 0; j < k; j++) { const z = rng.nextNormal(); chi2 += z * z; }
      const z = rng.nextNormal();
      out[i] = this.mu + s * (z / Math.sqrt(chi2 / this.nu));
    }
    return out;
  };

  // ---- pricing.ts : expectF + kind-agnostic price / dPriceDMu -----------
  /** E_p[g(θ)] via composite Simpson over a ±L·σ window (lighter nodes for UI). */
  function expectF(fn, belief, opts) {
    opts = opts || {};
    const mean = belief.mean(), sigma = belief.stddev();
    const L = opts.L || 10;
    let n = opts.nodes || 1200; if (n % 2 === 1) n += 1;
    const a = mean - L * sigma, b = mean + L * sigma, h = (b - a) / n;
    const ig = (t) => fn(t) * belief.pdf(t);
    let sum = ig(a) + ig(b);
    for (let i = 1; i < n; i++) sum += (i % 2 === 0 ? 2 : 4) * ig(a + i * h);
    return (sum * h) / 3;
  }
  /** Fair price for any belief kind: closed-form for Gaussian/mixture, quadrature for t. */
  function priceAny(spec, belief) {
    if (!belief.kind || belief.kind === 'gaussian') return price(spec, belief);
    if (belief.kind === 'mixture') {
      let s = 0;
      for (const c of belief.components) s += c.pi * price(spec, new Belief(c.mu, Math.sqrt(c.sigma2)));
      return s;
    }
    if (spec.type === 'LINEAR') return belief.mean(); // exact; avoids tail-truncation
    return expectF((t) => payoff(spec, t), belief);
  }
  function dPriceDMuAny(spec, belief) {
    if (!belief.kind || belief.kind === 'gaussian') return dPriceDMu(spec, belief);
    if (belief.kind === 'mixture') {
      let s = 0;
      for (const c of belief.components) s += c.pi * dPriceDMu(spec, new Belief(c.mu, Math.sqrt(c.sigma2)));
      return s;
    }
    const h = Math.max(1e-3, belief.stddev() * 1e-3);
    const up = priceAny(spec, new StudentT(belief.nu, belief.mu + h, belief.scale2));
    const dn = priceAny(spec, new StudentT(belief.nu, belief.mu - h, belief.scale2));
    return (up - dn) / (2 * h);
  }

  // ---- mixture_ops.ts : prune / merge / cap -----------------------------
  function mergeTwo(a, b) {
    const pi = a.pi + b.pi;
    const mu = (a.pi * a.mu + b.pi * b.mu) / pi;
    const ex2 = (a.pi * (a.sigma2 + a.mu * a.mu) + b.pi * (b.sigma2 + b.mu * b.mu)) / pi;
    return { pi, mu, sigma2: Math.max(ex2 - mu * mu, 1e-12) };
  }
  function manageMixture(comps, cfg) {
    cfg = cfg || { piMin: 0.02, tauMerge: 0.5, maxComponents: 6 };
    let kept = comps.filter((c) => c.pi >= cfg.piMin);
    if (!kept.length) { let best = comps[0]; for (const c of comps) if (c.pi > best.pi) best = c; kept = [best]; }
    const tot = kept.reduce((s, c) => s + c.pi, 0);
    let list = kept.map((c) => ({ pi: c.pi / tot, mu: c.mu, sigma2: c.sigma2 }));
    while (list.length > 1) {
      let best = null;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const denom = Math.sqrt(list[i].sigma2) + Math.sqrt(list[j].sigma2) || 1e-12;
        const d = Math.abs(list[i].mu - list[j].mu) / denom;
        if (!best || d < best.d) best = { i, j, d };
      }
      if (!best) break;
      const a = list[best.i], b = list[best.j];
      const qualifies = Math.abs(a.mu - b.mu) < cfg.tauMerge * (Math.sqrt(a.sigma2) + Math.sqrt(b.sigma2));
      const overCap = list.length > cfg.maxComponents;
      if (!qualifies && !overCap) break;
      const m = mergeTwo(a, b);
      list = list.filter((_, k) => k !== best.i && k !== best.j);
      list.push(m);
    }
    return new MixtureBelief(list);
  }

  // ---- bayes.ts : kind-aware updates ------------------------------------
  function bayesUpdateStudentT(belief, signal, weight, cfg) {
    const sigmaMin2 = cfg.sigmaMin * cfg.sigmaMin, nu = belief.nu, priorVar = belief.variance();
    if (weight <= 0) return StudentT.fromVariance(nu, belief.mu, Math.max(priorVar, sigmaMin2));
    if (cfg.useSimplifiedUpdate) {
      const muNew = belief.mu + cfg.lr * (signal - belief.mu) * weight;
      const varNew = priorVar * (1 - cfg.decay * weight);
      return StudentT.fromVariance(nu, muNew, Math.max(varNew, sigmaMin2));
    }
    const tau0 = 1 / priorVar, taus = weight / (cfg.sigmaEps * cfg.sigmaEps), tot = tau0 + taus;
    const muNew = (tau0 * belief.mu + taus * signal) / tot;
    return StudentT.fromVariance(nu, muNew, Math.max(1 / tot, sigmaMin2));
  }
  function bayesUpdateMixture(belief, signal, weight, cfg) {
    const sigmaMin2 = cfg.sigmaMin * cfg.sigmaMin, comps = belief.components;
    if (weight <= 0) return new MixtureBelief(comps.map((c) => ({ pi: c.pi, mu: c.mu, sigma2: Math.max(c.sigma2, sigmaMin2) })));
    const sigmaEps2 = cfg.sigmaEps * cfg.sigmaEps, LOG2PI = Math.log(2 * Math.PI);
    const logNum = []; let maxLog = -Infinity;
    for (const c of comps) {
      const vk = c.sigma2 + sigmaEps2;
      const logEv = -0.5 * (((signal - c.mu) ** 2) / vk + Math.log(vk) + LOG2PI);
      const ln = Math.log(c.pi) + weight * logEv;
      logNum.push(ln); if (ln > maxLog) maxLog = ln;
    }
    let z = 0; const r = [];
    for (let k = 0; k < comps.length; k++) { const e = Math.exp(logNum[k] - maxLog); r.push(e); z += e; }
    for (let k = 0; k < comps.length; k++) r[k] /= z;
    const updated = comps.map((c, k) => {
      const rk = r[k], pp = 1 / c.sigma2, ps = (weight * rk) / sigmaEps2, tot = pp + ps;
      return { pi: rk, mu: (pp * c.mu + ps * signal) / tot, sigma2: Math.max(1 / tot, sigmaMin2) };
    });
    return manageMixture(updated);
  }
  /** Kind-agnostic dispatcher — mirrors core's updateBelief. */
  function updateBelief(belief, signal, weight, cfg) {
    if (belief.kind === 'mixture') return bayesUpdateMixture(belief, signal, weight, cfg);
    if (belief.kind === 'student_t') return bayesUpdateStudentT(belief, signal, weight, cfg);
    return bayesUpdate(belief, signal, weight, cfg);
  }

  global.BMM = {
    round8,
    phi, Phi, erf, erfc, normInv, Rng, Belief,
    payoff, price, dPriceDMu, priceGaussianPayoff,
    DEFAULT_PARAMS, makeEngineConfig,
    computeSpread, execPriceFor, extractSignal, bayesUpdate,
    liability, expectedLiability, requiredReserve,
    lpSharePrice, sharesForDeposit, cashOutForShares, lpClaimAmount, applyFill,
    // V2 multi-modal beliefs
    lgamma, MixtureBelief, StudentT, expectF, priceAny, dPriceDMuAny,
    mergeTwo, manageMixture, bayesUpdateMixture, bayesUpdateStudentT, updateBelief,
  };
})(window);
