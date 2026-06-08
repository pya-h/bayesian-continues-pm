// Monte-Carlo simulation runner. A thin CLI over the pure
// `@bmm/core` sim: it runs the experiment and prints a calibration/profitability
// report. Doubles as a tuning tool — sweep σ_obs (trader informedness) to see how
// belief accuracy, 80%-CI calibration, and MM/LP profitability respond.
// bun run sim # defaults
// bun run sim --runs 5000 --traders 100 --mu0 65000 --sigma0 5000
// bun run sim --sigmaObs 2500 --seed 7 --no-sweep
// No database or network — purely deterministic given the flags.

import { type SimParams, type SimSummary, runMonteCarlo } from '@bmm/core';

interface Cli extends SimParams {
  sweep: boolean;
}

function parseArgs(argv: string[]): Cli {
  const out: Cli = {
    runs: 2000,
    traders: 100,
    mu0: 100,
    sigma0: 20,
    seed: 0xb33f,
    sweep: true,
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
    `prior ${fmt(s.meanPriorError).padStart(10)}`,
    `learn ${learn.padStart(6)}%`,
    `calib₈₀ ${fmt(s.calibration80, 3).padStart(6)}`,
    `mmPnL ${fmt(s.meanMmPnl, 1).padStart(14)}`,
    `welfare ${fmt(s.meanUserWelfare, 1).padStart(12)}`,
  ].join('  ');
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  console.log('\nBMM Monte-Carlo simulation — MODEL.md §17.3');
  console.log(
    `runs=${cli.runs}  traders=${cli.traders}  μ₀=${cli.mu0}  σ₀=${cli.sigma0}  seed=${cli.seed}\n`,
  );

  if (cli.sweep && cli.sigmaObs === undefined) {
    // Sweep trader informedness from very informed (σ₀/8) to pure noise (4·σ₀).
    console.log('σ_obs sweep (trader signal noise; lower = better informed):\n');
    const ratios = [0.125, 0.25, 0.5, 1, 2, 4];
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
