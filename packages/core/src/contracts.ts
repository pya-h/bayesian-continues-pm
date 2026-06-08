// Contracts — payoff functions f(θ), validation, canonical keys, and metadata
// (kinks for the solvency fast-path, boundedness for stats).

import type { ContractSpec } from './types.ts';

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
      return [spec.center as number];
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
    case 'GAUSSIAN':
      return { bounded: true, min: 0, max: 1 };
    case 'LINEAR':
    case 'CALL':
    case 'PUT':
      return { bounded: false };
    default:
      return { bounded: false };
  }
}
