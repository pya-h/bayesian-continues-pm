// ============================================================================
// capacity-engine.js — the pure, DOM-free engine behind the capacity sandbox.
// Everything here is deterministic math: the book reserve, the admission gate
// the soft-cap congestion premium, the per-fix modifiers, and the forward step
// that drives a synthetic crowd into the no-buy band. It owns NO DOM and NO
// rendering — capacity-sandbox.js wires this into the page; the test suite
// drives the very same functions
// headlessly to prove the sandbox computes what the real engine does.
// All belief/price/spread/signal math comes from the injected `M` (window.BMM
// the math.js port of packages/core), so every number matches the server. The
// only thing this module adds on top of BMM is the *book-level* reserve quantile
// and the capacity gate/congestion that the soft-cap design (
// soft-cap.md ) layers over the base engine.
// Usage
// const CAP = CapEngine.makeCapEngine(window.BMM); // browser
// const CAP = require('./capacity-engine').makeCapEngine(BMM); // node
// ==========================================================================
((global) => {
  function makeCapEngine(M) {
    const MU0 = 100;
    const SIGMA0 = 12;
    const CROWD_SPEC = { type: 'CALL', strike: 100 }; // the one-sided bet that fills the book to the gate
    const CROWD_KEY = 'CALL:100';
    const TAPE_STEP = 12; // contracts per simulated arrival on the way to the gate
    const TRADERS = ['Ava', 'Ben', 'Cy', 'Dao', 'Eli', 'Fei']; // synthetic crowd that fills the book
    const GENESIS_BELIEF = new M.Belief(MU0, SIGMA0);

    const cfg = () => M.makeEngineConfig(MU0, SIGMA0); // belief/spread/signal config never changes with a fix
    const round8 = M.round8;

    function keyOf(s) {
      switch (s.type) {
        case 'LINEAR':
          return 'LINEAR';
        case 'SPREAD':
          return 'SPREAD:' + s.lower + ':' + s.upper;
        case 'GAUSSIAN':
          return 'GAUSSIAN:' + s.center + ':' + s.width;
        default:
          return s.type + ':' + s.strike;
      }
    }
    const fmt0 = (n) => Math.round(n).toString();
    function specLabel(s) {
      switch (s.type) {
        case 'LINEAR':
          return 'LINEAR';
        case 'SPREAD':
          return 'SPREAD ' + fmt0(s.lower) + '–' + fmt0(s.upper);
        case 'GAUSSIAN':
          return 'GAUSS ' + fmt0(s.center) + '±' + fmt0(s.width);
        case 'BINARY_CALL':
          return 'BIN-CALL ' + fmt0(s.strike);
        case 'BINARY_PUT':
          return 'BIN-PUT ' + fmt0(s.strike);
        case 'CALL':
          return 'CALL ' + fmt0(s.strike);
        case 'PUT':
          return 'PUT ' + fmt0(s.strike);
        default:
          return s.type;
      }
    }

    // reserve: stratified α-quantile of the book liability ---------
    // The same VaR M.requiredReserve estimates by Monte-Carlo, evaluated here
    // on N evenly-spaced belief quantiles θ_i = μ + σ·Φ⁻¹((i+0.5)/N). Sorting
    // handles non-monotone books; the result is exact and noise-free, so the
    // gate boundary and price ramp are smooth (no MC jitter). It matches the
    // engine's MC reserve to within sampling error (asserted in the tests).
    function reserveBook(book, belief, alpha) {
      if (!book.length) return 0;
      const a = alpha != null ? alpha : 0.99;
      const N = 1400;
      const arr = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const theta = belief.mu + belief.sigma * M.normInv((i + 0.5) / N); // i-th belief quantile
        arr[i] = M.liability(book, theta);
      }
      arr.sort();
      const idx = Math.min(N - 1, Math.max(0, Math.floor(a * (N - 1))));
      return Math.max(0, arr[idx]);
    }

    // ==================================================================
    // FIXES — each returns an "engine modifier". The forward step (stepBuy)
    // reads these fields; anything unset falls back to the baseline gate.
    // margin/alpha/extraCash/reserveScale/soft/haircut/autoDelev/explainOnly
    // ==================================================================
    const EPS = 1e-3; // congestion floor ε
    const FIXES = {
      none: {
        letter: '—',
        name: 'No fix',
        blurb:
          'The market as it stands: stuck in the no-buy band. Every risk-opening buy is rejected.',
      },
      A: {
        letter: 'A',
        name: 'Lower open-margin',
        blurb:
          'Open risk closer to the hard solvency line — shrink the 20% cushion. Small capacity gain; thinner safety margin.',
        params: [
          {
            key: 'margin',
            label: 'open-margin m',
            min: 1.0,
            max: 1.2,
            step: 0.01,
            val: 1.05,
            fmt: (v) => v.toFixed(2) + '×',
          },
        ],
      },
      B: {
        letter: 'B',
        name: 'Lower reserve confidence',
        blurb:
          'Reserve the 95th-percentile loss instead of the 99th — a smaller reserve for the same book. More capacity, more ruin events.',
        params: [
          {
            key: 'alpha',
            label: 'reserve α (VaR)',
            min: 0.9,
            max: 0.99,
            step: 0.005,
            val: 0.95,
            fmt: (v) => (v * 100).toFixed(1) + '%',
          },
        ],
      },
      C: {
        letter: 'C',
        name: 'Soft cap (congestion premium)',
        star: true,
        blurb:
          'Replace the cliff with a ramp: a capacity-aware congestion term makes the crowded side ever more expensive, so demand chokes off before the wall. The hard gate stays as a backstop (here m=1.05). Never freezes; every guarantee intact.',
        params: [
          {
            key: 'kappa',
            label: 'strength κ',
            min: 0.05,
            max: 1.0,
            step: 0.05,
            val: 0.25,
            fmt: (v) => v.toFixed(2),
          },
          {
            key: 'a',
            label: 'convexity a',
            min: 1,
            max: 4,
            step: 0.5,
            val: 2,
            fmt: (v) => v.toFixed(1),
          },
        ],
      },
      D: {
        letter: 'D',
        name: 'Solvency-factor haircut',
        blurb:
          'Stop blocking buys entirely; let exposure exceed cash. At resolution, scale every winning payout by s = min(1, cash ÷ owed). Solvent by construction — but the shortfall lands on winning traders (payouts become "up to").',
      },
      E: {
        letter: 'E',
        name: 'Insurance fund',
        blurb:
          "Add mutualized capital to the pool's backing. Real extra capacity, winners paid in full — the fund covers any gap.",
        params: [
          {
            key: 'extraCash',
            label: 'fund top-up ΔC',
            min: 0,
            max: 12000,
            step: 500,
            val: 4000,
            fmt: (v) => '$' + Math.round(v).toLocaleString('en-US'),
          },
        ],
      },
      F: {
        letter: 'F',
        name: 'Hedging / reinsurance',
        approx: true,
        blurb:
          'Offload tail exposure to an external counterparty, lowering the required reserve per unit of risk. Genuinely lifts the ceiling — no guarantee broken.',
        params: [
          {
            key: 'hedge',
            label: 'tail hedged h',
            min: 0,
            max: 0.6,
            step: 0.05,
            val: 0.3,
            fmt: (v) => (v * 100).toFixed(0) + '%',
          },
        ],
      },
      G: {
        letter: 'G',
        name: 'Auto-deleverage',
        blurb:
          'Keep the market open by forcibly closing existing holders to reclaim reserve. Brutal UX — winners get closed against their will; the squeeze moves to them.',
      },
      H: {
        letter: 'H',
        name: 'Bounded contracts',
        explainOnly: true,
        blurb:
          'Disallow unbounded payoffs (Linear, deep Call) so the tail liability — and the reserve — stay small and known.',
        why: 'This is a market-creation / menu choice, not something you can retrofit onto an existing book. It would mean never having listed this unbounded CALL in the first place (a Binary/Spread has a known max payout, so the same cash backs far more of it). Nothing about the current positions changes — so there is no live "fix" to apply here.',
      },
      I: {
        letter: 'I',
        name: 'Parimutuel restructuring',
        explainOnly: true,
        blurb:
          "Change the game: winners split the losers' stakes, so the pool never owes more than was staked and solvency risk vanishes by construction.",
        why: 'Parimutuel is a different product — there is no market-maker counterparty and no fixed-odds liability to reserve against, so the whole belief + spread + reserve engine this sandbox simulates no longer applies. The live "fair price" loses its meaning (odds are only known at settlement). It can\'t be shown as a mutation of this MM book; it\'s an architectural pivot.',
      },
    };
    const FIX_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

    const paramVals = {};
    for (const id of FIX_ORDER) {
      paramVals[id] = {};
      (FIXES[id].params || []).forEach((p) => (paramVals[id][p.key] = p.val));
    }
    function modifierFor(id) {
      const v = paramVals[id] || {};
      const mod = {
        id,
        margin: 1.2,
        alpha: 0.99,
        extraCash: 0,
        reserveScale: 1,
        soft: null,
        haircut: false,
        autoDelev: false,
      };
      if (id === 'A') mod.margin = v.margin;
      else if (id === 'B') mod.alpha = v.alpha;
      else if (id === 'C') mod.soft = { kappa: v.kappa, a: v.a, refM: 1.0, backstop: 1.05 };
      else if (id === 'D') mod.haircut = true;
      else if (id === 'E') mod.extraCash = v.extraCash;
      else if (id === 'F') mod.reserveScale = 1 - v.hedge;
      else if (id === 'G') mod.autoDelev = true;
      return mod;
    }

    const backing = (cash, mod) => cash + mod.extraCash;
    const reserveMod = (book, belief, mod) =>
      reserveBook(book, belief, mod.alpha) * mod.reserveScale;
    const mmOf = (book, key) => {
      const e = book.find((x) => x.key === key);
      return e ? e.mmShort : 0;
    };
    function withMm(book, spec, key, newMm) {
      let found = false;
      const out = book.map((e) =>
        e.key === key ? ((found = true), { spec, key, mmShort: newMm }) : e,
      );
      if (!found) out.push({ spec, key, mmShort: newMm });
      return out;
    }
    function congestionOf(Rb, Ra, cash, fairPx, mod) {
      if (!mod.soft || Ra <= Rb) return 0;
      const u = Math.min((mod.soft.refM * Ra) / cash, 1 - 1e-9);
      return (
        mod.soft.kappa * Math.abs(fairPx) * (Math.pow(u, mod.soft.a) / (1 - Math.min(u, 1 - EPS)))
      );
    }

    function quoteBuy(spec, key, size, st, mod) {
      const f = M.price(spec, st.belief);
      const spr = M.computeSpread(spec, size, mmOf(st.book, key), st.belief, cfg());
      const Rb = reserveMod(st.book, st.belief, mod);
      const Ra = reserveMod(withMm(st.book, spec, key, mmOf(st.book, key) + size), st.belief, mod);
      const cashB = backing(st.cash, mod);
      const cong = congestionOf(Rb, Ra, cashB, f, mod);
      const exec = M.execPriceFor('buy', f, spr.total) + cong;
      const cost = exec * size;
      let admit;
      if (mod.haircut)
        admit = true; // gate removed — solvency handled by the payout haircut
      else {
        const m = Ra > Rb + 1e-9 ? (mod.soft ? mod.soft.backstop : mod.margin) : 1; // risk-reducing ⇒ m=1
        admit = cashB + Math.min(0, cost) + 1e-6 >= m * Ra;
      }
      return { fairPx: f, spread: spr, congestion: cong, exec, cost, Rb, Ra, admit };
    }

    // Largest feasible fill ≤ target (binary search; both constraints monotone in size).
    function solveFill(spec, key, target, st, mod) {
      if (quoteBuy(spec, key, target, st, mod).admit) return target;
      let lo = 0,
        hi = target;
      for (let i = 0; i < 44; i++) {
        const mid = (lo + hi) / 2;
        if (quoteBuy(spec, key, mid, st, mod).admit) lo = mid;
        else hi = mid;
      }
      return lo * (1 - 1e-6);
    }

    function genesis(cash0) {
      return {
        belief: new M.Belief(MU0, SIGMA0),
        cash: cash0,
        cash0,
        book: [],
        pos: [],
        forced: 0,
        last: null,
      };
    }
    function getPos(st, trader, spec, key) {
      let p = st.pos.find((x) => x.trader === trader && x.key === key);
      if (!p) {
        p = { trader, spec, key, qty: 0, avg: 0 };
        st.pos.push(p);
      }
      return p;
    }

    function stepBuy(st, spec, reqSize, trader, mod) {
      const key = keyOf(spec);
      let forcedNow = 0;
      // Auto-deleverage: if the gate sizes the fill down, reclaim reserve by
      // force-closing a slice of the crowd (at the current bid) and retry.
      if (mod.autoDelev) {
        let guard = 0;
        while (
          solveFill(spec, key, reqSize, st, mod) < reqSize * (1 - 1e-4) &&
          mmOf(st.book, CROWD_KEY) > 0 &&
          guard++ < 8
        ) {
          const f = M.price(CROWD_SPEC, st.belief);
          const bid = Math.max(
            0,
            f - M.computeSpread(CROWD_SPEC, -1, mmOf(st.book, CROWD_KEY), st.belief, cfg()).total,
          );
          let closed = 0;
          st.pos.forEach((p) => {
            if (p.trader === 'You' || p.key !== CROWD_KEY) return; // close the crowded side, not the live trader
            const c = p.qty * 0.2;
            p.qty = round8(p.qty - c);
            if (p.qty <= 1e-8) p.avg = 0;
            closed += c;
          });
          if (closed <= 1e-8) break;
          st.book = withMm(st.book, CROWD_SPEC, CROWD_KEY, mmOf(st.book, CROWD_KEY) - closed);
          st.cash = round8(st.cash - closed * bid);
          st.forced += closed;
          forcedNow += closed;
        }
      }

      const fill = solveFill(spec, key, reqSize, st, mod);
      if (fill < 0.5) {
        // below half a contract is effectively frozen — don't apply a ghost sliver
        st.last = { req: reqSize, fill: 0, forcedNow, spec, key };
        return st.last;
      }
      const Q = quoteBuy(spec, key, fill, st, mod);
      st.cash = round8(st.cash + Q.exec * fill); // premium (incl. congestion) flows into the pool
      st.book = withMm(st.book, spec, key, mmOf(st.book, key) + fill);
      const p = getPos(st, trader, spec, key);
      const newQty = round8(p.qty + fill);
      p.avg = newQty > 0 ? round8((p.qty * p.avg + fill * Q.exec) / newQty) : 0;
      p.qty = newQty;
      const sig = M.extractSignal(spec, fill, st.belief, cfg()); // belief update from the trade signal
      st.belief = M.bayesUpdate(st.belief, sig.signal, sig.weight, cfg());
      st.last = {
        req: reqSize,
        fill,
        exec: Q.exec,
        cost: Q.exec * fill,
        congestion: Q.congestion,
        reducing: Q.Ra <= Q.Rb + 1e-9,
        forcedNow,
        spec,
        key,
      };
      return st.last;
    }

    function buildTape(cash0) {
      const st = genesis(cash0);
      const base = modifierFor('none');
      const tape = [];
      for (let n = 0; n < 200; n++) {
        const r = stepBuy(st, CROWD_SPEC, TAPE_STEP, TRADERS[n % TRADERS.length], base);
        tape.push({ pi: n % TRADERS.length });
        // Stop once even a tiny buy can't seat: that lands the book firmly inside the
        // no-buy band (cash < 1.2·reserve), so the default state genuinely rejects buys.
        if (r.fill < 0.5 && solveFill(CROWD_SPEC, CROWD_KEY, 1, st, base) < 0.25) break;
      }
      return tape;
    }
    function replay(tape, cash0, mod) {
      const st = genesis(cash0);
      for (const t of tape) stepBuy(st, CROWD_SPEC, TAPE_STEP, TRADERS[t.pi], mod);
      return st;
    }

    function gateInfo(st, mod) {
      const R = reserveMod(st.book, st.belief, mod);
      const cashB = backing(st.cash, mod);
      const rho = cashB > 0 ? R / cashB : Number.POSITIVE_INFINITY;
      const m = mod.haircut ? 0 : mod.soft ? mod.soft.backstop : mod.margin;
      const blocked = !mod.haircut && solveFill(CROWD_SPEC, CROWD_KEY, 1, st, mod) < 0.5; // crowded (risk-opening) side frozen
      return { R, cashB, rho, m, blocked };
    }

    // Marginal ask for the (q+1)-th contract of `spec`, used by the price-ramp
    // chart. Quotes the *next unit* (size 1) on a book already grown by q, so the
    // reserve actually ticks up and the soft-cap congestion term is reflected — a
    // size-0 quote would leave Ra==Rb and hide the whole congestion ramp.
    function marginalAsk(spec, key, q, st, mod) {
      const shifted = {
        belief: st.belief,
        cash: st.cash,
        book: withMm(st.book, spec, key, mmOf(st.book, key) + q),
      };
      return quoteBuy(spec, key, 1, shifted, mod);
    }

    return {
      M,
      MU0,
      SIGMA0,
      CROWD_SPEC,
      CROWD_KEY,
      TAPE_STEP,
      TRADERS,
      GENESIS_BELIEF,
      cfg,
      round8,
      EPS,
      keyOf,
      specLabel,
      reserveBook,
      FIXES,
      FIX_ORDER,
      paramVals,
      modifierFor,
      backing,
      reserveMod,
      mmOf,
      withMm,
      congestionOf,
      quoteBuy,
      solveFill,
      genesis,
      getPos,
      stepBuy,
      buildTape,
      replay,
      gateInfo,
      marginalAsk,
    };
  }

  const api = { makeCapEngine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CapEngine = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
