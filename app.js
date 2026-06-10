/* ============================================================================
   app.js — interactive layer for the BMM math doc.
     • KaTeX auto-render (vendored, offline)
     • TOC scrollspy
     • A small canvas Plot helper + the live widgets, each driven by math.js
   All numbers come from window.BMM so the plots match the real engine.
   ========================================================================== */
(function () {
  'use strict';
  const M = window.BMM;
  const redraws = []; // each widget registers its draw() so a theme switch can repaint
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const fmt = (n, d = 2) =>
    !isFinite(n) ? '∞' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtS = (n, d = 2) => (n >= 0 ? '+' : '−') + fmt(Math.abs(n), d);

  /* ---- KaTeX ----------------------------------------------------------- */
  function renderMath() {
    if (!window.renderMathInElement) return;
    window.renderMathInElement(document.body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
    });
  }

  /* ---- TOC scrollspy --------------------------------------------------- */
  function scrollspy() {
    const links = $$('nav.toc a[href^="#"]');
    const map = new Map();
    links.forEach((a) => {
      const id = a.getAttribute('href').slice(1);
      const sec = document.getElementById(id);
      if (sec) map.set(sec, a);
    });
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            links.forEach((l) => l.classList.remove('active'));
            const a = map.get(e.target);
            if (a) a.classList.add('active');
          }
        });
      },
      { rootMargin: '-10% 0px -80% 0px', threshold: 0 },
    );
    map.forEach((_, sec) => obs.observe(sec));
  }

  /* ---- canvas Plot helper --------------------------------------------- */
  function Plot(canvas, opts) {
    opts = opts || {};
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = opts.w || 660, H = opts.h || 320;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.aspectRatio = W + ' / ' + H;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const pad = Object.assign({ l: 46, r: 16, t: 14, b: 28 }, opts.pad || {});
    let dom = { x0: 0, x1: 1, y0: 0, y1: 1 };
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    // Live getters: re-read tokens on every access so a theme switch + redraw
    // repaints with the new palette (no stale cached colors).
    const COL = {};
    ['edge', 'faint', 'muted', 'accent', 'buy', 'sell', 'fg', 'warn'].forEach((k) => {
      Object.defineProperty(COL, k, { get: () => css('--' + k), enumerable: true });
    });
    const px = (x) => pad.l + ((x - dom.x0) / (dom.x1 - dom.x0)) * (W - pad.l - pad.r);
    const py = (y) => H - pad.b - ((y - dom.y0) / (dom.y1 - dom.y0)) * (H - pad.t - pad.b);
    const api = {
      W, H, COL,
      domain(x0, x1, y0, y1) { dom = { x0, x1, y0, y1 }; return api; },
      clear() { ctx.clearRect(0, 0, W, H); return api; },
      grid(xs, ys, opt) {
        opt = opt || {};
        ctx.strokeStyle = COL.edge; ctx.fillStyle = COL.faint;
        ctx.lineWidth = 1; ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        (xs || []).forEach((x) => {
          ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(px(x), pad.t); ctx.lineTo(px(x), H - pad.b); ctx.stroke();
          ctx.globalAlpha = 1; ctx.fillText(opt.xfmt ? opt.xfmt(x) : fmt(x, 0), px(x), H - pad.b + 5);
        });
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        (ys || []).forEach((y) => {
          ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(pad.l, py(y)); ctx.lineTo(W - pad.r, py(y)); ctx.stroke();
          ctx.globalAlpha = 1; ctx.fillText(opt.yfmt ? opt.yfmt(y) : fmt(y, 1), pad.l - 6, py(y));
        });
        ctx.globalAlpha = 1;
        // axes
        ctx.strokeStyle = COL.faint; ctx.beginPath();
        ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b); ctx.stroke();
        return api;
      },
      curve(fn, color, width, samples) {
        samples = samples || 240; ctx.strokeStyle = color; ctx.lineWidth = width || 2;
        ctx.lineJoin = 'round'; ctx.beginPath();
        for (let i = 0; i <= samples; i++) {
          const x = dom.x0 + (i / samples) * (dom.x1 - dom.x0);
          const y = fn(x); const X = px(x), Y = py(y);
          if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        }
        ctx.stroke(); return api;
      },
      area(fn, color, baseY, samples) {
        samples = samples || 240; baseY = baseY == null ? dom.y0 : baseY;
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(px(dom.x0), py(baseY));
        for (let i = 0; i <= samples; i++) {
          const x = dom.x0 + (i / samples) * (dom.x1 - dom.x0);
          ctx.lineTo(px(x), py(fn(x)));
        }
        ctx.lineTo(px(dom.x1), py(baseY)); ctx.closePath(); ctx.fill(); return api;
      },
      areaBetween(x0, x1, fn, color, samples) {
        samples = samples || 120; ctx.fillStyle = color; ctx.beginPath();
        ctx.moveTo(px(x0), py(dom.y0));
        for (let i = 0; i <= samples; i++) { const x = x0 + (i / samples) * (x1 - x0); ctx.lineTo(px(x), py(fn(x))); }
        ctx.lineTo(px(x1), py(dom.y0)); ctx.closePath(); ctx.fill(); return api;
      },
      vline(x, color, label, dash) {
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        if (dash) ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(px(x), pad.t); ctx.lineTo(px(x), H - pad.b); ctx.stroke();
        if (label) { ctx.fillStyle = color; ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(label, px(x), pad.t); }
        ctx.restore(); return api;
      },
      hline(y, color, label, dash) {
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        if (dash) ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(pad.l, py(y)); ctx.lineTo(W - pad.r, py(y)); ctx.stroke();
        if (label) { ctx.fillStyle = color; ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(label, pad.l + 4, py(y) - 2); }
        ctx.restore(); return api;
      },
      dot(x, y, color, r) {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px(x), py(y), r || 3.5, 0, 7); ctx.fill(); return api;
      },
    };
    return api;
  }

  /* ---- control factory ------------------------------------------------- */
  function slider(host, { label, min, max, step, value, fmt: f }) {
    const wrap = document.createElement('div'); wrap.className = 'control';
    wrap.innerHTML =
      '<div class="row"><label>' + label + '</label><span class="val"></span></div>' +
      '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '">';
    host.appendChild(wrap);
    const input = $('input', wrap), val = $('.val', wrap);
    const show = () => (val.textContent = (f || ((v) => fmt(v)))(parseFloat(input.value)));
    show();
    const obj = { el: input, get: () => parseFloat(input.value), on: (cb) => input.addEventListener('input', () => { show(); cb(); }), refresh: show };
    return obj;
  }
  function seg(host, { label, options, value }) {
    const wrap = document.createElement('div'); wrap.className = 'control';
    wrap.innerHTML = '<div class="row"><label>' + label + '</label></div><div class="seg-group"></div>';
    host.appendChild(wrap);
    const group = $('.seg-group', wrap); let cur = value; const cbs = [];
    options.forEach((o) => {
      const b = document.createElement('button'); b.className = 'seg' + (o.value === cur ? ' active' : '');
      b.textContent = o.label; b.onclick = () => { cur = o.value; $$('.seg', group).forEach((x) => x.classList.remove('active')); b.classList.add('active'); cbs.forEach((c) => c()); };
      group.appendChild(b);
    });
    return { get: () => cur, on: (cb) => cbs.push(cb) };
  }

  /* ===================================================================== */
  /*  Widget 1 — Belief (Gaussian)                                          */
  /* ===================================================================== */
  function vizBelief() {
    const root = $('#viz-belief'); if (!root) return;
    const cv = $('canvas', root), controls = $('.controls', root), out = $('.readout', root);
    const P = Plot(cv);
    const sMu = slider(controls, { label: 'μ — belief mean', min: 60, max: 140, step: 0.5, value: 100 });
    const sSg = slider(controls, { label: 'σ — uncertainty (std-dev)', min: 2, max: 30, step: 0.5, value: 10 });
    function draw() {
      const mu = sMu.get(), sg = sSg.get(); const b = new M.Belief(mu, sg);
      const x0 = mu - 4 * sg, x1 = mu + 4 * sg, ymax = b.pdf(mu) * 1.15;
      P.clear().domain(x0, x1, 0, ymax);
      const ticks = [mu - 3 * sg, mu - 1.5 * sg, mu, mu + 1.5 * sg, mu + 3 * sg];
      P.grid(ticks, [], { xfmt: (v) => fmt(v, 0) });
      const lo = mu - 1.2816 * sg, hi = mu + 1.2816 * sg;
      P.areaBetween(lo, hi, (x) => b.pdf(x), 'rgba(91,157,255,0.16)');
      P.area((x) => b.pdf(x), 'rgba(91,157,255,0.10)');
      P.curve((x) => b.pdf(x), P.COL.accent, 2.4);
      P.vline(mu, P.COL.buy, 'μ', true);
      out.innerHTML =
        cell('σ (std-dev)', fmt(sg, 1)) + cell('variance σ²', fmt(sg * sg, 1)) +
        cell('80% CI', '[' + fmt(lo, 1) + ', ' + fmt(hi, 1) + ']', 'accent') +
        cell('P(θ ≤ μ)', fmt(b.cdf(mu) * 100, 1) + '%');
    }
    sMu.on(draw); sSg.on(draw); redraws.push(draw); draw();
  }

  /* ===================================================================== */
  /*  Widget 2 — Pricing: fair = E[payoff]                                  */
  /* ===================================================================== */
  function vizPricing() {
    const root = $('#viz-pricing'); if (!root) return;
    const cv = $('canvas', root), controls = $('.controls', root), out = $('.readout', root);
    const P = Plot(cv);
    const tSeg = seg(controls, {
      label: 'Contract', value: 'CALL',
      options: [
        { label: 'Linear', value: 'LINEAR' }, { label: 'Call', value: 'CALL' }, { label: 'Put', value: 'PUT' },
        { label: 'Bin·Call', value: 'BINARY_CALL' }, { label: 'Spread', value: 'SPREAD' }, { label: 'Gaussian', value: 'GAUSSIAN' },
      ],
    });
    const sMu = slider(controls, { label: 'μ — belief mean', min: 60, max: 140, step: 0.5, value: 100 });
    const sSg = slider(controls, { label: 'σ — uncertainty', min: 2, max: 30, step: 0.5, value: 10 });
    const sK = slider(controls, { label: 'strike / center K', min: 60, max: 140, step: 0.5, value: 100 });
    const sW = slider(controls, { label: 'width (spread/gaussian)', min: 2, max: 40, step: 0.5, value: 15 });
    function specOf(K, W) {
      const t = tSeg.get();
      if (t === 'SPREAD') return { type: 'SPREAD', lower: K - W, upper: K + W };
      if (t === 'GAUSSIAN') return { type: 'GAUSSIAN', center: K, width: W };
      if (t === 'LINEAR') return { type: 'LINEAR' };
      return { type: t, strike: K };
    }
    function draw() {
      const mu = sMu.get(), sg = sSg.get(), K = sK.get(), W = sW.get();
      const b = new M.Belief(mu, sg), spec = specOf(K, W);
      const x0 = Math.min(mu - 4 * sg, K - 4 * sg), x1 = Math.max(mu + 4 * sg, K + 4 * sg);
      let pmax = 1e-6;
      for (let i = 0; i <= 120; i++) { const x = x0 + (i / 120) * (x1 - x0); pmax = Math.max(pmax, M.payoff(spec, x)); }
      P.clear().domain(x0, x1, 0, pmax * 1.1);
      P.grid([x0, (x0 + x1) / 2, x1], [], { xfmt: (v) => fmt(v, 0) });
      // belief shaded (normalized to plot height) — schematic "where the mass is"
      const bpk = b.pdf(mu);
      P.area((x) => (b.pdf(x) / bpk) * pmax * 0.9, 'rgba(52,211,153,0.10)');
      P.curve((x) => (b.pdf(x) / bpk) * pmax * 0.9, 'rgba(52,211,153,0.55)', 1.4);
      // payoff
      P.curve((x) => M.payoff(spec, x), P.COL.accent, 2.4);
      P.vline(mu, P.COL.buy, 'μ', true);
      const fair = M.price(spec, b);
      out.innerHTML =
        cell('Fair price = E[f(θ)]', fmt(fair, 4), 'accent') +
        cell('∂Price/∂μ', fmt(M.dPriceDMu(spec, b), 4)) +
        cell('payoff at μ', fmt(M.payoff(spec, mu), 4)) +
        cell('P(in-the-money)', itm(spec, b));
      // toggle strike/width relevance
      sK.el.closest('.control').style.opacity = tSeg.get() === 'LINEAR' ? 0.4 : 1;
      sW.el.closest('.control').style.opacity = (tSeg.get() === 'SPREAD' || tSeg.get() === 'GAUSSIAN') ? 1 : 0.4;
    }
    function itm(spec, b) {
      switch (spec.type) {
        case 'CALL': case 'BINARY_CALL': return fmt(M.Phi((b.mu - spec.strike) / b.sigma) * 100, 1) + '%';
        case 'PUT': case 'BINARY_PUT': return fmt(M.Phi((spec.strike - b.mu) / b.sigma) * 100, 1) + '%';
        case 'SPREAD': return fmt(M.price(spec, b) * 100, 1) + '%';
        default: return '—';
      }
    }
    [tSeg, sMu, sSg, sK, sW].forEach((c) => c.on(draw)); redraws.push(draw); draw();
  }

  /* ===================================================================== */
  /*  Widget 3 — Bayesian update (the learning loop)                        */
  /* ===================================================================== */
  function vizBayes() {
    const root = $('#viz-bayes'); if (!root) return;
    const cv = $('canvas', root), controls = $('.controls', root), out = $('.readout', root);
    const P = Plot(cv);
    let prior = new M.Belief(100, 12);
    const cfg = M.makeEngineConfig(100, 12);
    const tSeg = seg(controls, {
      label: 'Trade contract', value: 'CALL',
      options: [{ label: 'Linear', value: 'LINEAR' }, { label: 'Call', value: 'CALL' }, { label: 'Put', value: 'PUT' }],
    });
    const sideSeg = seg(controls, { label: 'Side', value: 'buy', options: [{ label: 'Buy', value: 'buy' }, { label: 'Sell', value: 'sell' }] });
    const sQ = slider(controls, { label: 'size |q|', min: 1, max: 500, step: 1, value: 120 });
    const sK = slider(controls, { label: 'strike K', min: 70, max: 130, step: 1, value: 100 });
    const btns = document.createElement('div'); btns.style.cssText = 'display:flex;gap:.5rem;margin-top:.4rem';
    btns.innerHTML = '<button class="seg" id="bayes-commit">Commit & repeat ↻</button><button class="seg" id="bayes-reset">Reset</button>';
    controls.appendChild(btns);
    function spec() { const t = tSeg.get(); return t === 'LINEAR' ? { type: 'LINEAR' } : { type: t, strike: sK.get() }; }
    function compute() {
      const q = (sideSeg.get() === 'buy' ? 1 : -1) * sQ.get();
      const sig = M.extractSignal(spec(), q, prior, cfg);
      const post = M.bayesUpdate(prior, sig.signal, sig.weight, cfg);
      return { q, sig, post };
    }
    function draw() {
      const { sig, post } = compute();
      const lo = Math.min(prior.mu - 4 * prior.sigma, post.mu - 4 * post.sigma, sig.signal);
      const hi = Math.max(prior.mu + 4 * prior.sigma, post.mu + 4 * post.sigma, sig.signal);
      const ymax = Math.max(prior.pdf(prior.mu), post.pdf(post.mu)) * 1.15;
      P.clear().domain(lo, hi, 0, ymax);
      P.grid([lo, (lo + hi) / 2, hi], [], { xfmt: (v) => fmt(v, 0) });
      P.area((x) => prior.pdf(x), 'rgba(139,151,168,0.10)');
      P.curve((x) => prior.pdf(x), P.COL.muted, 1.6);
      P.curve((x) => post.pdf(x), P.COL.accent, 2.6);
      P.vline(sig.signal, P.COL.warn, 'signal s', true);
      P.vline(prior.mu, P.COL.muted, 'μ');
      P.vline(post.mu, P.COL.accent, "μ'");
      out.innerHTML =
        cell('signal s', fmt(sig.signal, 2), 'accent') + cell('weight w', fmt(sig.weight, 4)) +
        cell("μ → μ'", fmt(prior.mu, 2) + ' → ' + fmt(post.mu, 2)) +
        cell("σ → σ'", fmt(prior.sigma, 2) + ' → ' + fmt(post.sigma, 2));
    }
    $('#bayes-commit', btns).onclick = () => { prior = compute().post; draw(); };
    $('#bayes-reset', btns).onclick = () => { prior = new M.Belief(100, 12); draw(); };
    [tSeg, sideSeg, sQ, sK].forEach((c) => c.on(draw)); redraws.push(draw); draw();
  }

  /* ===================================================================== */
  /*  Widget 4 — Spread breakdown                                           */
  /* ===================================================================== */
  function vizSpread() {
    const root = $('#viz-spread'); if (!root) return;
    const controls = $('.controls', root), out = $('.readout', root), bars = $('.bars', root);
    const cfg = M.makeEngineConfig(100, 12);
    const b = new M.Belief(100, 12);
    const tSeg = seg(controls, {
      label: 'Contract', value: 'CALL',
      options: [{ label: 'Linear', value: 'LINEAR' }, { label: 'Call', value: 'CALL' }, { label: 'Bin·Call', value: 'BINARY_CALL' }],
    });
    const sideSeg = seg(controls, { label: 'Side', value: 'buy', options: [{ label: 'Buy', value: 'buy' }, { label: 'Sell', value: 'sell' }] });
    const sQ = slider(controls, { label: 'size |q|', min: 1, max: 500, step: 1, value: 120 });
    const sInv = slider(controls, { label: 'mmShort (existing inventory)', min: 0, max: 1000, step: 10, value: 200 });
    const COLORS = { base: '--muted', inventory: '--warn', adverseSelection: '--accent', volatility: '--sell' };
    const PARTS = ['base', 'inventory', 'adverseSelection', 'volatility'];
    // Build the bar rows once; draw() only updates widths/values so CSS can
    // animate the transition smoothly instead of replacing the DOM each tick.
    const rows = {};
    bars.innerHTML = PARTS.map((k) =>
      '<div class="bar-row"><div class="bar-head"><span>' + k + '</span><span class="tnum" data-v="' + k + '">—</span></div>' +
      '<div class="bar-track"><div class="bar-fill" data-f="' + k + '" style="background:var(' + COLORS[k] + ')"></div></div></div>',
    ).join('');
    PARTS.forEach((k) => { rows[k] = { v: $('[data-v="' + k + '"]', bars), f: $('[data-f="' + k + '"]', bars) }; });
    function spec() { const t = tSeg.get(); return t === 'LINEAR' ? { type: 'LINEAR' } : { type: t, strike: 100 }; }
    function draw() {
      const q = (sideSeg.get() === 'buy' ? 1 : -1) * sQ.get();
      const s = M.computeSpread(spec(), q, sInv.get(), b, cfg);
      PARTS.forEach((k) => {
        const v = s[k], pct = s.total > 0 ? (v / s.total) * 100 : 0;
        rows[k].v.textContent = fmt(v, 4);
        rows[k].f.style.width = pct.toFixed(1) + '%';
      });
      const fair = s.fair, exec = M.execPriceFor(q >= 0 ? 'buy' : 'sell', fair, s.total);
      out.innerHTML =
        cell('Fair (mid)', fmt(fair, 4)) +
        cell('Spread total', fmt(s.total, 4), 'accent') +
        cell(q >= 0 ? 'Ask (you pay)' : 'Bid (you get)', fmt(exec, 4), q >= 0 ? 'sell' : 'buy') +
        cell('spread / fair', (fair ? fmt((s.total / Math.abs(fair)) * 100, 2) : '—') + '%');
    }
    [tSeg, sideSeg, sQ, sInv].forEach((c) => c.on(draw)); redraws.push(draw); draw();
  }

  /* ===================================================================== */
  /*  Widget 5 — Reserve & solvency                                         */
  /* ===================================================================== */
  function vizReserve() {
    const root = $('#viz-reserve'); if (!root) return;
    const cv = $('canvas', root), controls = $('.controls', root), out = $('.readout', root);
    const P = Plot(cv);
    const tSeg = seg(controls, {
      label: 'Book: one contract', value: 'BINARY_CALL',
      options: [{ label: 'Call', value: 'CALL' }, { label: 'Bin·Call', value: 'BINARY_CALL' }, { label: 'Linear', value: 'LINEAR' }],
    });
    const sShort = slider(controls, { label: 'mmShort (units users hold)', min: 0, max: 800, step: 5, value: 300 });
    const sMu = slider(controls, { label: 'μ', min: 70, max: 130, step: 0.5, value: 100 });
    const sSg = slider(controls, { label: 'σ', min: 3, max: 30, step: 0.5, value: 12 });
    const sCash = slider(controls, { label: 'MM cash', min: 0, max: 600, step: 5, value: 250, fmt: (v) => fmt(v, 0) });
    function spec() { const t = tSeg.get(); return t === 'LINEAR' ? { type: 'LINEAR' } : { type: t, strike: 100 }; }
    function draw() {
      const mu = sMu.get(), sg = sSg.get(), b = new M.Belief(mu, sg);
      const book = [{ spec: spec(), mmShort: sShort.get() }];
      const reserve = M.requiredReserve(book, b, { alpha: 0.99, samples: 6000 });
      const eL = M.expectedLiability(book, b);
      const x0 = mu - 4 * sg, x1 = mu + 4 * sg;
      let Lmax = 1e-6; for (let i = 0; i <= 120; i++) { const x = x0 + (i / 120) * (x1 - x0); Lmax = Math.max(Lmax, M.liability(book, x)); }
      Lmax = Math.max(Lmax, reserve) * 1.12;
      P.clear().domain(x0, x1, 0, Lmax);
      P.grid([x0, mu, x1], [reserve, eL], { xfmt: (v) => fmt(v, 0), yfmt: (v) => fmt(v, 0) });
      const bpk = b.pdf(mu);
      P.area((x) => (b.pdf(x) / bpk) * Lmax * 0.85, 'rgba(52,211,153,0.10)');
      P.curve((x) => (b.pdf(x) / bpk) * Lmax * 0.85, 'rgba(52,211,153,0.5)', 1.3);
      P.curve((x) => M.liability(book, x), P.COL.sell, 2.4);
      P.hline(reserve, P.COL.warn, 'reserve (99%)', true);
      P.hline(eL, P.COL.accent, 'E[L]', true);
      const cash = sCash.get(), gate = 1.2 * reserve, ok = cash + 1e-6 >= gate;
      out.innerHTML =
        cell('Required reserve (99%)', fmt(reserve, 2), 'sell') +
        cell('Expected liability', fmt(eL, 2), 'accent') +
        cell('Open gate 1.2 × R', fmt(gate, 2)) +
        cell('cash ≥ gate?', ok ? 'SOLVENT ✓' : 'BLOCKED ✕', ok ? 'buy' : 'sell');
    }
    [tSeg, sShort, sMu, sSg, sCash].forEach((c) => c.on(draw)); redraws.push(draw); draw();
  }

  /* ===================================================================== */
  /*  Widget 6 — LP share accounting                                        */
  /* ===================================================================== */
  function vizLp() {
    const root = $('#viz-lp'); if (!root) return;
    const controls = $('.controls', root), out = $('.readout', root);
    const sNav = slider(controls, { label: 'Pool NAV before', min: 100, max: 5000, step: 50, value: 1000, fmt: (v) => fmt(v, 0) });
    const sShares = slider(controls, { label: 'Shares outstanding', min: 100, max: 5000, step: 50, value: 1000, fmt: (v) => fmt(v, 0) });
    const sDep = slider(controls, { label: 'Your deposit', min: 0, max: 2000, step: 25, value: 200, fmt: (v) => fmt(v, 0) });
    function draw() {
      const nav = sNav.get(), shares = sShares.get(), dep = sDep.get();
      const price = M.lpSharePrice(nav, shares);
      const minted = M.sharesForDeposit(dep, shares, nav);
      const newShares = shares + minted, newNav = nav + dep;
      const ownPct = newShares > 0 ? (minted / newShares) * 100 : 0;
      out.innerHTML =
        cell('Share price (NAV/S)', fmt(price, 4), 'accent') +
        cell('Shares minted', fmt(minted, 2)) +
        cell('Your ownership', fmt(ownPct, 2) + '%') +
        cell('Pool after', fmt(newNav, 0) + ' / ' + fmt(newShares, 0) + ' sh');
    }
    [sNav, sShares, sDep].forEach((c) => c.on(draw)); redraws.push(draw); draw();
  }

  function cell(k, v, tone) {
    return '<div><div class="k">' + k + '</div><div class="v ' + (tone || '') + '">' + v + '</div></div>';
  }

  /* ---- theme toggle (persisted) --------------------------------------- */
  function theme() {
    const root = document.documentElement;
    const btn = $('#theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const toLight = root.getAttribute('data-theme') !== 'light';
      if (toLight) root.setAttribute('data-theme', 'light');
      else root.removeAttribute('data-theme');
      try { localStorage.setItem('bmm-theme', toLight ? 'light' : 'dark'); } catch (e) {}
      // Repaint every canvas widget with the new palette.
      redraws.forEach((fn) => { try { fn(); } catch (e) {} });
    });
  }

  /* ---- reading-progress bar ------------------------------------------- */
  function progress() {
    const bar = $('#progress');
    if (!bar) return;
    const tick = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      bar.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    };
    window.addEventListener('scroll', tick, { passive: true });
    window.addEventListener('resize', tick);
    tick();
  }

  /* ---- scroll-reveal --------------------------------------------------- */
  function reveal() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.body.classList.add('reveal-ready');
    const targets = $$('section, .hero');
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); obs.unobserve(e.target); }
      }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.04 },
    );
    targets.forEach((t) => obs.observe(t));
  }

  /* ---- boot ------------------------------------------------------------ */
  function boot() {
    renderMath();
    scrollspy();
    theme();
    progress();
    vizBelief(); vizPricing(); vizBayes(); vizSpread(); vizReserve(); vizLp();
    reveal();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
