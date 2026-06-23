// Live circuit-breaker alerts for admins. Renders the alerts
// streamed over the `system` WS topic, severity-colored and dismissable.

import { useSystemAlerts } from '../hooks/useSystemAlerts.ts';
import { Button } from './ui.tsx';

const SEVERITY: Record<string, string> = {
  critical: 'border-sell/50 bg-sell-soft text-sell',
  warning: 'border-warn/50 bg-warn/10 text-warn',
  info: 'border-edge bg-panel-2 text-muted',
};

const KIND_LABEL: Record<string, string> = {
  belief_divergence: 'Belief divergence',
  rapid_price_move: 'Rapid price move',
  insolvency_risk: 'Insolvency risk',
  param_rail: 'Adaptive param rail',
  oracle_failure: 'Oracle failure',
};

export function AlertsBanner({ enabled = true }: { enabled?: boolean }) {
  const { alerts, connected, dismiss, clear } = useSystemAlerts(enabled);
  if (alerts.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-panel surface p-3">
      <header className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-warn">
          <span className="relative flex h-2 w-2">
            <span
              className={`absolute inline-flex h-full w-full rounded-full ${connected ? 'animate-ping bg-warn/60' : 'bg-muted'}`}
            />
            <span
              className={`inline-flex h-2 w-2 rounded-full ${connected ? 'bg-warn' : 'bg-muted'}`}
            />
          </span>
          Circuit-breaker alerts ({alerts.length})
        </h2>
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={clear}>
          Clear all
        </Button>
      </header>
      <ul className="flex flex-col gap-1.5">
        {alerts.map((a) => (
          <li
            key={a.id}
            className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-xs shadow-soft animate-slide-in ${SEVERITY[a.severity] ?? SEVERITY.info}`}
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold">
                {KIND_LABEL[a.kind] ?? a.kind}
                <span className="ml-2 rounded bg-black/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {a.action}
                </span>
              </span>
              <span className="opacity-90">{a.message}</span>
            </div>
            <button
              type="button"
              onClick={() => dismiss(a.id)}
              className="shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss alert"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
