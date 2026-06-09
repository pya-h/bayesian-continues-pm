// Guide — a friendly, user-facing explainer for traders and LPs. Tabbed sections
// (Concepts / Trading / Portfolio / Liquidity / FAQ) kept deliberately short: just
// enough to know what each thing means and how to act on it. No engine internals.

import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';

type TabId = 'concepts' | 'trading' | 'portfolio' | 'liquidity' | 'faq';

const TABS: { id: TabId; label: string; icon: string; blurb: string }[] = [
  { id: 'concepts', label: 'Concepts', icon: '◎', blurb: 'The basics' },
  { id: 'trading', label: 'Trading', icon: '⇄', blurb: 'Place a trade' },
  { id: 'portfolio', label: 'Portfolio', icon: '◫', blurb: 'Track P&L' },
  { id: 'liquidity', label: 'Liquidity', icon: '≋', blurb: 'Be an LP' },
  { id: 'faq', label: 'FAQ', icon: '?', blurb: 'Quick answers' },
];

export function GuidePage() {
  const [tab, setTab] = useState<TabId>('concepts');

  return (
    <div className="flex flex-col gap-5">
      {/* hero */}
      <div className="relative overflow-hidden rounded-2xl border border-edge bg-panel p-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-0 opacity-70"
          style={{
            background:
              'radial-gradient(34rem 18rem at 12% -20%, color-mix(in oklab, var(--color-accent) 22%, transparent), transparent 70%)',
          }}
        />
        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-panel-2 px-2.5 py-1 text-[11px] font-medium text-muted">
            <span className="text-accent">◎</span> Guide
          </span>
          <h1 className="text-gradient mt-3 text-2xl font-semibold tracking-tight">
            How BMM works
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            A quick tour for traders and liquidity providers — what the numbers mean and how to act
            on them. Pick a topic.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        {/* tab rail */}
        <nav className="flex gap-2 overflow-x-auto lg:w-52 lg:shrink-0 lg:flex-col lg:overflow-visible">
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`group flex shrink-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all duration-200 ${
                  active
                    ? 'border-accent/40 bg-accent-soft text-fg shadow-sm'
                    : 'border-edge bg-panel text-muted hover:border-muted hover:text-fg'
                }`}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base transition-colors ${
                    active ? 'bg-accent text-[var(--color-on-accent)]' : 'bg-panel-2 text-muted'
                  }`}
                >
                  {t.icon}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-semibold">{t.label}</span>
                  <span className="hidden text-[11px] text-muted lg:block">{t.blurb}</span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* content */}
        <div key={tab} className="min-w-0 flex-1 animate-fade-up">
          {tab === 'concepts' && <Concepts />}
          {tab === 'trading' && <Trading />}
          {tab === 'portfolio' && <Portfolio />}
          {tab === 'liquidity' && <Liquidity />}
          {tab === 'faq' && <Faq />}
        </div>
      </div>
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-edge bg-panel p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {icon && <span className="text-accent">{icon}</span>}
        {title}
      </h2>
      <div className="mt-3 flex flex-col gap-3 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function Term({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 rounded-lg border border-edge bg-panel-2/40 p-3 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <span className="font-semibold text-fg">{name}</span>
      <span>{children}</span>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
        {n}
      </span>
      <div className="flex flex-col gap-0.5 pt-0.5">
        <span className="font-semibold text-fg">{title}</span>
        <span>{children}</span>
      </div>
    </div>
  );
}

function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-sm text-fg">
      💡 {children}
    </div>
  );
}

function Concepts() {
  return (
    <div className="flex flex-col gap-4">
      <Card title="What is a prediction market?" icon="◎">
        <p>
          Every market asks one numeric question — <em>“what will θ be?”</em> — like a final price,
          a count, or a date. As people trade, the market keeps a live best-guess. Trade when you
          think that guess is wrong, and you profit if the real outcome proves you right.
        </p>
      </Card>

      <Card title="The two numbers that drive a market" icon="✶">
        <Term name="Consensus μ">
          The market’s current best guess for the outcome. The big number on each market.
        </Term>
        <Term name="Uncertainty σ">
          How unsure the market is. Smaller σ = a tight, confident estimate; larger σ = wide open.
          The shaded bell on the chart shows how likely each outcome is.
        </Term>
        <Term name="Outcome θ">
          The real value, revealed when the market resolves. All payouts are settled against it.
        </Term>
      </Card>

      <Card title="Contracts — the bets you can make" icon="⇄">
        <p>A contract decides how your payout depends on the final outcome θ:</p>
        <Term name="Call / Put">Pays more the further θ ends up above / below a strike.</Term>
        <Term name="Binary ≥ / ≤">
          Pays a flat 1 if θ lands above / below a strike, otherwise 0.
        </Term>
        <Term name="Spread">Pays 1 if θ lands inside a range you choose, else 0.</Term>
        <Term name="Bell">Pays the most when θ lands near a center value you pick.</Term>
        <Term name="Linear">Pays θ itself — a straight bet on the number going up.</Term>
      </Card>

      <Card title="Fair price & spread" icon="$">
        <p>
          The <strong className="text-fg">fair price</strong> is what one contract is worth right
          now — its probability or expected payout. You buy slightly above it and sell slightly
          below it; that small gap is the <strong className="text-fg">spread</strong>, the cost of
          trading. Larger orders move the price, so they cost a little more per contract.
        </p>
      </Card>
    </div>
  );
}

function Trading() {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Placing a trade" icon="⇄">
        <Step n={1} title="Choose a contract">
          Drag the handles on the belief chart, or use the composer to pick a Call, Binary, Spread,
          and set the strike.
        </Step>
        <Step n={2} title="Pick a side and size">
          <strong className="text-buy">Buy</strong> if you think it’s underpriced,{' '}
          <strong className="text-sell">Sell</strong> to take the other side or close a holding.
          Enter how many contracts.
        </Step>
        <Step n={3} title="Read the quote">
          See the exec price and exactly what you’ll pay or receive, including the spread breakdown.
        </Step>
        <Step n={4} title="Check the analysis, then submit">
          The Trade analysis panel shows your best/worst cases live as you change inputs. Hit the
          button to fill.
        </Step>
      </Card>

      <Card title="Reading the Trade analysis" icon="◷">
        <Term name="Max payout">The most the contracts could ever pay you.</Term>
        <Term name="Max profit / loss">Best- and worst-case net result of the order.</Term>
        <Term name="Expected P&L">
          Your average result, weighted by how likely each outcome is.
        </Term>
        <Term name="Win chance">The market-implied probability the order ends in profit.</Term>
        <Term name="Breakeven θ">The outcome at which you neither gain nor lose.</Term>
        <Callout>
          When you <strong>sell contracts you already hold</strong>, this flips to{' '}
          <strong>Payout</strong> and <strong>Profit</strong> — measured against what you originally
          paid, since the result is now locked in.
        </Callout>
      </Card>

      <Card title="Slippage guard" icon="🛡">
        <p>
          Prices move while you trade. The guard caps how far the price can drift against you
          between the quote and the fill — if it would move past your band, the trade is rejected
          instead of filling at a worse price. Leave it on unless you specifically want to fill at
          any price.
        </p>
      </Card>
    </div>
  );
}

function Portfolio() {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Your positions" icon="◫">
        <p>
          The Portfolio page groups everything you hold by market. For each position you’ll see:
        </p>
        <Term name="Cost basis">What you paid to open the position.</Term>
        <Term name="Unrealized P&L">
          Your paper gain or loss right now, if you closed at the current mark.
        </Term>
        <Term name="Realized P&L">Profit you’ve already locked in by selling or settling.</Term>
      </Card>

      <Card title="The payoff chart" icon="📈">
        <p>
          Each position draws a small curve of your profit/loss across every possible outcome θ.
          Green is profit, red is loss, and the marker shows where the market currently expects θ to
          land — so you can see at a glance whether the consensus is on your side.
        </p>
      </Card>

      <Card title="Claiming payouts" icon="🎉">
        <p>
          When a market resolves and settles, any winnings are yours to claim. A banner appears on
          the settled market — hit <strong className="text-fg">Claim</strong> and the payout is
          credited to your balance.
        </p>
      </Card>
    </div>
  );
}

function Liquidity() {
  return (
    <div className="flex flex-col gap-4">
      <Card title="What a liquidity provider does" icon="≋">
        <p>
          Liquidity providers (LPs) fund a market so traders always have someone to trade against.
          You deposit cash into the pool and receive <strong className="text-fg">shares</strong> of
          it in return.
        </p>
      </Card>

      <Card title="How you earn — and what you risk" icon="⚖">
        <p>
          You collect the <strong className="text-fg">spread</strong> on every trade that happens in
          the market. In exchange you take the other side of traders’ bets, so the pool’s value
          rises or falls as the outcome resolves. Steady spread income, with real exposure to the
          result.
        </p>
        <Callout>
          LPing can lose money if traders are right and the outcome moves against the pool. Size
          your deposit accordingly.
        </Callout>
      </Card>

      <Card title="Shares, NAV & withdrawing" icon="$">
        <Term name="NAV">The pool’s total value — its cash plus what it owes traders.</Term>
        <Term name="Share price">
          NAV ÷ total shares. Deposits mint shares at the current price.
        </Term>
        <Term name="Withdraw">Burns your shares back into cash at the current share price.</Term>
        <Term name="After settlement">
          Claim your share of the final pool once the market settles.
        </Term>
      </Card>
    </div>
  );
}

function Faq() {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Quick answers" icon="?">
        <Faqitem q="Where does my money go when I buy?">
          It’s held as the market’s reserve to back your potential payout, and returned — with your
          profit or loss — when you sell or the market settles.
        </Faqitem>
        <Faqitem q="What’s the difference between μ and θ?">
          μ is the market’s live estimate that moves with trading; θ is the actual answer revealed
          at resolution. Payouts settle against θ.
        </Faqitem>
        <Faqitem q="Why was my fill price different from the fair price?">
          The spread, plus your own size: bigger orders move the price, so they fill a little away
          from the mid.
        </Faqitem>
        <Faqitem q="Can I lose more than I put in?">
          Buying — no, your loss is capped at what you paid. Selling short or providing liquidity —
          yes, losses can exceed the premium you received.
        </Faqitem>
        <Faqitem q="What happens if a market is suspended?">
          Trading pauses (often a safety circuit-breaker). Your positions are untouched and you can
          trade again when it reopens.
        </Faqitem>
      </Card>

      <div className="rounded-2xl border border-edge bg-panel p-5 text-sm text-muted">
        Ready to try it?{' '}
        <Link to="/" className="font-semibold text-accent hover:underline">
          Browse markets →
        </Link>
      </div>
    </div>
  );
}

function Faqitem({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="border-b border-edge pb-3 last:border-0 last:pb-0">
      <p className="font-semibold text-fg">{q}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}
