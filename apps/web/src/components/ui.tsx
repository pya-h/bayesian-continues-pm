import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from 'react';
import { statusTone } from '../lib/format.ts';

export function Panel({
  children,
  className = '',
  title,
  right,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className={`rounded-xl border border-edge bg-panel ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-semibold tracking-wide ${statusTone(status)}`}
    >
      {status}
    </span>
  );
}

export function Stat({
  label,
  value,
  tone = 'fg',
  sub,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'fg' | 'buy' | 'sell' | 'muted' | 'accent' | 'warn';
  sub?: ReactNode;
}) {
  const toneCls = {
    fg: 'text-fg',
    buy: 'text-buy',
    sell: 'text-sell',
    muted: 'text-muted',
    accent: 'text-accent',
    warn: 'text-warn',
  }[tone];
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className={`tnum text-base font-semibold ${toneCls}`}>{value}</span>
      {sub && <span className="tnum text-xs text-muted">{sub}</span>}
    </div>
  );
}

type Variant = 'primary' | 'buy' | 'sell' | 'ghost';
export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-[transform,background-color,border-color,filter] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100';
  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-[var(--color-on-accent)] hover:brightness-110 active:brightness-95',
    buy: 'bg-buy text-white hover:brightness-110 active:brightness-95',
    sell: 'bg-sell text-white hover:brightness-110 active:brightness-95',
    ghost: 'border border-edge bg-panel-2 text-fg hover:border-muted hover:bg-edge/40',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-muted">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-edge border-t-accent" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-sell/40 bg-sell-soft px-3 py-2 text-sm text-sell">
      {children}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

// Wraps a numeric value and briefly flashes green/red when it changes — for live
// figures like balance and consensus μ. `children` is the already-formatted text
// `value` is the raw number that drives the flash direction.
export function FlashNumber({
  value,
  children,
  className = '',
}: {
  value: number;
  children: ReactNode;
  className?: string;
}) {
  const prev = useRef(value);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    if (!Number.isFinite(value) || value === prev.current) return;
    setFlash(value > prev.current ? 'flash-up' : 'flash-down');
    prev.current = value;
    const t = setTimeout(() => setFlash(''), 900);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <span className={`-mx-1 inline-block rounded px-1 ${flash} ${className}`}>{children}</span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
        checked ? 'border-accent bg-accent' : 'border-edge bg-panel-2'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
