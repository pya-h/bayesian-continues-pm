// Client-side ESTIMATE of a server quote, for the interactive live-preview mode.
// The server quote has three moving parts: the fair value (closed-form E_p[f(θ)])
// the spread (which needs the maker's inventory / book / config — state the client
// doesn't have), and the exec price derived from the two. Of these, only `fair`
// can be reproduced exactly on the client — and it is the part that actually moves
// as the user drags the contract's shape. So the estimate recomputes `fair` from
// `@bmm/core` every frame and holds the spread constant at the last real server
// quote's value, which is a good proxy because the spread varies slowly with the
// contract shape relative to the fair value. execPrice / totalCost then follow the
// engine's own formulas (apps/api tradeMath: ask = fair + spread, bid = max(0
// fair − spread); totalCost = execPrice · signedQ).
// The result is exact in `fair` and a close estimate in cost — and it updates
// interactively, with no network round-trip, while the curve is being dragged.

import { GaussianBelief, price } from '@bmm/core';
import type { ContractSpec } from './types.ts';

export interface EstimatedQuote {
  fair: number;
  spreadTotal: number;
  execPrice: number;
  totalCost: number;
}

export function estimateQuote(args: {
  spec: ContractSpec;
  signedQ: number;
  mu: number;
  sigma: number;
  spreadTotal: number;
}): EstimatedQuote {
  const { spec, signedQ, mu, sigma, spreadTotal } = args;
  const sd = sigma > 0 ? sigma : 1e-6;
  const fair = price(spec, new GaussianBelief(mu, sd * sd));
  const execPrice = signedQ >= 0 ? fair + spreadTotal : Math.max(0, fair - spreadTotal);
  const totalCost = execPrice * signedQ;
  return { fair, spreadTotal, execPrice, totalCost };
}
