import type { TapeEntry } from '../hooks/useMarketSocket.ts';
import { fmt } from '../lib/format.ts';

export function TradesTape({ tape }: { tape: TapeEntry[] }) {
  if (tape.length === 0) {
    return <p className="p-4 text-sm text-muted">Watching for trades…</p>;
  }
  return (
    <div className="max-h-64 overflow-y-auto">
      <table className="w-full text-xs tnum">
        <thead className="sticky top-0 bg-panel text-muted">
          <tr className="text-left">
            <th className="px-4 py-1.5 font-medium">Side</th>
            <th className="px-2 py-1.5 text-right font-medium">Qty</th>
            <th className="px-2 py-1.5 text-right font-medium">Exec</th>
            <th className="px-4 py-1.5 text-right font-medium">Fair</th>
          </tr>
        </thead>
        <tbody>
          {tape.map((t) => (
            <tr key={t.tradeId} className="border-t border-edge/60">
              <td
                className={`px-4 py-1.5 font-semibold ${t.side === 'buy' ? 'text-buy' : 'text-sell'}`}
              >
                {t.side === 'buy' ? '▲ buy' : '▼ sell'}
              </td>
              <td className="px-2 py-1.5 text-right">{fmt(Math.abs(t.q), 2)}</td>
              <td className="px-2 py-1.5 text-right">{fmt(t.execPrice)}</td>
              <td className="px-4 py-1.5 text-right text-muted">{fmt(t.fair)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
