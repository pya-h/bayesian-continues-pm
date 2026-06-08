// Display formatters. Pure functions, but they read two process-wide display
// preferences (decimal precision + compact-numbers) that the UI's Preferences
// panel sets via the setters below. Call sites that pass an explicit `decimals`
// (axis ticks at 0, spread internals at 4, …) are unaffected — only the *money*
// default tracks the user's precision.

let DEFAULT_DECIMALS = 2;
let COMPACT_NUMBERS = true;

export function setNumberPrecision(decimals: number): void {
  DEFAULT_DECIMALS = Math.max(0, Math.min(6, Math.round(decimals)));
}
export function getNumberPrecision(): number {
  return DEFAULT_DECIMALS;
}
export function setCompactNumbers(on: boolean): void {
  COMPACT_NUMBERS = on;
}

export function fmt(n: number | null | undefined, decimals = DEFAULT_DECIMALS): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (!COMPACT_NUMBERS) return fmt(n);
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return fmt(n);
}

export function fmtSigned(n: number | null | undefined, decimals = DEFAULT_DECIMALS): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const s = fmt(Math.abs(n), decimals);
  return n < 0 ? `−${s}` : `+${s}`;
}

export function fmtPct(frac: number | null | undefined, decimals = 1): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return '—';
  return `${(frac * 100).toFixed(decimals)}%`;
}

export function specLabel(spec: {
  type: string;
  strike?: number;
  lower?: number;
  upper?: number;
  center?: number;
  width?: number;
}): string {
  switch (spec.type) {
    case 'LINEAR':
      return 'Linear (θ)';
    case 'CALL':
      return `Call · K=${fmt(spec.strike ?? 0, 0)}`;
    case 'PUT':
      return `Put · K=${fmt(spec.strike ?? 0, 0)}`;
    case 'BINARY_CALL':
      return `Binary ≥ ${fmt(spec.strike ?? 0, 0)}`;
    case 'BINARY_PUT':
      return `Binary ≤ ${fmt(spec.strike ?? 0, 0)}`;
    case 'SPREAD':
      return `Spread [${fmt(spec.lower ?? 0, 0)}, ${fmt(spec.upper ?? 0, 0)}]`;
    case 'GAUSSIAN':
      return `Bell · c=${fmt(spec.center ?? 0, 0)} w=${fmt(spec.width ?? 0, 0)}`;
    default:
      return spec.type;
  }
}

const STATUS_TONE: Record<string, string> = {
  OPEN: 'text-buy bg-buy-soft',
  CREATED: 'text-accent bg-accent-soft',
  SUSPENDED: 'text-warn bg-[#2c2614]',
  RESOLVED: 'text-accent bg-accent-soft',
  SETTLED: 'text-muted bg-panel-2',
  CLOSED: 'text-muted bg-panel-2',
  CANCELLED: 'text-sell bg-sell-soft',
};
export function statusTone(status: string): string {
  return STATUS_TONE[status] ?? 'text-muted bg-panel-2';
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
