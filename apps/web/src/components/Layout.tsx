import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { fmt } from '../lib/format.ts';
import { SettingsDialog } from './SettingsDialog.tsx';
import { FlashNumber } from './ui.tsx';

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const navCls = ({ isActive }: { isActive: boolean }) =>
    `relative rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200 ${
      isActive
        ? 'btn-glow-accent bg-grad-accent text-[var(--color-on-accent)]'
        : 'text-muted hover:bg-panel-2/70 hover:text-fg'
    }`;

  // The route's first path segment keys the content so it re-mounts (and the
  // entrance animation re-fires) when you navigate between top-level pages.
  const sectionKey = `/${location.pathname.split('/')[1] ?? ''}`;

  return (
    <div className="min-h-full">
      {/* ambient accent mesh behind everything — two slow-drifting blobs */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 animate-drift"
        style={{
          background:
            'radial-gradient(48rem 30rem at 50% -8%, color-mix(in oklab, var(--color-accent) 15%, transparent), transparent 70%), radial-gradient(34rem 26rem at 96% 4%, color-mix(in oklab, var(--color-accent) 9%, transparent), transparent 64%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 bottom-0 -z-10 h-80 animate-drift"
        style={{
          animationDelay: '-4.5s',
          background:
            'radial-gradient(30rem 20rem at 8% 120%, color-mix(in oklab, var(--color-accent) 8%, transparent), transparent 66%)',
        }}
      />
      <header className="sticky top-0 z-20 border-b border-edge/70 bg-ink/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4">
          <NavLink to="/" className="group mr-3 flex items-center gap-2">
            <span className="text-lg text-accent transition-transform duration-300 [transition-timing-function:var(--ease-spring)] group-hover:rotate-90">
              ◎
            </span>
            <span className="text-gradient text-[15px] font-bold tracking-tight">BMM</span>
            <span className="hidden text-xs text-muted sm:inline">prediction market</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={navCls}>
              Markets
            </NavLink>
            <NavLink to="/portfolio" className={navCls}>
              Portfolio
            </NavLink>
            <NavLink to="/transactions" className={navCls}>
              Transactions
            </NavLink>
            <NavLink to="/guide" className={navCls}>
              Guide
            </NavLink>
            {user?.role === 'admin' && (
              <NavLink to="/admin" className={navCls}>
                Admin
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user && (
              <div className="text-right">
                <div className="text-sm font-medium leading-tight">{user.username}</div>
                <div className="tnum text-xs text-muted leading-tight">
                  {user.isInfinite ? (
                    '∞ balance'
                  ) : (
                    <FlashNumber value={user.balance}>${fmt(user.balance)}</FlashNumber>
                  )}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Preferences"
              title="Preferences"
              className="rounded-lg border border-edge bg-panel-2 p-2 text-muted transition-colors hover:border-accent/50 hover:text-accent"
            >
              <GearIcon />
            </button>
            {user && (
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate('/login');
                }}
                className="rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-sm text-muted transition-colors hover:border-accent/50 hover:text-fg"
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>
      <main key={sectionKey} className="mx-auto max-w-7xl px-4 py-6 animate-fade-up">
        <Outlet />
      </main>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Preferences</title>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
