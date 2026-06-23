// Circuit breakers — Pure policy: given a snapshot of market
// health, decide which alerts fire and what action each recommends. IO-free and
// deterministic so it's unit-tested in isolation; the api layer feeds it live
// numbers post-trade and publishes the resulting alerts to the `system` topic.
// v1 implements the three breakers expressible from per-trade state
// belief divergence (σ > 3·σ₀) → alert admin
// rapid price move (|Δfair|/fair > 10%) → suspend trading
// insolvency risk (cash < 1.2·reserve) → reject / (approaching → alert)
// Concentration / wash-trading / oracle-timeout breakers are v2 (they need
// cross-trade or time-series state beyond a single fill).

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type BreakerKind =
  | 'belief_divergence'
  | 'rapid_price_move'
  | 'insolvency_risk'
  | 'param_rail';
export type BreakerAction = 'alert' | 'suspend' | 'reject';

export interface Alert {
  kind: BreakerKind;
  severity: AlertSeverity;
  action: BreakerAction;
  message: string;
  value: number;
  threshold: number;
}

export interface BreakerInput {
  // Current belief stddev σ.
  sigma: number;
  // Initial belief stddev σ₀ (market genesis).
  sigma0: number;
  priceMovePct: number;
  cash: number;
  reserve: number;
  paramRailHit?: boolean;
}

export interface BreakerThresholds {
  // σ > sigmaRatio·σ₀ → belief divergence. Default 3.
  sigmaRatio: number;
  priceMovePct: number;
  reserveRatio: number;
  // cash < reserveWarnRatio·reserve → approaching insolvency (warning). Default 1.5.
  reserveWarnRatio: number;
}

export const DEFAULT_BREAKER_THRESHOLDS: BreakerThresholds = {
  sigmaRatio: 3,
  priceMovePct: 0.1,
  reserveRatio: 1.2,
  reserveWarnRatio: 1.5,
};

export function evalBreakers(
  input: BreakerInput,
  thresholds: Partial<BreakerThresholds> = {},
): Alert[] {
  const t = { ...DEFAULT_BREAKER_THRESHOLDS, ...thresholds };
  const alerts: Alert[] = [];

  // 1. Belief divergence — the market has become far more uncertain than at genesis.
  if (input.sigma0 > 0 && input.sigma > t.sigmaRatio * input.sigma0) {
    alerts.push({
      kind: 'belief_divergence',
      severity: 'warning',
      action: 'alert',
      message: `Belief σ ${fmt(input.sigma)} exceeds ${t.sigmaRatio}× genesis σ₀ ${fmt(input.sigma0)}.`,
      value: input.sigma,
      threshold: t.sigmaRatio * input.sigma0,
    });
  }

  // 2. Rapid price movement — a single step moved the fair price too far, too fast.
  const move = Math.abs(input.priceMovePct);
  if (move > t.priceMovePct) {
    alerts.push({
      kind: 'rapid_price_move',
      severity: 'critical',
      action: 'suspend',
      message: `Price moved ${pct(move)} (> ${pct(t.priceMovePct)}) — recommend suspending trading.`,
      value: move,
      threshold: t.priceMovePct,
    });
  }

  // 3. Insolvency risk — reserve is eating into the cash buffer. Only meaningful
  // when there's a reserve to breach (an empty book reserves nothing).
  if (input.reserve > 0) {
    if (input.cash < t.reserveRatio * input.reserve) {
      alerts.push({
        kind: 'insolvency_risk',
        severity: 'critical',
        action: 'reject',
        message: `Cash ${fmt(input.cash)} below ${t.reserveRatio}× reserve ${fmt(input.reserve)} — new risk rejected.`,
        value: input.cash,
        threshold: t.reserveRatio * input.reserve,
      });
    } else if (input.cash < t.reserveWarnRatio * input.reserve) {
      alerts.push({
        kind: 'insolvency_risk',
        severity: 'warning',
        action: 'alert',
        message: `Cash ${fmt(input.cash)} below the ${t.reserveWarnRatio}× reserve warning level (floor ${t.reserveRatio}× of ${fmt(input.reserve)}).`,
        value: input.cash,
        threshold: t.reserveWarnRatio * input.reserve,
      });
    }
  }

  // 4. Adaptive-parameter rail — a self-tuned parameter (σ_ε / s₀ / α / β)
  // saturated a clamp. Informational: the controller is at the edge of its
  // safe envelope, so an admin may want to widen the rail or pin the param.
  if (input.paramRailHit) {
    alerts.push({
      kind: 'param_rail',
      severity: 'info',
      action: 'alert',
      message: 'Adaptive parameter clamped to a §14.1 rail — controller at its safe envelope edge.',
      value: 1,
      threshold: 1,
    });
  }

  return alerts;
}

function fmt(x: number): string {
  return (Math.round(x * 100) / 100).toString();
}
function pct(x: number): string {
  return `${(Math.round(x * 1000) / 10).toString()}%`;
}
