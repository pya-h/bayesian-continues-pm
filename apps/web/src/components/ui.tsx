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

// A lightweight centered modal with a dimmed, click-to-close backdrop and Escape
// support. No portal — rendered inline with a high z-index, which is plenty for
// this app's flat layout.
export function Modal({
  onClose,
  title,
  right,
  children,
}: {
  onClose: () => void;
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm animate-fade-in">
      {/* full-screen click-to-close backdrop (a real button, behind the dialog) */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 -z-10 cursor-default"
      />
      {/* biome-ignore lint/a11y/useSemanticElements: a portal-free overlay; native <dialog> brings focus-trap/top-layer behavior we don't want here. */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative my-12 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl animate-fade-up"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          <div className="flex items-center gap-2">
            {right}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-muted transition-colors hover:bg-panel-2 hover:text-fg"
            >
              ✕
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
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
