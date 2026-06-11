// Combined sign-in / register screen.

import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { SettingsDialog } from '../components/SettingsDialog.tsx';
import { Button, ErrorNote } from '../components/ui.tsx';
import { ApiError } from '../lib/api.ts';

export function LoginPage() {
  const { login, register, user } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Already signed in → straight to markets.
  if (user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(username, password);
      else await register(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      {/* ambient accent glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(60rem 40rem at 50% -10%, color-mix(in oklab, var(--color-accent) 16%, transparent), transparent 70%)',
        }}
      />
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-label="Preferences"
        className="absolute right-4 top-4 rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-fg"
      >
        ⚙ Theme
      </button>
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-6 text-center">
          <div className="text-3xl text-accent">◎</div>
          <h1 className="mt-2 text-xl font-semibold">BMM Prediction Market</h1>
          <p className="text-sm text-muted">
            Trade continuous-outcome contracts against a Bayesian maker.
          </p>
        </div>

        <div className="mb-4 flex rounded-lg border border-edge bg-panel p-1 text-sm">
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`flex-1 rounded-md py-1.5 font-medium capitalize transition-colors ${
                mode === m
                  ? 'bg-grad-accent text-[var(--color-on-accent)] btn-glow-accent'
                  : 'text-muted hover:text-fg'
              }`}
            >
              {m === 'login' ? 'Sign in' : 'Register'}
            </button>
          ))}
        </div>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3 rounded-xl border border-edge bg-panel p-5 surface shadow-soft"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="rounded-lg border border-edge bg-panel-2 px-3 py-2 outline-none focus:border-accent input-glow"
              placeholder="alice"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              className="rounded-lg border border-edge bg-panel-2 px-3 py-2 outline-none focus:border-accent input-glow"
              placeholder="••••••"
            />
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button type="submit" disabled={busy || !username || !password} className="mt-1">
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
          {mode === 'register' && (
            <p className="text-xs text-muted">
              Username 3–32 chars (letters, digits, _ . -); password 6+ chars.
            </p>
          )}
        </form>
      </div>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
