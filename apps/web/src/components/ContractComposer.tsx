// Contract composer: pick a payoff type, then fine-tune its parameters. Inputs
// are two-way bound to the same `spec` the chart drags, so dragging a handle and
// typing a number stay in lockstep. Switching type seeds sensible defaults off
// the current belief (μ, σ).

import { ContractType } from '@bmm/shared';
import { specLabel } from '../lib/format.ts';
import type { ContractSpec } from '../lib/types.ts';

const TYPES: { type: ContractSpec['type']; label: string; hint: string }[] = [
  { type: ContractType.LINEAR, label: 'Linear', hint: 'Pays θ — a direct long on the outcome.' },
  { type: ContractType.CALL, label: 'Call', hint: 'Pays max(θ − K, 0).' },
  { type: ContractType.PUT, label: 'Put', hint: 'Pays max(K − θ, 0).' },
  { type: ContractType.BINARY_CALL, label: 'Binary ≥', hint: 'Pays 1 if θ ≥ K, else 0.' },
  { type: ContractType.BINARY_PUT, label: 'Binary ≤', hint: 'Pays 1 if θ ≤ K, else 0.' },
  { type: ContractType.SPREAD, label: 'Spread', hint: 'Pays 1 if lo ≤ θ ≤ hi (a box).' },
  { type: ContractType.GAUSSIAN, label: 'Bell', hint: 'Pays exp(−(θ−c)²/2w²) — peaked at c.' },
  {
    type: ContractType.SKEW_GAUSSIAN,
    label: 'Skew bell',
    hint: 'Asymmetric bell — width wL below c, wR above. Peaks at c.',
  },
  { type: ContractType.TENT, label: 'Tent', hint: 'Triangle — peak 1 at c, 0 at c ± w.' },
  {
    type: ContractType.TRAPEZOID,
    label: 'Trapezoid',
    hint: 'Flat 1 on [lo, hi] with soft ramps of run w.',
  },
  {
    type: ContractType.SIGMOID,
    label: 'Sigmoid',
    hint: 'Soft step 1/(1+e^−(θ−c)/w) — “above c, softly.”',
  },
];

export function defaultSpec(type: ContractSpec['type'], mu: number, sigma: number): ContractSpec {
  const round = (x: number) => Math.round(x);
  switch (type) {
    case 'LINEAR':
      return { type };
    case 'CALL':
    case 'BINARY_CALL':
      return { type, strike: round(mu + 0.5 * sigma) };
    case 'PUT':
    case 'BINARY_PUT':
      return { type, strike: round(mu - 0.5 * sigma) };
    case 'SPREAD':
      return { type, lower: round(mu - sigma), upper: round(mu + sigma) };
    case 'GAUSSIAN':
      return { type, center: round(mu), width: round(sigma) || 1 };
    case 'SKEW_GAUSSIAN':
      return {
        type,
        center: round(mu),
        widthLeft: round(sigma) || 1,
        widthRight: round(1.6 * sigma) || 1,
      };
    case 'TENT':
      return { type, center: round(mu), width: round(2 * sigma) || 1 };
    case 'TRAPEZOID':
      return { type, lower: round(mu - sigma), upper: round(mu + sigma), width: round(sigma) || 1 };
    case 'SIGMOID':
      return { type, center: round(mu), width: Math.max(1, round(0.5 * sigma)) };
  }
}

function NumField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step: number;
}) {
  return (
    <label className="flex flex-1 flex-col gap-1 text-xs">
      <span className="text-muted">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="input-glow tnum w-full rounded-lg border border-edge bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent"
      />
    </label>
  );
}

export function ContractComposer({
  spec,
  onSpecChange,
  mu,
  sigma,
}: {
  spec: ContractSpec;
  onSpecChange: (s: ContractSpec) => void;
  mu: number;
  sigma: number;
}) {
  const step = Math.max(1, 10 ** Math.floor(Math.log10(Math.max(1, sigma))) / 10);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-1.5">
        {TYPES.map((t) => (
          <button
            key={t.type}
            type="button"
            onClick={() => onSpecChange(defaultSpec(t.type, mu, sigma))}
            className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-all duration-200 active:scale-[0.96] ${
              spec.type === t.type
                ? 'btn-glow-accent border-transparent bg-grad-accent text-[var(--color-on-accent)]'
                : 'border-edge bg-panel-2 text-muted hover:border-accent/40 hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-muted">{TYPES.find((t) => t.type === spec.type)?.hint}</p>

      {/* per-type parameter inputs */}
      <div className="flex gap-2">
        {(spec.type === 'CALL' ||
          spec.type === 'PUT' ||
          spec.type === 'BINARY_CALL' ||
          spec.type === 'BINARY_PUT') && (
          <NumField
            label="Strike K"
            value={spec.strike}
            step={step}
            onChange={(strike) => onSpecChange({ ...spec, strike })}
          />
        )}
        {spec.type === 'SPREAD' && (
          <>
            <NumField
              label="Lower"
              value={spec.lower}
              step={step}
              onChange={(lower) => onSpecChange({ ...spec, lower })}
            />
            <NumField
              label="Upper"
              value={spec.upper}
              step={step}
              onChange={(upper) => onSpecChange({ ...spec, upper })}
            />
          </>
        )}
        {(spec.type === 'GAUSSIAN' || spec.type === 'TENT' || spec.type === 'SIGMOID') && (
          <>
            <NumField
              label="Center c"
              value={spec.center}
              step={step}
              onChange={(center) => onSpecChange({ ...spec, center })}
            />
            <NumField
              label="Width w"
              value={spec.width}
              step={step}
              onChange={(width) => onSpecChange({ ...spec, width: Math.max(1e-6, width) })}
            />
          </>
        )}
        {spec.type === 'SKEW_GAUSSIAN' && (
          <>
            <NumField
              label="Center c"
              value={spec.center}
              step={step}
              onChange={(center) => onSpecChange({ ...spec, center })}
            />
            <NumField
              label="Width L"
              value={spec.widthLeft}
              step={step}
              onChange={(widthLeft) =>
                onSpecChange({ ...spec, widthLeft: Math.max(1e-6, widthLeft) })
              }
            />
            <NumField
              label="Width R"
              value={spec.widthRight}
              step={step}
              onChange={(widthRight) =>
                onSpecChange({ ...spec, widthRight: Math.max(1e-6, widthRight) })
              }
            />
          </>
        )}
        {spec.type === 'TRAPEZOID' && (
          <>
            <NumField
              label="Lower"
              value={spec.lower}
              step={step}
              onChange={(lower) => onSpecChange({ ...spec, lower })}
            />
            <NumField
              label="Upper"
              value={spec.upper}
              step={step}
              onChange={(upper) => onSpecChange({ ...spec, upper })}
            />
            <NumField
              label="Ramp w"
              value={spec.width}
              step={step}
              onChange={(width) => onSpecChange({ ...spec, width: Math.max(1e-6, width) })}
            />
          </>
        )}
        {spec.type === 'LINEAR' && (
          <p className="py-1.5 text-xs text-muted">No parameters — pays the raw outcome θ.</p>
        )}
      </div>

      <p className="tnum text-xs text-muted">
        Composing: <span className="text-fg">{specLabel(spec)}</span>
      </p>
    </div>
  );
}
