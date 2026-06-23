// Monte-Carlo simulation runner. A thin CLI over the pure
// `@bmm/core` sim: it runs the experiment and prints a calibration/profitability
// report. Doubles as a tuning tool — sweep σ_obs (trader informedness) to see how
// belief accuracy, 80%-CI calibration, and MM/LP profitability respond.
// bun run sim # defaults
// bun run sim --runs 5000 --traders 100 --mu0 65000 --sigma0 5000
// bun run sim --sigmaObs 2500 --seed 7 --no-sweep
// bun run sim --ab --strike-read #: adaptive vs static A/B over the σ_obs sweep
// bun run sim --adaptive --kind student_t --no-sweep
// No database or network — purely deterministic given the flags.

import {
  type BeliefKind,
  type SimParams,
  type SimSummary,
  compareAdaptiveVsStatic,
  runMonteCarlo,
} from '@bmm/core';

interface Cli extends SimParams {
  sweep: boolean;
  ab: boolean;
}

const BELIEF_KINDS: BeliefKind[] = ['gaussian', 'student_t', 'mixture', 'gen_exact'];

function parseArgs(argv: string[]): Cli {
  const out: Cli = {
    runs: 2000,
    traders: 100,
    mu0: 100,
    sigma0: 20,
    seed: 0xb33f,
    sweep: true,
    ab: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (): number => Number(argv[++i]);
    switch (a) {
      case '--runs':
        out.runs = num();
        break;
      case '--traders':
        out.traders = num();
        break;
      case '--mu0':
        out.mu0 = num();
        break;
      case '--sigma0':
        out.sigma0 = num();
        break;
      case '--sigmaObs':
        out.sigmaObs = num();
        break;
      case '--seed':
        out.seed = num();
        break;
      case '--no-sweep':
        out.sweep = false;
        break;
      case '--adaptive':
        out.adaptive = true;
        break;
      case '--strike-read':
        out.strikeAtRead = true;
        break;
      case '--ab':
        out.ab = true;
        break;
      case '--kind': {
        const k = argv[++i] as BeliefKind;
        if (!BELIEF_KINDS.includes(k)) throw new Error(`Unknown --kind: ${k}`);
        out.beliefKind = k;
        break;
      }
      default:
        if (a?.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return out;
}

function fmt(x: number, dp = 3): string {
  return x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function reportLine(label: string, s: SimSummary): string {
  const learn = ((1 - s.meanBeliefError / s.meanPriorError) * 100).toFixed(1);
  return [
    label.padEnd(14),
    `err ${fmt(s.meanBeliefError).padStart(10)}`,
    `learn ${learn.padStart(6)}%`,
    `calib₈₀ ${fmt(s.calibration80, 3).padStart(6)}`,
    `σ_ε ${fmt(s.meanSigmaEpsFinal, 1).padStart(8)}`,
    `mmPnL ${fmt(s.meanMmPnl, 1).padStart(13)}`,
    `welfare ${fmt(s.meanUserWelfare, 1).padStart(11)}`,
  ].join('  ');
}

function abLine(label: string, params: Omit<SimParams, 'adaptive'>): string {
  const c = compareAdaptiveVsStatic(params);
  const arrow = c.adaptiveCalibratesBetter ? '✓ adapt' : '· static';
  return [
    label.padEnd(12),
    `static calib₈₀ ${fmt(c.static.calibration80, 3)}`,
    `→ adapt ${fmt(c.adaptive.calibration80, 3)}`,
    `(σ_ε ${fmt(c.static.meanSigmaEpsFinal, 1)}→${fmt(c.adaptive.meanSigmaEpsFinal, 1)})`,
    `ΔcalibErr ${fmt(c.calibrationErrorDelta, 3).padStart(7)}`,
    `rail ${(c.adaptive.railHitRate * 100).toFixed(0).padStart(3)}%`,
    arrow,
  ].join('  ');
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  console.log('\nBMM Monte-Carlo simulation — MODEL.md §17.3 / §14.2');
  const mode = cli.ab ? 'A/B adaptive-vs-static' : cli.adaptive ? 'adaptive' : 'static';
  console.log(
    `runs=${cli.runs}  traders=${cli.traders}  μ₀=${cli.mu0}  σ₀=${cli.sigma0}  seed=${cli.seed}  ` +
      `kind=${cli.beliefKind ?? 'gaussian'}  strike=${cli.strikeAtRead ? 'read' : 'atm'}  mode=${mode}\n`,
  );

  const ratios = [0.125, 0.25, 0.5, 1, 2, 4];

  if (cli.ab) {
    // Adaptive vs static across the noise sweep — the calibration check.
    console.log('adaptive vs static calibration (volatile = σ_obs ≳ σ₀):\n');
    if (cli.sigmaObs === undefined) {
      for (const r of ratios)
        console.log(abLine(`σ_obs=${r}σ₀`, { ...cli, sigmaObs: r * cli.sigma0 }));
    } else {
      console.log(abLine(`σ_obs=${fmt(cli.sigmaObs, 1)}`, cli));
    }
    console.log(
      '\nReading it: where static σ_ε is mis-set for the noise (σ_obs ≠ σ₀), static is mis-calibrated;',
    );
    console.log('adaptation pulls calib₈₀ back toward 0.80. ΔcalibErr < 0 ⇒ adaptive is better.\n');
    return;
  }

  if (cli.sweep && cli.sigmaObs === undefined) {
    console.log('σ_obs sweep (trader signal noise; lower = better informed):\n');
    for (const r of ratios) {
      const s = runMonteCarlo({ ...cli, sigmaObs: r * cli.sigma0 });
      console.log(reportLine(`σ_obs=${r}σ₀`, s));
    }
  } else {
    const s = runMonteCarlo(cli);
    console.log(reportLine(`σ_obs=${fmt(s.sigmaObs, 1)}`, s));
  }

  console.log(
    '\nReading it: a well-informed market should LEARN (err ≪ prior), keep calib₈₀ near 0.80,',
  );
  console.log(
    'and leave the MM profitable (mmPnL > 0). Pure-noise flow games the MM (mmPnL < 0).\n',
  );
}

if (import.meta.main) main();
