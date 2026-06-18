// Contracts — payoff functions f(θ), validation, canonical keys, and metadata
// (kinks for the solvency fast-path, boundedness for stats).

import type { ContractSpec } from './types.ts';

export const MAX_POLYNOMIAL_DEGREE = 4;

// Largest exponent magnitude evaluated in EXPONENTIAL's payoff. exp(±700) is the
// edge of the double range (~1e304); clamping the exponent there keeps a contrived
// far-tail Monte-Carlo draw from overflowing to ±Infinity and corrupting the reserve
// sort. Real settlements live inside the market's outcome bounds, far from this rail
// so the clamp never touches a meaningful payout (the closed-form MGF price never
// samples pointwise at all)..
const EXP_CLAMP = 700;

function coeffsOf(spec: ContractSpec): number[] {
  const c = spec.coeffs;
  if (!Array.isArray(c) || c.length === 0 || !c.every((v) => Number.isFinite(v))) {
    throw new Error('POLYNOMIAL requires a non-empty finite coeffs array [a₀..aₙ]');
  }
  return c;
}

export function polynomialDegree(coeffs: number[]): number {
  let d = 0;
  for (let k = 0; k < coeffs.length; k++) if (coeffs[k] !== 0) d = k;
  return d;
}

// Payoff f(θ) for a contract.
export function payoff(spec: ContractSpec, theta: number): number {
  switch (spec.type) {
    case 'LINEAR':
      return theta;
    case 'CALL':
      return Math.max(0, theta - req(spec.strike, 'strike'));
    case 'PUT':
      return Math.max(0, req(spec.strike, 'strike') - theta);
    case 'BINARY_CALL':
      return theta >= req(spec.strike, 'strike') ? 1 : 0;
    case 'BINARY_PUT':
      return theta <= req(spec.strike, 'strike') ? 1 : 0;
    case 'SPREAD': {
      const a = req(spec.lower, 'lower');
      const b = req(spec.upper, 'upper');
      return theta >= a && theta <= b ? 1 : 0;
    }
    case 'GAUSSIAN': {
      const c = req(spec.center, 'center');
      const w = req(spec.width, 'width');
      return Math.exp(-((theta - c) ** 2) / (2 * w * w));
    }
    case 'SKEW_GAUSSIAN': {
      // asymmetric bell: width wL below the center, wR above. Peak 1 at c.
      const c = req(spec.center, 'center');
      const w = theta < c ? req(spec.widthLeft, 'widthLeft') : req(spec.widthRight, 'widthRight');
      return Math.exp(-((theta - c) ** 2) / (2 * w * w));
    }
    case 'TENT': {
      // triangle: peak 1 at c, linear down to 0 at c ± w.
      const c = req(spec.center, 'center');
      const w = req(spec.width, 'width');
      return Math.max(0, 1 - Math.abs(theta - c) / w);
    }
    case 'TRAPEZOID': {
      // flat top 1 on [a,b]; linear ramps down to 0 over `w` outside each edge.
      const a = req(spec.lower, 'lower');
      const b = req(spec.upper, 'upper');
      const w = req(spec.width, 'width');
      if (theta >= a && theta <= b) return 1;
      if (theta < a) return Math.max(0, 1 - (a - theta) / w);
      return Math.max(0, 1 - (theta - b) / w);
    }
    case 'SIGMOID': {
      // soft step: 1/(1+e^{-(θ-c)/w}), rising through ½ at c. width = softness.
      const c = req(spec.center, 'center');
      const w = req(spec.width, 'width');
      return 1 / (1 + Math.exp(-(theta - c) / w));
    }
    case 'POLYNOMIAL': {
      // f(θ) = Σ aₖθᵏ, evaluated by Horner. Unbounded.
      const a = coeffsOf(spec);
      let acc = 0;
      for (let k = a.length - 1; k >= 0; k--) acc = acc * theta + (a[k] as number);
      return acc;
    }
    case 'EXPONENTIAL': {
      // f(θ) = exp(a·(θ−c)); exponent clamped for far-tail numeric safety. Unbounded.
      const c = req(spec.center, 'center');
      const a = req(spec.rate, 'rate');
      const z = a * (theta - c);
      return Math.exp(z > EXP_CLAMP ? EXP_CLAMP : z < -EXP_CLAMP ? -EXP_CLAMP : z);
    }
    default:
      throw new Error(`payoff: unknown contract type ${(spec as ContractSpec).type}`);
  }
}

function req(v: number | undefined, name: string): number {
  if (v === undefined || !Number.isFinite(v)) {
    throw new Error(`contract param "${name}" is required and must be finite`);
  }
  return v;
}

export function validateContract(spec: ContractSpec): ContractSpec {
  switch (spec.type) {
    case 'LINEAR':
      break;
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      req(spec.strike, 'strike');
      break;
    case 'SPREAD': {
      const a = req(spec.lower, 'lower');
      const b = req(spec.upper, 'upper');
      if (!(a < b)) throw new Error(`SPREAD requires lower < upper (got ${a}, ${b})`);
      break;
    }
    case 'GAUSSIAN': {
      req(spec.center, 'center');
      const w = req(spec.width, 'width');
      if (!(w > 0)) throw new Error(`GAUSSIAN requires width > 0 (got ${w})`);
      break;
    }
    case 'SKEW_GAUSSIAN': {
      req(spec.center, 'center');
      const wl = req(spec.widthLeft, 'widthLeft');
      const wr = req(spec.widthRight, 'widthRight');
      if (!(wl > 0)) throw new Error(`SKEW_GAUSSIAN requires widthLeft > 0 (got ${wl})`);
      if (!(wr > 0)) throw new Error(`SKEW_GAUSSIAN requires widthRight > 0 (got ${wr})`);
      break;
    }
    case 'TENT': {
      req(spec.center, 'center');
      const w = req(spec.width, 'width');
      if (!(w > 0)) throw new Error(`TENT requires width > 0 (got ${w})`);
      break;
    }
    case 'TRAPEZOID': {
      const a = req(spec.lower, 'lower');
      const b = req(spec.upper, 'upper');
      const w = req(spec.width, 'width');
      if (!(a < b)) throw new Error(`TRAPEZOID requires lower < upper (got ${a}, ${b})`);
      if (!(w > 0)) throw new Error(`TRAPEZOID requires width > 0 (got ${w})`);
      break;
    }
    case 'SIGMOID': {
      req(spec.center, 'center');
      const w = req(spec.width, 'width');
      if (!(w > 0)) throw new Error(`SIGMOID requires width > 0 (got ${w})`);
      break;
    }
    case 'POLYNOMIAL': {
      const a = coeffsOf(spec);
      const deg = a.length - 1;
      if (deg > MAX_POLYNOMIAL_DEGREE) {
        throw new Error(`POLYNOMIAL degree ${deg} exceeds max ${MAX_POLYNOMIAL_DEGREE}`);
      }
      if (polynomialDegree(a) < 1) {
        throw new Error('POLYNOMIAL must be non-constant (some aₖ, k≥1, non-zero)');
      }
      break;
    }
    case 'EXPONENTIAL': {
      req(spec.center, 'center');
      const a = req(spec.rate, 'rate');
      if (a === 0) throw new Error('EXPONENTIAL requires a non-zero rate');
      break;
    }
    default:
      throw new Error(`validateContract: unknown type ${(spec as ContractSpec).type}`);
  }
  return spec;
}

// Round to a stable precision so float noise doesn't fork contract identity.
function norm(v: number): string {
  return Number(v.toPrecision(12)).toString();
}

// Canonical identity key for a contract spec. Two specs that price identically
// map to the same key so MM inventory and user positions aggregate correctly.
export function contractKey(spec: ContractSpec): string {
  switch (spec.type) {
    case 'LINEAR':
      return 'LINEAR';
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return `${spec.type}:K=${norm(spec.strike as number)}`;
    case 'SPREAD':
      return `SPREAD:a=${norm(spec.lower as number)}:b=${norm(spec.upper as number)}`;
    case 'GAUSSIAN':
      return `GAUSSIAN:c=${norm(spec.center as number)}:w=${norm(spec.width as number)}`;
    case 'SKEW_GAUSSIAN':
      return `SKEW_GAUSSIAN:c=${norm(spec.center as number)}:wl=${norm(
        spec.widthLeft as number,
      )}:wr=${norm(spec.widthRight as number)}`;
    case 'TENT':
      return `TENT:c=${norm(spec.center as number)}:w=${norm(spec.width as number)}`;
    case 'TRAPEZOID':
      return `TRAPEZOID:a=${norm(spec.lower as number)}:b=${norm(spec.upper as number)}:w=${norm(
        spec.width as number,
      )}`;
    case 'SIGMOID':
      return `SIGMOID:c=${norm(spec.center as number)}:w=${norm(spec.width as number)}`;
    case 'POLYNOMIAL':
      return `POLYNOMIAL:a=${(spec.coeffs as number[]).map(norm).join(',')}`;
    case 'EXPONENTIAL':
      return `EXPONENTIAL:c=${norm(spec.center as number)}:a=${norm(spec.rate as number)}`;
    default:
      throw new Error(`contractKey: unknown type ${(spec as ContractSpec).type}`);
  }
}

// θ values where the payoff is non-smooth (kinks/jumps) or peaks. The solvency
// fast-path evaluates liability at these plus belief quantiles.
export function payoffKinks(spec: ContractSpec): number[] {
  switch (spec.type) {
    case 'LINEAR':
      return [];
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return [spec.strike as number];
    case 'SPREAD':
      return [spec.lower as number, spec.upper as number];
    case 'GAUSSIAN':
    case 'SIGMOID':
      return [spec.center as number];
    case 'SKEW_GAUSSIAN':
      return [spec.center as number];
    // POLYNOMIAL / EXPONENTIAL are smooth (no kinks) — fall through to [].
    case 'POLYNOMIAL':
    case 'EXPONENTIAL':
      return [];
    case 'TENT': {
      const c = spec.center as number;
      const w = spec.width as number;
      return [c - w, c, c + w];
    }
    case 'TRAPEZOID': {
      const a = spec.lower as number;
      const b = spec.upper as number;
      const w = spec.width as number;
      return [a - w, a, b, b + w];
    }
    default:
      return [];
  }
}

export interface PayoffBounds {
  bounded: boolean;
  // Defined only when bounded.
  max?: number;
  min?: number;
}

// Boundedness + extrema of f(θ), used by stats (max payout etc.).
export function payoffBounds(spec: ContractSpec): PayoffBounds {
  switch (spec.type) {
    case 'BINARY_CALL':
    case 'BINARY_PUT':
    case 'SPREAD':
      return { bounded: true, min: 0, max: 1 };
    // All shape-extensions are bounded bumps/steps in [0,1].
    case 'GAUSSIAN':
    case 'SKEW_GAUSSIAN':
    case 'TENT':
    case 'TRAPEZOID':
    case 'SIGMOID':
      return { bounded: true, min: 0, max: 1 };
    case 'LINEAR':
    case 'CALL':
    case 'PUT':
    // conditionally-compatible contracts are unbounded (gated to
    // bounded-outcome markets by contractBeliefCompatible).
    case 'POLYNOMIAL':
    case 'EXPONENTIAL':
      return { bounded: false };
    default:
      return { bounded: false };
  }
}
