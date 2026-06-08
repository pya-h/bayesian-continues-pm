// Preferences modal — theme, accent, number precision, compactness, and motion.
// Changes apply live (the prefs layer re-themes the document and re-formats every
// number on the next render) and persist to localStorage.

import { type ReactNode, useEffect } from 'react';
import { fmt } from '../lib/format.ts';
import { usePrefs } from '../prefs/PrefsContext.tsx';
import { ACCENTS, THEMES } from '../prefs/themes.ts';
import { Button, Toggle } from './ui.tsx';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { prefs, setPrefs, reset } = usePrefs();

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-4 backdrop-blur-sm animate-fade-in sm:items-center"
      onMouseDown={onClose}
    >
      <div
        className="my-auto w-full max-w-md rounded-2xl border border-edge bg-panel shadow-2xl animate-pop"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold">Preferences</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preferences"
            className="rounded-md px-2 py-0.5 text-muted transition-colors hover:text-fg"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-6 px-5 py-5">
          {/* theme */}
          <Section title="Theme" hint="Base palette for the whole app.">
            <div className="grid grid-cols-4 gap-2">
              {THEMES.map((t) => {
                const active = prefs.theme === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setPrefs({ theme: t.id })}
                    aria-pressed={active}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border p-2 transition-colors ${
                      active ? 'border-accent' : 'border-edge hover:border-muted'
                    }`}
                  >
                    <span
                      className="flex h-9 w-full items-center justify-center gap-1 rounded-lg"
                      style={{ background: t.swatch[0] }}
                    >
                      <span
                        className="h-5 w-5 rounded"
                        style={{ background: t.swatch[1], border: `1px solid ${t.swatch[2]}33` }}
                      />
                      <span className="h-1.5 w-3 rounded" style={{ background: t.swatch[2] }} />
                    </span>
                    <span className={`text-xs ${active ? 'text-accent' : 'text-muted'}`}>
                      {t.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* accent */}
          <Section title="Accent" hint="Highlights, charts, and primary buttons.">
            <div className="flex flex-wrap gap-2.5">
              {ACCENTS.map((a) => {
                const active = prefs.accent === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setPrefs({ accent: a.id })}
                    aria-label={a.label}
                    aria-pressed={active}
                    title={a.label}
                    className="flex h-8 w-8 items-center justify-center rounded-full transition-transform hover:scale-110"
                    style={{
                      background: a.color,
                      boxShadow: active
                        ? '0 0 0 2px var(--color-panel), 0 0 0 4px var(--color-fg)'
                        : 'none',
                    }}
                  >
                    {active && <span className="text-sm font-bold text-white">✓</span>}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* precision */}
          <Section title="Number precision" hint="Decimal places shown on money & values.">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panel-2 p-1">
                <Stepper
                  label="−"
                  disabled={prefs.precision <= 0}
                  onClick={() => setPrefs({ precision: prefs.precision - 1 })}
                />
                <span className="tnum w-8 text-center text-sm font-semibold">
                  {prefs.precision}
                </span>
                <Stepper
                  label="+"
                  disabled={prefs.precision >= 6}
                  onClick={() => setPrefs({ precision: prefs.precision + 1 })}
                />
              </div>
              <span className="tnum rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-sm text-muted">
                e.g. {fmt(1234.56789)}
              </span>
            </div>
          </Section>

          {/* toggles */}
          <Section title="Display">
            <Row label="Compact large numbers" hint="Show NAV / volume as 1.2M, 34.5k.">
              <Toggle
                checked={prefs.compact}
                onChange={(v) => setPrefs({ compact: v })}
                label="Compact large numbers"
              />
            </Row>
            <Row label="Animations" hint="Transitions, flashes, and entrance motion.">
              <Toggle
                checked={prefs.animations}
                onChange={(v) => setPrefs({ animations: v })}
                label="Animations"
              />
            </Row>
          </Section>
        </div>

        <footer className="flex items-center justify-between border-t border-edge px-5 py-3">
          <button
            type="button"
            onClick={reset}
            className="text-xs text-muted transition-colors hover:text-fg"
          >
            Reset to defaults
          </button>
          <Button variant="primary" className="px-4 py-1.5 text-sm" onClick={onClose}>
            Done
          </Button>
        </footer>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {hint && <p className="text-xs text-muted/70">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Stepper({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded-md text-base font-semibold text-fg transition-colors hover:bg-edge/50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}
