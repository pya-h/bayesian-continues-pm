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
// `fair` is exact for EVERY belief kind: the caller passes the market's real
// `BeliefModel` (Gaussian, mixture, or Student-t — via `beliefFromView`), so a
// multi-modal or fat-tailed market previews against its true belief, not a
// Gaussian stand-in. The result updates interactively with no network round-trip.

import type { BeliefModel } from '@bmm/core';
import { price } from '@bmm/core';
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
  belief: BeliefModel;
  spreadTotal: number;
}): EstimatedQuote {
  const { spec, signedQ, belief, spreadTotal } = args;
  const fair = price(spec, belief);
  const execPrice = signedQ >= 0 ? fair + spreadTotal : Math.max(0, fair - spreadTotal);
  const totalCost = execPrice * signedQ;
  return { fair, spreadTotal, execPrice, totalCost };
}
