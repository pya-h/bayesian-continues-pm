import type { ButtonHTMLAttributes, ReactNode } from 'react';
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
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45';
  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-white hover:bg-[#3f74f0]',
    buy: 'bg-buy text-white hover:bg-[#268a5b]',
    sell: 'bg-sell text-white hover:bg-[#c0413e]',
    ghost: 'border border-edge bg-panel-2 text-fg hover:border-muted',
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
  return <div className={`animate-pulse rounded-md bg-panel-2 ${className}`} />;
}
