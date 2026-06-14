// ============================================================================
// multimodel.js — candidate PARAMETRIC belief families for the "flexible
// beliefs" design study (math doc ). Exploration only, NOT the shipped
// engine: these extend the curve's shape power while staying parametric
// (continuous θ, closed-form-or-quadrature pricing). Built on window.BMM
// (math.js), loaded before app.js. Attaches to window.MMODEL.
// ==========================================================================
((global) => {
  const B = global.BMM; // the faithful engine port (phi, Phi, lgamma, payoff, …)
  const G = (z) => Math.exp(B.lgamma(z)); // Γ via lgamma

  // 1.1 Skew-normal: one bump that can lean left/right (skew α) -------
  function skewNormal(xi, omega, alpha) {
    const delta = alpha / Math.sqrt(1 + alpha * alpha);
    const mean = xi + omega * delta * Math.sqrt(2 / Math.PI);
    const variance = omega * omega * (1 - (2 * delta * delta) / Math.PI);
    return {
      kind: 'skew_normal',
      pdf: (x) => (2 / omega) * B.phi((x - xi) / omega) * B.Phi((alpha * (x - xi)) / omega),
      mean: () => mean,
      variance: () => variance,
      stddev: () => Math.sqrt(variance),
    };
  }

  // 1.2 Generalized normal (exp-power): peak ↔ flat (β), σ held -------
  // β=2 → Gaussian, β=1 → Laplace (sharp), β→∞ → flat-top. We solve the scale
  // α so the stddev equals `s` regardless of β, isolating the peakedness knob.
  function genNormal(mu, s, beta) {
    const alpha = s * Math.sqrt(G(1 / beta) / G(3 / beta));
    const norm = beta / (2 * alpha * G(1 / beta));
    return {
      kind: 'gen_normal',
      pdf: (x) => norm * Math.exp(-Math.pow(Math.abs(x - mu) / alpha, beta)),
      mean: () => mu,
      variance: () => s * s,
      stddev: () => s,
    };
  }

  // 1.3 Beta on [lo,hi]: U / J / skew / flat / peak (bounded) ---------
  function betaScaled(lo, hi, a, b) {
    const w = hi - lo;
    const logB = B.lgamma(a) + B.lgamma(b) - B.lgamma(a + b);
    const mean = lo + (w * a) / (a + b);
    const variance = (w * w * a * b) / ((a + b) * (a + b) * (a + b + 1));
    return {
      kind: 'beta',
      lo,
      hi,
      pdf: (x) => {
        const u = (x - lo) / w;
        if (u <= 0 || u >= 1) return 0;
        return Math.exp((a - 1) * Math.log(u) + (b - 1) * Math.log(1 - u) - logB) / w;
      },
      mean: () => mean,
      variance: () => variance,
      stddev: () => Math.sqrt(variance),
    };
  }

  // 1.6 Fixed-basis Gaussian density: near-arbitrary smooth shape -----
  // N narrow Gaussian bumps on a fixed grid; the WEIGHTS are the free params.
  // Closed-form priced (it IS a mixture), so no quadrature. `modes` synthesises
  // a wiggly weight profile so the slider sweeps simple → multi-peaked.
  function fixedBasis(lo, hi, N, modes, smooth, skew) {
    skew = skew || 0;
    const w = hi - lo;
    // bump width tied to the hump spacing so `modes` peaks actually resolve; the
    // `smooth` knob (≈ σ-slider) widens/narrows them around that base.
    const sigma = Math.max(2, (w / modes) * 0.34 * (smooth || 1));
    const comps = [];
    for (let k = 0; k < N; k++) {
      const t = k / (N - 1);
      const c = lo + w * t;
      let env = 0.04; // small floor so valleys don't hit zero
      for (let j = 0; j < modes; j++) {
        const cj = (j + 0.5) / modes; // place exactly `modes` humps across the grid
        const z = (t - cj) / (0.42 / modes);
        env += Math.exp(-(z * z));
      }
      const tilt = Math.exp(skew * (t - 0.5) * 2.2); // skew the weight envelope L↔R
      comps.push({ pi: env * tilt, mu: c, sigma2: sigma * sigma });
    }
    return new B.MixtureBelief(comps); // kind='mixture' → closed-form pricing
  }

  // a "few distinct camps" mixture, K modes evenly spread ------------
  function fewCamps(center, spread, K, sigma) {
    const comps = [];
    for (let k = 0; k < K; k++) {
      const mu = K === 1 ? center : center - spread + (2 * spread * k) / (K - 1);
      comps.push({ pi: 1, mu, sigma2: sigma * sigma });
    }
    return new B.MixtureBelief(comps);
  }

  // THE GENERAL FORM: max-entropy / moment-expansion ------------------
  // p(θ) ∝ exp(−[½λ₂u² + λ₃u³ + λ₄u⁴ + λ₆u⁶]), u=(θ−μ)/s — an exponential-family
  // density whose exponent is a polynomial. Each added term is one more shape knob
  // and the mode count is bounded by the polynomial degree (deg 2m → up to m modes)
  // λ₂ → Gaussian, +λ₃ → skew, +λ₄>0 → fat tails / flat-top, λ₂<0 → bimodal.
  // (3+ modes need a higher-degree poly with finely-balanced wells
  // form for arbitrary multi-bump.) No closed-form price (quadrature), but always a
  // valid density — a small u⁶ term, scaled up with |λ₃|, keeps the tails decaying
  // (integrable) and stops skew dragging the mean off. Moments cached.
  function maxEnt(mu, s, lam2, lam3, lam4) {
    const l6 = 0.004 + 0.06 * Math.max(0, -lam4) + 0.03 * Math.abs(lam3); // confining stabiliser
    const energy = (u) => {
      const u2 = u * u;
      return 0.5 * lam2 * u2 + lam3 * u2 * u + lam4 * u2 * u2 + l6 * u2 * u2 * u2;
    };
    const L = 7,
      N = 2000,
      h = (2 * L) / N;
    let Emin = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= N; i++) {
      const e = energy(-L + i * h);
      if (e < Emin) Emin = e;
    }
    let Z = 0,
      m1 = 0,
      m2 = 0;
    for (let i = 0; i <= N; i++) {
      const u = -L + i * h;
      const w = (i === 0 || i === N ? 1 : i % 2 ? 4 : 2) * Math.exp(-(energy(u) - Emin));
      Z += w;
      m1 += w * u;
      m2 += w * u * u;
    }
    Z *= h / 3;
    m1 *= h / 3;
    m2 *= h / 3;
    const eu = m1 / Z,
      eu2 = m2 / Z;
    const mean = mu + s * eu;
    const variance = s * s * Math.max(1e-9, eu2 - eu * eu);
    return {
      kind: 'maxent',
      pdf: (x) => {
        const u = (x - mu) / s;
        return Math.abs(u) > L ? 0 : Math.exp(-(energy(u) - Emin)) / (s * Z);
      },
      mean: () => mean,
      variance: () => variance,
      stddev: () => Math.sqrt(variance),
    };
  }

  // pricing that also covers the non-engine families (quadrature) ----
  function priceFlex(spec, belief) {
    if (belief.kind === 'gaussian' || belief.kind === 'mixture' || belief.kind === 'student_t') {
      return B.priceAny(spec, belief);
    }
    if (spec.type === 'LINEAR') return belief.mean();
    return B.expectF((t) => B.payoff(spec, t), belief); // skew/gen-normal/beta
  }

  // scorecard metadata (flexibility vs implementation difficulty) -----
  // flex 1–5; off/on are difficulty notes; price = pricing path.
  const META = {
    gaussian: {
      label: 'Gaussian',
      dof: '2 (μ, σ)',
      shapes: 'one symmetric bump',
      price: 'closed-form (Φ, φ)',
      update: 'conjugate · exact',
      off: 'shipped',
      on: 'moderate — Φ approx',
      flex: 1,
    },
    skew_normal: {
      label: 'Skew-normal',
      dof: '3 (ξ, ω, α)',
      shapes: 'asymmetric bump (lean L/R)',
      price: 'quadrature (Φ·φ)',
      update: 'moment-match (ADF)',
      off: 'low',
      on: 'hard — Φ inside ∫',
      flex: 2,
    },
    gen_normal: {
      label: 'Generalized-normal',
      dof: '3 (μ, α, β)',
      shapes: 'sharp spike ↔ flat-top',
      price: 'quadrature + Γ',
      update: 'moment-match',
      off: 'low',
      on: 'hard — Γ, frac. powers',
      flex: 2,
    },
    student_t: {
      label: 'Student-t',
      dof: '3 (μ, σ, ν)',
      shapes: 'fat tails',
      price: 'quadrature + Γ',
      update: 'variance-domain · shipped',
      off: 'shipped',
      on: 'hard — Γ, pow',
      flex: 2,
    },
    beta: {
      label: 'Beta (bounded)',
      dof: '2–3 (a, b[, range])',
      shapes: 'U / J / skew / flat / peak',
      price: 'incomplete-β',
      update: 'near-conjugate',
      off: 'low–med',
      on: 'hard — incomplete-β',
      flex: 3,
    },
    mixture: {
      label: 'Mixture (camps)',
      dof: '3K (π, μ, σ)×K',
      shapes: 'K distinct camps',
      price: 'closed-form Σ',
      update: 'responsibility + manage · shipped',
      off: 'shipped',
      on: 'moderate — K·Φ',
      flex: 4,
    },
    basis: {
      label: 'Gen·basis ⛓',
      dof: 'N weights',
      shapes: 'ANY # bumps · skew · flat',
      price: 'closed-form Σ·Φ',
      update: 'weight-only',
      off: 'low',
      on: 'feasible — N·Φ, linear',
      flex: 5,
    },
    maxent: {
      label: 'Gen·exact ★',
      dof: '2 + M (μ,σ,λₖ…)',
      shapes: 'skew · peak · flat · bimodal',
      price: 'quadrature (exp-poly)',
      update: 'moment-projection',
      off: 'medium',
      on: 'very hard — numeric ∫',
      flex: 4,
    },
  };

  global.MMODEL = {
    skewNormal,
    genNormal,
    betaScaled,
    fixedBasis,
    fewCamps,
    maxEnt,
    priceFlex,
    META,
  };
})(window);
