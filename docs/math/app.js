// ============================================================================
// app.js — interactive layer for the BMM math doc.
// • KaTeX auto-render (vendored, offline)
// • TOC scrollspy
// • A small canvas Plot helper + the live widgets, each driven by math.js
// All numbers come from window.BMM so the plots match the real engine.
// ==========================================================================
(function () {
  'use strict';
  const M = window.BMM;
  const redraws = []; // each widget registers its draw so a theme switch can repaint
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const fmt = (n, d = 2) =>
    !isFinite(n) ? '∞' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtS = (n, d = 2) => (n >= 0 ? '+' : '−') + fmt(Math.abs(n), d);

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

  // Shows each model against the equal-(μ,σ) Gaussian, how its fair price
  function vizBeliefModels() {
    const root = $('#viz-models'); if (!root) return;
    const cv = $('canvas', root), controls = $('.controls', root), out = $('.readout', root);
    const P = Plot(cv);
    const cfg = M.makeEngineConfig(100, 12);

    const kindSeg = seg(controls, {
      label: 'Belief model', value: 'mixture',
      options: [
        { label: 'Gaussian', value: 'gaussian' },
        { label: 'Mixture', value: 'mixture' },
        { label: 'Student-t', value: 'student_t' },
      ],
    });
    const sMu = slider(controls, { label: 'μ — center', min: 70, max: 130, step: 0.5, value: 100 });
    const sSg = slider(controls, { label: 'σ — uncertainty', min: 4, max: 26, step: 0.5, value: 12 });
    const sGap = slider(controls, { label: 'mode separation (mixture)', min: 0, max: 28, step: 0.5, value: 16 });
    const sW = slider(controls, { label: 'left-camp weight π₁ (mixture)', min: 0.1, max: 0.9, step: 0.05, value: 0.5, fmt: (v) => fmt(v, 2) });
    const sNu = slider(controls, { label: 'ν — degrees of freedom (Student-t)', min: 3, max: 40, step: 0.5, value: 5 });
    const cSeg = seg(controls, {
      label: 'Contract', value: 'BINARY_CALL',
      options: [{ label: 'Call', value: 'CALL' }, { label: 'Bin·Call', value: 'BINARY_CALL' }, { label: 'Spread', value: 'SPREAD' }],
    });
    const sK = slider(controls, { label: 'strike / center K', min: 70, max: 145, step: 1, value: 122 });
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:.5rem;margin-top:.4rem;flex-wrap:wrap';
    btns.innerHTML = '<button class="seg" id="bm-buy">Buy K ↑ & commit</button>'
      + '<button class="seg" id="bm-sell">Sell K ↓ & commit</button>'
      + '<button class="seg" id="bm-reset">Reset prior</button>';
    controls.appendChild(btns);

    function prior() {
      const mu = sMu.get(), sg = sSg.get(), kind = kindSeg.get();
      if (kind === 'gaussian') return new M.Belief(mu, sg);
      if (kind === 'student_t') return M.StudentT.fromVariance(sNu.get(), mu, sg * sg);
      const gap = sGap.get(), w = sW.get();
      return new M.MixtureBelief([
        { pi: w, mu: mu - gap, sigma2: sg * sg },
        { pi: 1 - w, mu: mu + gap, sigma2: sg * sg },
      ]);
    }
    let cur = prior();
    function specOf() { const t = cSeg.get(), K = sK.get(); return t === 'SPREAD' ? { type: 'SPREAD', lower: K - 8, upper: K + 8 } : { type: t, strike: K }; }
    function commit(side) {
      const q = (side === 'buy' ? 1 : -1) * 180;
      const sig = M.extractSignal(specOf(), q, cur, cfg);
      cur = M.updateBelief(cur, sig.signal, sig.weight, cfg);
      draw();
    }
    function shapeNote() {
      if (cur.kind === 'mixture') { const n = cur.components.length; return n > 1 ? n + ' camps (multi-modal)' : 'merged → 1 camp'; }
      if (cur.kind === 'student_t') return 'fat tails · ν=' + fmt(cur.nu, 1);
      return 'single symmetric bump';
    }
    function relevance() {
      const kind = kindSeg.get();
      sGap.el.closest('.control').style.opacity = kind === 'mixture' ? 1 : 0.35;
      sW.el.closest('.control').style.opacity = kind === 'mixture' ? 1 : 0.35;
      sNu.el.closest('.control').style.opacity = kind === 'student_t' ? 1 : 0.35;
    }
    function draw() {
      const spec = specOf();
      const gRef = new M.Belief(cur.mean(), cur.stddev()); // identical μ AND σ — isolates shape
      const sg = cur.stddev(), c0 = cur.mean();
      const x0 = c0 - 4.2 * sg, x1 = c0 + 4.2 * sg;
      let pmax = 1e-9, fmax = 1e-9;
      for (let i = 0; i <= 220; i++) {
        const x = x0 + (i / 220) * (x1 - x0);
        pmax = Math.max(pmax, cur.pdf(x), gRef.pdf(x));
        fmax = Math.max(fmax, M.payoff(spec, x));
      }
      P.clear().domain(x0, x1, 0, pmax * 1.14);
      P.grid([x0, (x0 + x1) / 2, x1], [], { xfmt: (v) => fmt(v, 0) });
      // contract payoff, normalised into the plot (green) — the "market" context
      P.curve((x) => (M.payoff(spec, x) / fmax) * pmax * 0.9, 'rgba(52,211,153,0.5)', 1.3);
      // equal-(μ,σ) Gaussian reference (muted) vs the model belief (accent, filled)
      P.curve((x) => gRef.pdf(x), P.COL.muted, 1.5);
      P.area((x) => cur.pdf(x), 'rgba(91,157,255,0.12)');
      P.curve((x) => cur.pdf(x), P.COL.accent, 2.6);
      if (cur.kind === 'mixture') for (const c of cur.components) P.vline(c.mu, P.COL.accent, '', true);
      P.vline(c0, P.COL.buy, 'μ', true);
      P.vline(sK.get(), P.COL.warn, 'K');
      const fairM = M.priceAny(spec, cur), fairG = M.price(spec, gRef);
      const diff = fairG !== 0 ? ((fairM - fairG) / Math.abs(fairG)) * 100 : 0;
      out.innerHTML =
        cell('mean μ', fmt(cur.mean(), 2)) + cell('σ (std-dev)', fmt(cur.stddev(), 2)) +
        cell('Fair — this model', fmt(fairM, 4), 'accent') +
        cell('Fair — Gaussian(μ,σ)', fmt(fairG, 4)) +
        cell('model vs Gaussian', (diff >= 0 ? '+' : '') + fmt(diff, 1) + '%', Math.abs(diff) > 1 ? 'warn' : '') +
        cell('belief shape', shapeNote());
      relevance();
    }
    function rebuild() { cur = prior(); draw(); }
    [kindSeg, sMu, sSg, sGap, sW, sNu].forEach((c) => c.on(rebuild));
    [cSeg, sK].forEach((c) => c.on(draw));
    $('#bm-buy', btns).onclick = () => commit('buy');
    $('#bm-sell', btns).onclick = () => commit('sell');
    $('#bm-reset', btns).onclick = () => rebuild();
    redraws.push(draw); draw();
  }

  function vizFlexBeliefs() {
    const root = $('#viz-flex'); if (!root) return;
    const MM = window.MMODEL; if (!MM) return;
    const cv = $('canvas', root), controls = $('.controls', root), out = $('.readout', root);
    const P = Plot(cv);

    const famSeg = seg(controls, {
      label: 'Belief family  ·  (⛓ on-chain-feasible, ★ off-chain)', value: 'basis',
      options: [
        { label: 'Gaussian', value: 'gaussian' },
        { label: 'Skew', value: 'skew_normal' },
        { label: 'Gen-norm', value: 'gen_normal' },
        { label: 'Student-t', value: 'student_t' },
        { label: 'Beta', value: 'beta' },
        { label: 'Mixture', value: 'mixture' },
        { label: 'Gen·basis ⛓', value: 'basis' },
        { label: 'Gen·exact ★', value: 'maxent' },
      ],
    });
    const sMu = slider(controls, { label: 'center', min: 60, max: 140, step: 0.5, value: 100 });
    const sScale = slider(controls, { label: 'width σ', min: 3, max: 32, step: 0.5, value: 12 });
    const sSkew = slider(controls, { label: 'α — skew (skew · general)', min: -14, max: 14, step: 0.5, value: 5 });
    const sPeak = slider(controls, { label: 'β — peak↔flat (gen-normal)', min: 0.3, max: 10, step: 0.1, value: 1.3, fmt: (v) => fmt(v, 1) });
    const sNu = slider(controls, { label: 'ν — d.o.f. (Student-t)', min: 2.2, max: 80, step: 0.5, value: 5, fmt: (v) => fmt(v, 1) });
    const sA = slider(controls, { label: 'a (Beta)', min: 0.2, max: 14, step: 0.1, value: 2, fmt: (v) => fmt(v, 1) });
    const sB = slider(controls, { label: 'b (Beta)', min: 0.2, max: 14, step: 0.1, value: 5, fmt: (v) => fmt(v, 1) });
    const sModes = slider(controls, { label: 'peaks / camps (mixture · basis)', min: 1, max: 9, step: 1, value: 3, fmt: (v) => fmt(v, 0) });
    const sSpread = slider(controls, { label: 'separation / spread (mixture · basis)', min: 0, max: 46, step: 1, value: 22, fmt: (v) => fmt(v, 0) });
    const sWell = slider(controls, { label: 'λ₂ — well depth (Gen·exact): <0 ⇒ bimodal', min: -4, max: 4, step: 0.1, value: 1, fmt: (v) => fmt(v, 1) });
    const sQuart = slider(controls, { label: 'λ₄ — fat tails ↔ flat-top (Gen·exact)', min: 0, max: 1.6, step: 0.05, value: 0, fmt: (v) => fmt(v, 2) });

    function build() {
      const mu = sMu.get(), sg = sScale.get(), fam = famSeg.get();
      switch (fam) {
        case 'skew_normal': return MM.skewNormal(mu, sg, sSkew.get());
        case 'gen_normal': return MM.genNormal(mu, sg, sPeak.get());
        case 'student_t': return M.StudentT.fromVariance(sNu.get(), mu, sg * sg);
        case 'beta': return MM.betaScaled(mu - 3 * sg, mu + 3 * sg, sA.get(), sB.get());
        case 'mixture': return MM.fewCamps(mu, sSpread.get(), sModes.get(), sg);
        case 'basis': { const half = sSpread.get() + 16; return MM.fixedBasis(mu - half, mu + half, 27, sModes.get(), sg / 12, sSkew.get() / 14); }
        case 'maxent': return MM.maxEnt(mu, sg, sWell.get(), sSkew.get() / 40, sQuart.get());
        default: return new M.Belief(mu, sg);
      }
    }
    function relevance() {
      const f = famSeg.get();
      const dim = (ctl, on) => { ctl.el.closest('.control').style.opacity = on ? 1 : 0.32; };
      dim(sSkew, f === 'skew_normal' || f === 'maxent' || f === 'basis');
      dim(sPeak, f === 'gen_normal'); dim(sNu, f === 'student_t');
      dim(sA, f === 'beta'); dim(sB, f === 'beta');
      dim(sModes, f === 'mixture' || f === 'basis');
      dim(sSpread, f === 'mixture' || f === 'basis');
      dim(sWell, f === 'maxent'); dim(sQuart, f === 'maxent');
    }
    function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }

    function draw() {
      const b = build();
      const meta = MM.META[famSeg.get()];
      const mean = b.mean(), sd = b.stddev();
      const x0 = b.lo != null ? b.lo : mean - 4 * sd;
      const x1 = b.hi != null ? b.hi : mean + 4 * sd;
      const gRef = new M.Belief(mean, sd);
      let pmax = 1e-9;
      for (let i = 0; i <= 240; i++) { const x = x0 + (i / 240) * (x1 - x0); pmax = Math.max(pmax, b.pdf(x), gRef.pdf(x)); }
      P.clear().domain(x0, x1, 0, pmax * 1.14);
      P.grid([x0, (x0 + x1) / 2, x1], [], { xfmt: (v) => fmt(v, 0) });
      P.curve((x) => gRef.pdf(x), P.COL.muted, 1.5);          // equal-(μ,σ) Gaussian reference
      P.area((x) => b.pdf(x), 'rgba(91,157,255,0.12)');
      P.curve((x) => b.pdf(x), P.COL.accent, 2.6);            // the candidate family
      P.vline(mean, P.COL.buy, 'μ', true);
      const K = mean + 1.5 * sd;
      P.vline(K, P.COL.warn, 'K');
      const fair = MM.priceFlex({ type: 'BINARY_CALL', strike: K }, b);
      // Compact, grouped scorecard (overrides the default 2-col readout grid so the
      // long descriptive values don't blow up into giant wrapped mono text).
      out.style.display = 'block';
      const onWarn = /hard|very|infeasible/.test(meta.on);
      const onGood = /feasible|shipped|^low|moderate/.test(meta.on);
      const row = (k, v, col) =>
        `<div class="k" style="align-self:center">${k}</div>`
        + `<div style="font-size:.84rem;font-weight:500;line-height:1.25${col ? `;color:${col}` : ''}">${v}</div>`;
      const grp = (t) =>
        `<div style="grid-column:1/-1;font-size:.6rem;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);opacity:.7;margin-top:.55rem;padding-top:.3rem;border-top:1px solid var(--edge)">${t}</div>`;
      out.innerHTML =
        '<div style="display:grid;grid-template-columns:7rem 1fr;gap:.26rem .8rem;align-items:baseline">'
        + grp('Shape')
        + row('Flexibility', stars(meta.flex), 'var(--accent)')
        + row('Shape DOF', meta.dof)
        + row('Makes', meta.shapes)
        + grp('Engine')
        + row('Pricing', meta.price)
        + row('Update', meta.update)
        + row('Tail&#8209;binary fair', fmt(fair, 4))
        + grp('Implementation')
        + row('Off&#8209;chain', meta.off)
        + row('On&#8209;chain', meta.on, onWarn ? 'var(--warn)' : onGood ? 'var(--buy)' : '')
        + '</div>';
      relevance();
    }
    [famSeg, sMu, sScale, sSkew, sPeak, sNu, sA, sB, sModes, sSpread, sWell, sQuart].forEach((c) => c.on(draw));
    redraws.push(draw); draw();
  }

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
    // Build the bar rows once; draw only updates widths/values so CSS can
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

  // Same probe (Bin·Call @ μ, so price = P(θ≥K) ∈ [0,1]); each chart
  // isolates one lever of ΔFair ≈ (∂P/∂μ)·Δμ, driven by ι = |q|/Q_max.
  function vizImpact() {
    const root = $('#viz-impact'); if (!root) return;
    const MU = 100, SG = 12, BASE_Q = 500;        // market N(100,12²), baseline depth
    const base = () => new M.Belief(MU, SG);
    const cfgWith = (qMax) => M.makeEngineConfig(MU, SG, { qMax });
    const spec = { type: 'BINARY_CALL', strike: MU }; // fair reads as a probability
    const fair0 = M.price(spec, base());           // = 0.50

    const sideSeg = seg($('.impact-controls', root), {
      label: 'Trade side — drives all three charts', value: 'buy',
      options: [{ label: 'Buy ▲', value: 'buy' }, { label: 'Sell ▼', value: 'sell' }],
    });

    const POPT = { w: 340, h: 300, pad: { l: 38, r: 12, t: 14, b: 30 } };
    const P1 = Plot($('#impact-amt canvas', root), POPT), o1 = $('#impact-amt .readout', root);
    const P2 = Plot($('#impact-cnt canvas', root), POPT), o2 = $('#impact-cnt .readout', root);
    const P3 = Plot($('#impact-lp canvas', root), POPT), o3 = $('#impact-lp .readout', root);
    const YT = [0, 0.25, 0.5, 0.75, 1], yfmt = (v) => fmt(v, 2);

    // one trade of size q (signed) → fair price on the post-trade belief
    function fairAfter(q, cfg) {
      const sig = M.extractSignal(spec, q, base(), cfg);
      return M.price(spec, M.bayesUpdate(base(), sig.signal, sig.weight, cfg));
    }

    function draw() {
      const buy = sideSeg.get() === 'buy', sgn = buy ? 1 : -1;
      const col = buy ? P1.COL.buy : P1.COL.sell;
      const tone = buy ? 'buy' : 'sell';
      const cfg = cfgWith(BASE_Q);

      P1.clear().domain(0, BASE_Q, 0, 1);
      P1.grid([0, 250, 500], YT, { xfmt: (v) => fmt(v, 0), yfmt });
      P1.hline(fair0, P1.COL.muted, '', true);
      P1.curve((q) => (q <= 0 ? fair0 : fairAfter(sgn * q, cfg)), col, 2.4, 90);
      const qm = 150, pm = fairAfter(sgn * qm, cfg);
      P1.vline(qm, P1.COL.faint, '', true); P1.dot(qm, pm, col, 4);
      o1.innerHTML = cell('price @150u', fmt(pm, 3), tone) + cell('Δ from 0.50', fmtS(pm - fair0, 3));

      const Q2 = 120, NMAX = 24;
      let bel = base(); const seq = [fair0];
      for (let n = 1; n <= NMAX; n++) {
        const sig = M.extractSignal(spec, sgn * Q2, bel, cfg);
        bel = M.bayesUpdate(bel, sig.signal, sig.weight, cfg);
        seq.push(M.price(spec, bel));
      }
      P2.clear().domain(0, NMAX, 0, 1);
      P2.grid([0, 8, 16, 24], YT, { xfmt: (v) => fmt(v, 0), yfmt });
      P2.hline(fair0, P2.COL.muted, '', true);
      P2.curve((x) => { const i = Math.floor(x), t = x - i; return i >= NMAX ? seq[NMAX] : seq[i] * (1 - t) + seq[i + 1] * t; }, col, 2.4, 96);
      seq.forEach((p, n) => P2.dot(n, p, col, 2.2));
      o2.innerHTML = cell('after 24× 120u', fmt(seq[NMAX], 3), tone) + cell('per-trade now', fmtS(seq[NMAX] - seq[NMAX - 1], 4));

      // ③ price impact vs liquidity (LP → depth Q ≈ 0.5·LP) ---------------
      const QF = 150, LP0 = 200, LP1 = 4000;
      const f3 = (lp) => fairAfter(sgn * QF, cfgWith(Math.max(20, BASE_Q * lp / 1000)));
      P3.clear().domain(LP0, LP1, 0, 1);
      P3.grid([LP0, 2000, LP1], YT, { xfmt: (v) => fmt(v, 0), yfmt });
      P3.hline(fair0, P3.COL.muted, '', true);
      P3.curve(f3, col, 2.4, 90);
      P3.vline(1000, P3.COL.faint, 'base', true); P3.dot(1000, f3(1000), col, 4);
      o3.innerHTML = cell('@thin (LP 400)', fmt(f3(400), 3), tone) + cell('@deep (LP 4k)', fmt(f3(LP1), 3), tone);
    }
    sideSeg.on(draw); redraws.push(draw); draw();
  }

  function vizMechCompare() {
    const root = $('#viz-mech'); if (!root) return;
    const MU = 100, SG = 12, K = 100, spec = { type: 'BINARY_CALL', strike: K };
    const base = () => new M.Belief(MU, SG);
    const XMAX = 1200;                              // fixed x-axis so liquidity-flattening is visible
    const sig = (z) => 1 / (1 + Math.exp(-z));

    const ctrls = $('.impact-controls', root);
    const sLiq = slider(ctrls, { label: 'Liquidity — LP capital (scales every mechanism)', min: 400, max: 4000, step: 50, value: 1500, fmt: (v) => fmt(v, 0) });
    const sQ = slider(ctrls, { label: 'Trade size — reference order (shares)', min: 50, max: XMAX, step: 10, value: 400, fmt: (v) => fmt(v, 0) });

    const POPT = { w: 360, h: 300, pad: { l: 40, r: 12, t: 14, b: 30 } };
    const PI = Plot($('#mech-impact canvas', root), POPT), oI = $('#mech-impact .readout', root);
    const PS = Plot($('#mech-slip canvas', root), POPT), oS = $('#mech-slip .readout', root);
    const YT = [0, 0.25, 0.5, 0.75, 1];

    // matched-liquidity mappings (canonical depth ∝ L; ratios tuned so initial slopes line up)
    const params = (L) => ({ Q: 2 * L, b: 2 * L, R: 2 * L, rho: 8 * L });
    // marginal price after buying x shares ---
    function bmmImpact(x, Q) { const c = M.makeEngineConfig(MU, SG, { qMax: Q }); const s = M.extractSignal(spec, x, base(), c); return M.price(spec, M.bayesUpdate(base(), s.signal, s.weight, c)); }
    const lmsrImpact = (x, b) => sig(x / b);
    function cpmmT(x, R) { return ((x - 2 * R) + Math.sqrt(x * x + 4 * R * R)) / 2; }
    function cpmmImpact(x, R) { const t = cpmmT(x, R); const u = (R + t) * (R + t); return u / (R * R + u); }
    const bookImpact = (x, rho) => Math.min(1, 0.5 + x / rho);
    // premium over mid to FILL x shares (slippage) ---
    function bmmSlip(x, Q) { const c = M.makeEngineConfig(MU, SG, { qMax: Q }); return M.computeSpread(spec, x, 0, base(), c).total; }
    const lmsrSlip = (x, b) => (x < 1 ? 0 : (b * Math.log(Math.exp(x / b) + 1) - b * Math.LN2) / x - 0.5);
    const cpmmSlip = (x, R) => (x < 1 ? 0 : cpmmT(x, R) / x - 0.5);
    const bookSlip = (x, rho) => Math.min(0.5, x / (2 * rho));

    function draw() {
      const L = sLiq.get(), p = params(L), qm = sQ.get();
      const cA = PI.COL.accent, cW = PI.COL.warn, cB = PI.COL.buy, cS = PI.COL.sell;

      PI.clear().domain(0, XMAX, 0, 1);
      PI.grid([0, 400, 800, 1200], YT, { xfmt: (v) => fmt(v, 0), yfmt: (v) => fmt(v, 2) });
      PI.hline(0.5, PI.COL.muted, '', true);
      PI.curve((x) => bookImpact(x, p.rho), cS, 2, 90);
      PI.curve((x) => lmsrImpact(x, p.b), cW, 2, 90);
      PI.curve((x) => cpmmImpact(x, p.R), cB, 2, 90);
      PI.curve((x) => bmmImpact(x, p.Q), cA, 2.6, 90);
      PI.vline(qm, PI.COL.faint, '', true);
      oI.innerHTML =
        cell('BMM @' + fmt(qm, 0), fmt(bmmImpact(qm, p.Q), 3), 'accent') +
        cell('LMSR', fmt(lmsrImpact(qm, p.b), 3)) +
        cell('CPMM', fmt(cpmmImpact(qm, p.R), 3), 'buy') +
        cell('Order book', fmt(bookImpact(qm, p.rho), 3), 'sell');

      let smax = 1e-3;
      for (let i = 1; i <= 60; i++) { const x = (i / 60) * XMAX; smax = Math.max(smax, bmmSlip(x, p.Q), lmsrSlip(x, p.b), cpmmSlip(x, p.R), bookSlip(x, p.rho)); }
      smax = Math.min(0.5, smax) * 1.12;
      PS.clear().domain(0, XMAX, 0, smax);
      PS.grid([0, 400, 800, 1200], [0, smax / 2, smax], { xfmt: (v) => fmt(v, 0), yfmt: (v) => fmt(v, 3) });
      PS.curve((x) => bookSlip(x, p.rho), cS, 2, 90);
      PS.curve((x) => lmsrSlip(x, p.b), cW, 2, 90);
      PS.curve((x) => cpmmSlip(x, p.R), cB, 2, 90);
      PS.curve((x) => bmmSlip(x, p.Q), cA, 2.6, 90);
      PS.vline(qm, PS.COL.faint, '', true);
      oS.innerHTML =
        cell('BMM spread', fmt(bmmSlip(qm, p.Q), 4), 'accent') +
        cell('LMSR', fmt(lmsrSlip(qm, p.b), 4)) +
        cell('CPMM', fmt(cpmmSlip(qm, p.R), 4), 'buy') +
        cell('Order book', fmt(bookSlip(qm, p.rho), 4), 'sell');
    }
    [sLiq, sQ].forEach((c) => c.on(draw)); redraws.push(draw); draw();
  }

  function vizUserPrice() {
    const root = $('#u-viz-price'); if (!root) return;
    const cv = $('canvas', root), controls = $('.controls', root), out = $('.readout', root);
    const P = Plot(cv);
    const sMu = slider(controls, { label: "Market's best guess", min: 60, max: 140, step: 0.5, value: 100, fmt: (v) => fmt(v, 0) });
    const sK = slider(controls, { label: 'Your line', min: 60, max: 140, step: 1, value: 108, fmt: (v) => fmt(v, 0) });
    const SG = 12; // a fixed, representative uncertainty — users don't tune it here
    function draw() {
      const mu = sMu.get(), K = sK.get(), b = new M.Belief(mu, SG);
      const x0 = mu - 4 * SG, x1 = mu + 4 * SG, ymax = b.pdf(mu) * 1.15;
      P.clear().domain(x0, x1, 0, ymax);
      P.grid([mu - 3 * SG, mu, mu + 3 * SG], [], { xfmt: (v) => fmt(v, 0) });
      P.area((x) => b.pdf(x), 'rgba(91,157,255,0.10)');
      // shade the "above the line" mass — this area IS the Yes price
      P.areaBetween(K, x1, (x) => b.pdf(x), tintBuyStrong(), 240);
      P.curve((x) => b.pdf(x), P.COL.accent, 2.4);
      P.vline(K, P.COL.buy, 'line', true);
      const chance = M.price({ type: 'BINARY_CALL', strike: K }, b); // = P(θ ≥ K)
      out.innerHTML =
        cell('Chance above the line', fmt(chance * 100, 1) + '%', 'buy') +
        cell('"Yes" price', fmt(chance, 2), 'accent') +
        cell('"No" price', fmt(1 - chance, 2)) +
        cell('Read it as', chance >= 0.5 ? 'likely' : 'unlikely');
    }
    sMu.on(draw); sK.on(draw); redraws.push(draw); draw();
  }
  // live read of the strong buy tint so the shaded "above" area repaints on theme switch
  function tintBuyStrong() { return getComputedStyle(document.documentElement).getPropertyValue('--tint-buy-strong').trim(); }

  function vizUserTrade() {
    const root = $('#u-viz-trade'); if (!root) return;
    const panel = $('.u-trade-panel', root), controls = $('.controls', root), out = $('.readout', root);
    const b = new M.Belief(100, 12);            // a live market: best guess 100
    const cfg = M.makeEngineConfig(100, 12);
    const spec = { type: 'CALL', strike: 100 }; // "betting it finishes above 100"
    const sideSeg = seg(controls, { label: 'Your trade', value: 'buy', options: [{ label: 'Buy ▲', value: 'buy' }, { label: 'Sell ▼', value: 'sell' }] });
    const sQ = slider(controls, { label: 'How many units', min: 1, max: 500, step: 1, value: 120, fmt: (v) => fmt(v, 0) });
    panel.innerHTML =
      '<div class="u-row"><span class="u-lab">Price you ' + '<b data-verb></b>' + '<span class="u-sub">per unit</span></span><span class="u-big" data-exec>—</span></div>' +
      '<div class="u-row"><span class="u-lab">Fair value <span class="u-sub">before the fee</span></span><span class="u-big accent" data-fair>—</span></div>' +
      '<div class="u-row"><span class="u-lab">Spread <span class="u-sub">the maker\'s fee</span></span><span class="u-big" data-spread>—</span></div>' +
      '<div class="u-move"><span>Market\'s guess</span><span class="u-arrow">→</span><span data-move>—</span></div>';
    const el = (s) => $(s, panel);
    function draw() {
      const side = sideSeg.get(), buy = side === 'buy';
      const q = (buy ? 1 : -1) * sQ.get();
      const s = M.computeSpread(spec, q, 0, b, cfg);
      const exec = M.execPriceFor(buy ? 'buy' : 'sell', s.fair, s.total);
      const sig = M.extractSignal(spec, q, b, cfg);
      const post = M.bayesUpdate(b, sig.signal, sig.weight, cfg);
      el('[data-verb]').textContent = buy ? 'pay' : 'get';
      const execEl = el('[data-exec]'); execEl.textContent = fmt(exec, 2); execEl.className = 'u-big ' + (buy ? 'buy' : 'sell');
      el('[data-fair]').textContent = fmt(s.fair, 2);
      el('[data-spread]').textContent = '+' + fmt(s.total, 2);
      el('[data-move]').textContent = fmt(b.mu, 1) + '  →  ' + fmt(post.mu, 1);
      out.innerHTML =
        cell(buy ? 'You pay in total' : 'You receive in total', fmt(Math.abs(exec * q), 2), buy ? 'sell' : 'buy') +
        cell('Fee as % of fair', (s.fair ? fmt((s.total / Math.abs(s.fair)) * 100, 1) : '—') + '%') +
        cell('New market guess', fmt(post.mu, 2), 'accent') +
        cell('You moved it by', fmtS(post.mu - b.mu, 2));
    }
    [sideSeg, sQ].forEach((c) => c.on(draw)); redraws.push(draw); draw();
  }

  function modeSwitch() {
    const root = document.documentElement;
    const wrap = $('#mode-switch');
    if (!wrap) return;
    const reveal = (m) => $$('.mode-' + m + ' section, .mode-' + m + ' .hero').forEach((el) => el.classList.add('in'));
    reveal(root.getAttribute('data-mode') || 'user');
    $$('.ms-btn', wrap).forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = btn.getAttribute('data-mode');
        if (root.getAttribute('data-mode') === m) return;
        root.setAttribute('data-mode', m);
        try { localStorage.setItem('bmm-mode', m); } catch (e) {}
        reveal(m);
        window.scrollTo({ top: 0 });
        // repaint canvases now visible with correct layout/palette
        redraws.forEach((fn) => { try { fn(); } catch (e) {} });
        const p = $('#progress'); if (p) p.style.width = '0%';
      });
    });
  }

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

  function boot() {
    renderMath();
    scrollspy();
    theme();
    modeSwitch();
    progress();
    vizBelief(); vizBeliefModels(); vizFlexBeliefs(); vizPricing(); vizBayes(); vizSpread(); vizReserve(); vizLp();
    vizImpact(); vizMechCompare();
    vizUserPrice(); vizUserTrade();
    reveal();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
