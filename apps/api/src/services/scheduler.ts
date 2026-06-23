// Oracle scheduler — the single backend cron job that drives time-based
// oracle work: auto-resolving `api`-mode markets at their deadline and
// auto-settling RESOLVED markets once the dispute window elapses.
// Uses the `cron` package — NOT `setInterval` (a standing backend rule: scheduled
// work goes through a real cron job). Single-node for now; (scale) replaces
// this with a leader-elected runner so only one node ticks per market. A re-entrancy
// guard skips a tick if the previous one is still running (a slow feed must not
// stack overlapping sweeps).

import { CronJob } from 'cron';
import { config } from '../config.ts';
import { runApiResolutionSweep, runAutoSettleSweep } from './oracleSvc.ts';

let job: CronJob | null = null;
let ticking = false;

export async function runOracleTick(nowMs = Date.now()): Promise<void> {
  await runApiResolutionSweep(nowMs);
  await runAutoSettleSweep(nowMs);
}

export function startScheduler(): void {
  if (!config.oracle.schedulerEnabled || job) return;
  job = CronJob.from({
    cronTime: config.oracle.cron,
    onTick: async () => {
      if (ticking) return; // skip overlapping ticks
      ticking = true;
      try {
        await runOracleTick();
      } catch (err) {
        console.error('[oracle scheduler] tick failed:', err);
      } finally {
        ticking = false;
      }
    },
    start: true,
  });
  console.log(`[oracle scheduler] started (cron "${config.oracle.cron}")`);
}

export function stopScheduler(): void {
  job?.stop();
  job = null;
}
