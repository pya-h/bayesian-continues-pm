import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAdmin, RequireAuth } from './auth/RequireAuth.tsx';
import { Layout } from './components/Layout.tsx';
import { AdminPage } from './pages/AdminPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { LpPage } from './pages/LpPage.tsx';
import { MarketPage } from './pages/MarketPage.tsx';
import { MarketsPage } from './pages/MarketsPage.tsx';
import { PortfolioPage } from './pages/PortfolioPage.tsx';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<MarketsPage />} />
        <Route path="/markets/:id" element={<MarketPage />} />
        <Route path="/markets/:id/lp" element={<LpPage />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
