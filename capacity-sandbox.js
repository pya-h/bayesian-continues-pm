/* ============================================================================
   capacity-sandbox.js — the DOM/rendering layer of the "market at the gate"
   sandbox. It boots a market into the solvency-gate "no-buy band", then lets you
   apply each capacity fix (A–I from docs/capacity/expanding-capacity.md) and
   watch — live — how it changes the gate, the price ramp, the pool stats, the
   payouts, and the positions.

   ALL math lives in capacity-engine.js (CapEngine.makeCapEngine), which is built
   on window.BMM (math.js, a direct port of packages/core). This file owns only
   the page: controls, canvases, tables, and status text. Keeping the two split
   means the test suite can drive the identical engine headlessly and prove the
   sandbox computes exactly what the server does.

   Fix coverage (per the design decision): A,B,C,D,E,G fully live; F a tagged
   approximation; H,I explained (they redefine the product/menu, so they can't be
   simulated by mutating this one book).
   ========================================================================== */
(function () {
  'use strict';
  const M = window.BMM;
  const root = document.getElementById('cap-sandbox');
  if (!M || !root || !window.CapEngine) return;

  const CAP = window.CapEngine.makeCapEngine(M);
  const {
    CROWD_SPEC, CROWD_KEY, GENESIS_BELIEF, cfg,
    keyOf, specLabel, FIXES, FIX_ORDER, paramVals, modifierFor,
    backing, reserveMod, mmOf, withMm, quoteBuy, solveFill,
    stepBuy, buildTape, replay, gateInfo, marginalAsk,
  } = CAP;

  /* ---- UI helpers ------------------------------------------------------- */
  const $ = (s, r) => (r || root).querySelector(s);
  const $$ = (s, r) => Array.from((r || root).querySelectorAll(s));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const fmt = (n, d = 2) =>
    !isFinite(n) ? '∞' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = (n, d = 0) => (n < 0 ? '−$' : '$') + fmt(Math.abs(n), d);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  /* ======================================================================
     RENDERING
     ====================================================================== */
  let TAPE = [];
  let STATE = null;
  let curFix = 'none';
  let builtCash = 5000;
  // live buy-contract selection
  let buyType = 'CALL';
  let buyK = 100;
  let buyW = 8;
  function buySpec() {
    if (buyType === 'LINEAR') return { type: 'LINEAR' };
    if (buyType === 'SPREAD') return { type: 'SPREAD', lower: buyK - buyW, upper: buyK + buyW };
    if (buyType === 'GAUSSIAN') return { type: 'GAUSSIAN', center: buyK, width: buyW };
    return { type: buyType, strike: buyK };
  }
  const activeMod = () => modifierFor(curFix === 'none' || FIXES[curFix].explainOnly ? 'none' : curFix);

  function gateLine(st, mod) {
    const g = gateInfo(st, mod);
    const status = mod.haircut
      ? { cls: 'warn', txt: 'OPEN — no gate; winning payouts scaled by s' }
      : g.blocked
        ? { cls: 'sell', txt: mod.soft ? 'AT BACKSTOP — congestion priced, hard floor reached' : 'BLOCKED — risk-opening buys rejected (offsetting trades & sells still fill)' }
        : { cls: 'buy', txt: mod.soft ? 'OPEN — soft cap pricing the approach' : 'OPEN — buys admitted' };
    return { R: g.R, cashB: g.cashB, rho: g.rho, m: g.m, status };
  }

  function statCells(st, mod, g) {
    const spec = buySpec();
    const f = M.price(spec, st.belief);
    const dF = f - M.price(spec, GENESIS_BELIEF);
    const congNow = mod.soft ? quoteBuy(spec, keyOf(spec), 1, st, mod).congestion : 0;
    const cells = [
      ['μ — belief mean', fmt(st.belief.mu, 2), ''],
      ['σ — uncertainty', fmt(st.belief.sigma, 2), ''],
      ['Fair · ' + specLabel(spec), fmt(f, 3) + '  (' + (dF >= 0 ? '+' : '−') + fmt(Math.abs(dF), 3) + ')', 'accent'],
      ['Pool cash' + (mod.extraCash ? ' (+fund)' : ''), money(g.cashB), ''],
      ['Required reserve (' + (mod.alpha * 100).toFixed(0) + '%)' + (mod.reserveScale < 1 ? ' ×hedge' : ''), money(g.R), 'sell'],
      ['Utilisation ρ = R∕cash', fmt(g.rho, 3) + (mod.haircut ? '' : '  (gate ≤ ' + fmt(1 / g.m, 2) + ')'), g.rho > 1 ? 'sell' : g.rho > 1 / Math.max(g.m, 1e-9) ? 'warn' : 'buy'],
      ['MM short · CALL 100', fmt(mmOf(st.book, CROWD_KEY), 1) + ' (the crowd)', ''],
      ['Congestion (next unit)', mod.soft ? fmt(congNow, 3) : '—', mod.soft ? 'warn' : ''],
    ];
    let html = '';
    for (const [k, v, tone] of cells) html += '<div><div class="k">' + k + '</div><div class="v ' + tone + '">' + v + '</div></div>';
    return { html, spec, f };
  }

  function payoutBox(st, mod, spec) {
    const f = M.price(spec, st.belief);
    const thetaA = st.belief.mu + st.belief.sigma * M.normInv(mod.alpha);
    const perMax = M.payoff(spec, thetaA); // worst-case (α) payout / contract of the selected bet
    const W = reserveMod(st.book, st.belief, mod); // worst-case owed (book)
    const expectOwed = M.expectedLiability(st.book, st.belief);
    const sFac = mod.haircut ? Math.min(1, st.cash / Math.max(W, 1e-9)) : 1;
    const rows = [
      ['Expected payout / contract', fmt(f, 3), 'E[ payoff ] of ' + specLabel(spec) + ' = fair'],
      ['Worst-case (' + (mod.alpha * 100).toFixed(0) + '%) / contract', fmt(perMax, 3), 'payoff at the tail outcome'],
      ['Total expected owed (book)', money(expectOwed), 'Σ mmShort × fair'],
      ['Total worst-case owed', money(W), '= the reserve'],
    ];
    let body = '';
    for (const [k, v, note] of rows) body += '<tr><td>' + k + '</td><td class="num">' + v + '</td><td class="muted">' + note + '</td></tr>';
    const sCls = sFac < 0.999 ? 'sell' : 'buy';
    const sNote = mod.haircut
      ? sFac < 0.999 ? 'pool is short: winners receive ' + (sFac * 100).toFixed(1) + '% of face' : 'fully backed right now — keep buying to push it below 1'
      : 'fully backed — payouts are not contingent';
    body += '<tr class="srow"><td>Solvency factor s (' + (mod.alpha * 100).toFixed(0) + '% scenario)</td><td class="num ' + sCls + '">' + fmt(sFac, 3) + '</td><td class="muted">' + sNote + '</td></tr>';
    return { html: '<table class="cap-pay"><tbody>' + body + '</tbody></table>', sFac };
  }

  function positionsTable(st, mod, sFac) {
    let rows = '';
    let tQ = 0;
    st.pos.forEach((p) => {
      if (p.qty <= 1e-6) return;
      tQ += p.qty;
      const px = M.price(p.spec, st.belief);
      const val = p.qty * px;
      const pnl = p.qty * (px - p.avg);
      const proj = mod.haircut ? p.qty * px * sFac : null;
      rows +=
        '<tr><td>' + (p.trader === 'You' ? '<strong>You</strong>' : p.trader) + '</td>' +
        '<td class="cap-ct">' + specLabel(p.spec) + '</td>' +
        '<td class="num">' + fmt(p.qty, 1) + '</td>' +
        '<td class="num">' + fmt(p.avg, 3) + '</td>' +
        '<td class="num">' + money(val, 0) + '</td>' +
        '<td class="num ' + (pnl >= 0 ? 'buy' : 'sell') + '">' + (pnl >= 0 ? '+' : '−') + money(Math.abs(pnl), 0) + '</td>' +
        (mod.haircut ? '<td class="num ' + (proj < val - 1e-6 ? 'sell' : '') + '">' + money(proj, 0) + '</td>' : '') +
        '</tr>';
    });
    if (!rows) rows = '<tr><td colspan="7" class="muted">no open positions</td></tr>';
    const head =
      '<tr><th>Trader</th><th>Contract</th><th class="num">Qty</th><th class="num">Avg</th><th class="num">Value</th><th class="num">Unreal. P&L</th>' +
      (mod.haircut ? '<th class="num">If resolved now</th>' : '') + '</tr>';
    const foot = '<tr class="trow"><td>book</td><td></td><td class="num">' + fmt(tQ, 1) + '</td><td></td><td></td><td></td>' + (mod.haircut ? '<td></td>' : '') + '</tr>';
    const forced = st.forced > 1e-6 ? '<p class="cap-forced">⚠ auto-deleverage force-closed ' + fmt(st.forced, 1) + ' CALL contracts from holders to reclaim capacity.</p>' : '';
    return '<table class="cap-pos"><thead>' + head + '</thead><tbody>' + rows + foot + '</tbody></table>' + forced;
  }

  /* ---- tiny canvas plotter --------------------------------------------- */
  function plot(canvas, draw) {
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(280, rect.width || canvas.clientWidth || 360);
    const H = canvas.dataset.h ? +canvas.dataset.h : 200;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
    draw(ctx, W, H);
  }

  function drawBelief(st, mod) {
    const cv = $('#cap-cv-belief', root);
    if (!cv) return;
    const spec = buySpec();
    plot(cv, (ctx, W, H) => {
      const b = st.belief;
      const x0 = b.mu - 4 * b.sigma, x1 = b.mu + 4 * b.sigma;
      const pad = { l: 8, r: 8, t: 16, b: 18 };
      const ymax = b.pdf(b.mu) * 1.15;
      const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
      const Y = (y) => H - pad.b - (y / ymax) * (H - pad.t - pad.b);
      const accent = css('--accent'), buy = css('--buy'), sell = css('--sell'), faint = css('--faint'), warn = css('--warn');
      // region where the SELECTED bet pays out (where its buyer wins)
      ctx.fillStyle = buy; ctx.globalAlpha = 0.16;
      ctx.beginPath(); let open = false;
      for (let i = 0; i <= 200; i++) {
        const x = x0 + (i / 200) * (x1 - x0);
        if (M.payoff(spec, x) > 1e-9) { if (!open) { ctx.moveTo(X(x), Y(0)); open = true; } ctx.lineTo(X(x), Y(b.pdf(x))); }
        else if (open) { ctx.lineTo(X(x), Y(0)); open = false; }
      }
      if (open) ctx.lineTo(X(x1), Y(0));
      ctx.fill(); ctx.globalAlpha = 1;
      // belief curve
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i <= 200; i++) { const x = x0 + (i / 200) * (x1 - x0); const px = X(x), py = Y(b.pdf(x)); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      ctx.stroke();
      const vline = (x, col, lab) => {
        if (x < x0 || x > x1) return;
        ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(X(x), pad.t); ctx.lineTo(X(x), H - pad.b); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText(lab, X(x), pad.t - 4);
      };
      const Kmark = spec.type === 'LINEAR' ? null : spec.type === 'SPREAD' ? (spec.lower + spec.upper) / 2 : spec.type === 'GAUSSIAN' ? spec.center : spec.strike;
      vline(b.mu, buy, 'μ');
      if (Kmark != null) vline(Kmark, sell, 'K');
      const thetaA = b.mu + b.sigma * M.normInv(mod.alpha);
      vline(thetaA, warn, (mod.alpha * 100).toFixed(0) + '%');
      ctx.fillStyle = faint; ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'left';
      ctx.fillText('belief p(θ) · green = where your bet pays', pad.l + 2, H - 5);
    });
  }

  function drawRamp(st, mod) {
    const cv = $('#cap-cv-ramp', root);
    if (!cv) return;
    const spec = buySpec(), key = keyOf(spec);
    plot(cv, (ctx, W, H) => {
      const f0 = M.price(spec, st.belief);
      // marginal ask + admission for the (q+1)-th contract (size-1 quote on a book
      // grown by q) — this reflects the soft-cap congestion premium in the curve.
      const priceAt = (q) => marginalAsk(spec, key, q, st, mod);
      const admitAt = (q) => marginalAsk(spec, key, q, st, mod).admit;
      let wall = Infinity;
      if (!mod.haircut) {
        let lo = 0, hi = 8000;
        if (!admitAt(hi)) { for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (admitAt(mid)) lo = mid; else hi = mid; } wall = lo; }
      }
      const xMax = isFinite(wall) ? Math.max(wall * 1.25, 20) : Math.max(mmOf(st.book, key) * 0.8 + 50, 200);
      const N = 150;
      let yMax = Math.abs(f0) * 1.2 + 0.1;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const q = (i / N) * xMax;
        const Q = priceAt(q);
        const y = (Q.admit || mod.haircut) ? Q.exec : NaN;
        if (isFinite(y)) yMax = Math.max(yMax, y);
        pts.push([q, y]);
      }
      yMax = Math.min(yMax, Math.abs(f0) * 8 + 0.5);
      const pad = { l: 38, r: 10, t: 16, b: 22 };
      const X = (x) => pad.l + (x / xMax) * (W - pad.l - pad.r);
      const Y = (y) => H - pad.b - (clamp(y, 0, yMax) / yMax) * (H - pad.t - pad.b);
      const accent = css('--accent'), sell = css('--sell'), warn = css('--warn'), faint = css('--faint'), edge = css('--edge');
      ctx.strokeStyle = edge; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b); ctx.stroke();
      ctx.fillStyle = faint; ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'right'; ctx.fillText(fmt(yMax, 1), pad.l - 4, pad.t + 6); ctx.fillText(fmt(f0, 1), pad.l - 4, Y(f0));
      ctx.textAlign = 'center'; ctx.fillText('+contracts of ' + specLabel(spec) + ' →', (pad.l + W - pad.r) / 2, H - 5);
      ctx.strokeStyle = faint; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.l, Y(f0)); ctx.lineTo(W - pad.r, Y(f0)); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = mod.soft ? warn : accent; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.beginPath();
      let started = false;
      for (const [q, y] of pts) { if (!isFinite(y)) break; const px = X(q), py = Y(y); started ? ctx.lineTo(px, py) : ctx.moveTo(px, py); started = true; }
      ctx.stroke();
      if (isFinite(wall) && wall <= xMax) {
        ctx.strokeStyle = sell; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(X(wall), pad.t); ctx.lineTo(X(wall), H - pad.b); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = sell; ctx.textAlign = 'center'; ctx.fillText('wall', X(wall), pad.t + 2);
        ctx.globalAlpha = 0.1; ctx.fillRect(X(wall), pad.t, (W - pad.r) - X(wall), H - pad.b - pad.t); ctx.globalAlpha = 1;
      } else if (mod.haircut) {
        ctx.fillStyle = warn; ctx.textAlign = 'right'; ctx.fillText('no wall (haircut)', W - pad.r - 4, pad.t + 6);
      }
    });
  }

  /* ---- main render ------------------------------------------------------ */
  function render() {
    if (!STATE) return;
    const mod = activeMod();
    const fx = FIXES[curFix];
    const g = gateLine(STATE, mod);
    const sc = statCells(STATE, mod, g);
    const pay = payoutBox(STATE, mod, sc.spec);

    const banner = $('#cap-status', root);
    banner.className = 'cap-status ' + g.status.cls;
    banner.innerHTML = '<span class="dot"></span>' + g.status.txt;

    $('#cap-stats', root).innerHTML = sc.html;
    $('#cap-payout', root).innerHTML = pay.html;
    $('#cap-positions', root).innerHTML = positionsTable(STATE, mod, pay.sFac);

    const info = $('#cap-fix-info', root);
    let infoHtml = '<p>' + fx.blurb + '</p>';
    if (fx.approx) infoHtml += '<p class="cap-approx">⚠ Simplified model: a real hedge has basis &amp; counterparty risk; here it just scales the reserve by (1−h).</p>';
    if (fx.explainOnly) infoHtml += '<p class="cap-why">' + fx.why + '</p>';
    info.innerHTML = infoHtml;

    $('#cap-buy-btn', root).disabled = !!fx.explainOnly;
    $('#cap-buy-wrap', root).style.opacity = fx.explainOnly ? 0.45 : 1;

    drawBelief(STATE, mod);
    drawRamp(STATE, mod);
  }

  /* ---- actions ---------------------------------------------------------- */
  function selectFix(id) {
    curFix = id;
    $$('.cap-fix-btn', root).forEach((b) => b.classList.toggle('active', b.dataset.fix === id));
    const host = $('#cap-fix-params', root);
    host.innerHTML = '';
    (FIXES[id].params || []).forEach((p) => {
      const wrap = document.createElement('div');
      wrap.className = 'control';
      wrap.innerHTML = '<div class="row"><label>' + p.label + '</label><span class="val"></span></div><input type="range" min="' + p.min + '" max="' + p.max + '" step="' + p.step + '" value="' + paramVals[id][p.key] + '">';
      host.appendChild(wrap);
      const input = wrap.querySelector('input'), val = wrap.querySelector('.val');
      const show = () => (val.textContent = p.fmt(parseFloat(input.value)));
      show();
      input.addEventListener('input', () => { paramVals[id][p.key] = parseFloat(input.value); show(); applyFix(); });
    });
    applyFix();
  }
  function applyFix() {
    const cash0 = STATE ? STATE.cash0 : builtCash;
    STATE = replay(TAPE, cash0, curFix === 'none' || FIXES[curFix].explainOnly ? modifierFor('none') : modifierFor(curFix));
    render();
  }
  function doBuy() {
    if (!STATE || FIXES[curFix].explainOnly) return;
    const size = clamp(parseFloat($('#cap-buy-size', root).value) || 0, 0, 5000);
    if (size <= 0) return;
    const mod = activeMod();
    const r = stepBuy(STATE, buySpec(), size, 'You', mod);
    const out = $('#cap-buy-out', root);
    if (!r.fill || r.fill <= 1e-6) {
      out.className = 'cap-buy-out sell';
      out.textContent = 'Rejected — ' + (mod.soft ? 'at the hard backstop' : 'no-buy band: this risk-opening buy needs cash ≥ ' + fmt(mod.margin, 2) + '×reserve.');
    } else {
      out.className = 'cap-buy-out buy';
      const part = r.fill < size * (1 - 1e-3) ? ' (sized down from ' + fmt(size, 0) + ')' : '';
      const cg = r.congestion > 1e-4 ? ', incl. ' + fmt(r.congestion, 3) + ' congestion' : '';
      const rd = r.reducing ? ' · risk-reducing (offsets exposure, margin 1)' : '';
      const fc = r.forcedNow > 1e-6 ? ' · auto-deleveraged ' + fmt(r.forcedNow, 1) : '';
      out.textContent = 'Filled ' + fmt(r.fill, 1) + ' ' + specLabel(buySpec()) + part + ' @ ' + fmt(r.exec, 3) + cg + ' · cost ' + money(r.cost, 0) + rd + fc;
    }
    render();
  }
  function readCash() { return clamp(parseFloat($('#cap-cash', root).value) || 5000, 1000, 50000); }
  function rebuild() {
    builtCash = readCash();
    TAPE = buildTape(builtCash);
    selectFix(curFix in FIXES ? curFix : 'none');
    syncCashBtn();
    const msg = $('#cap-cash-msg', root);
    if (msg) { msg.textContent = 'Re-simulated to the gate with ' + money(builtCash) + ' liquidity.'; }
  }
  function syncCashBtn() {
    const btn = $('#cap-cash-apply', root);
    if (btn) btn.disabled = readCash() === builtCash;
  }

  /* ---- buy-contract controls ------------------------------------------- */
  function buildBuyControls() {
    const seg = $('#cap-buy-type', root);
    if (seg) {
      seg.innerHTML = '';
      [['LINEAR', 'Linear'], ['CALL', 'Call'], ['PUT', 'Put'], ['BINARY_CALL', 'Bin·Call'], ['BINARY_PUT', 'Bin·Put'], ['SPREAD', 'Spread'], ['GAUSSIAN', 'Gauss']].forEach(([v, l]) => {
        const b = document.createElement('button');
        b.className = 'seg cap-bt' + (v === buyType ? ' active' : '');
        b.textContent = l; b.dataset.t = v;
        b.addEventListener('click', () => { buyType = v; $$('.cap-bt', seg).forEach((x) => x.classList.toggle('active', x.dataset.t === v)); syncBuyParamVis(); render(); });
        seg.appendChild(b);
      });
    }
    const kIn = $('#cap-buy-k', root), wIn = $('#cap-buy-w', root);
    if (kIn) { kIn.value = buyK; kIn.addEventListener('input', () => { buyK = parseFloat(kIn.value) || 100; render(); }); }
    if (wIn) { wIn.value = buyW; wIn.addEventListener('input', () => { buyW = Math.max(1, parseFloat(wIn.value) || 8); render(); }); }
    syncBuyParamVis();
  }
  function syncBuyParamVis() {
    const kWrap = $('#cap-buy-k-wrap', root), wWrap = $('#cap-buy-w-wrap', root);
    if (kWrap) kWrap.style.display = buyType === 'LINEAR' ? 'none' : '';
    if (wWrap) wWrap.style.display = (buyType === 'SPREAD' || buyType === 'GAUSSIAN') ? '' : 'none';
    const kLab = $('#cap-buy-k-lab', root);
    if (kLab) kLab.textContent = buyType === 'SPREAD' ? 'centre' : buyType === 'GAUSSIAN' ? 'centre' : 'strike K';
  }

  /* ---- wire up the static DOM ------------------------------------------ */
  function mount() {
    const sel = $('#cap-fix-select', root);
    sel.innerHTML = '';
    const noneBtn = document.createElement('button');
    noneBtn.className = 'cap-fix-btn seg active'; noneBtn.dataset.fix = 'none'; noneBtn.textContent = 'No fix';
    noneBtn.addEventListener('click', () => selectFix('none'));
    sel.appendChild(noneBtn);
    for (const id of FIX_ORDER) {
      const b = document.createElement('button');
      b.className = 'cap-fix-btn seg' + (FIXES[id].star ? ' star' : '') + (FIXES[id].explainOnly ? ' muted' : '');
      b.dataset.fix = id;
      b.innerHTML = '<span class="lt">' + id + '</span> ' + FIXES[id].name + (FIXES[id].star ? ' ★' : '');
      b.addEventListener('click', () => selectFix(id));
      sel.appendChild(b);
    }
    buildBuyControls();
    $('#cap-cash', root).addEventListener('input', syncCashBtn);
    $('#cap-cash-apply', root).addEventListener('click', rebuild);
    $('#cap-buy-btn', root).addEventListener('click', doBuy);
    $('#cap-buy-size', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') doBuy(); });
    rebuild();
  }

  const details = root.closest('details');
  let mounted = false;
  const ensure = () => { if (!mounted && (!details || details.open)) { mounted = true; mount(); } };
  if (details) details.addEventListener('toggle', () => { ensure(); if (details.open) render(); });
  ensure();

  new MutationObserver(() => { if (mounted) render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (mounted) render(); }, 120); });
})();
