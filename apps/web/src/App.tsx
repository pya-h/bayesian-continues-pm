import { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

type Health = {
  status: string;
  service: string;
  versions: Record<string, string>;
  time: string;
};

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 640 }}>
      <h1>BMM — Continuous Prediction Market</h1>
      <p style={{ color: '#666' }}>Phase 0 scaffold. Backend connectivity check:</p>
      {error && <pre style={{ color: 'crimson' }}>API unreachable: {error}</pre>}
      {health ? (
        <pre style={{ background: '#f4f4f5', padding: '1rem', borderRadius: 8 }}>
          {JSON.stringify(health, null, 2)}
        </pre>
      ) : (
        !error && <p>Contacting API…</p>
      )}
    </main>
  );
}
