import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { fmt } from '../lib/format.ts';

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const navCls = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
      isActive ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg'
    }`;

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-edge bg-ink/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4">
          <NavLink to="/" className="mr-3 flex items-center gap-2">
            <span className="text-lg">◎</span>
            <span className="font-semibold tracking-tight">BMM</span>
            <span className="hidden text-xs text-muted sm:inline">prediction market</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={navCls}>
              Markets
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user && (
              <>
                <div className="text-right">
                  <div className="text-sm font-medium leading-tight">{user.username}</div>
                  <div className="tnum text-xs text-muted leading-tight">
                    {user.isInfinite ? '∞ balance' : `$${fmt(user.balance)}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    logout();
                    navigate('/login');
                  }}
                  className="rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-sm text-muted hover:text-fg"
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
