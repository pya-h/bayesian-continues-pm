// The "primary" outcome-axis parameter of a contract — its strike (CALL/PUT/binary)
// center (bell family / sigmoid / exponential) or interval midpoint (spread /
// trapezoid). Sweeping THIS parameter across the outcome axis and pricing at each
// point is what the fair-price chart draws: "what would this contract cost if its
// strike/center sat at θ?". Shared by the price-vs-strike panel and the belief
// chart's price overlay so the two never diverge.

import type { ContractSpec } from './types.ts';

export function withParam(spec: ContractSpec, x: number): ContractSpec | null {
  switch (spec.type) {
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return { ...spec, strike: x };
    case 'GAUSSIAN':
    case 'SKEW_GAUSSIAN':
    case 'TENT':
    case 'SIGMOID':
    case 'EXPONENTIAL':
      return { ...spec, center: x };
    case 'SPREAD': {
      const half = (spec.upper - spec.lower) / 2;
      return { type: 'SPREAD', lower: x - half, upper: x + half };
    }
    case 'TRAPEZOID': {
      const half = (spec.upper - spec.lower) / 2;
      return { ...spec, lower: x - half, upper: x + half };
    }
    default:
      return null; // LINEAR has no strike-like parameter
  }
}

export function currentParam(spec: ContractSpec): number | null {
  switch (spec.type) {
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return spec.strike;
    case 'GAUSSIAN':
    case 'SKEW_GAUSSIAN':
    case 'TENT':
    case 'SIGMOID':
    case 'EXPONENTIAL':
      return spec.center;
    case 'SPREAD':
    case 'TRAPEZOID':
      return (spec.lower + spec.upper) / 2;
    default:
      return null;
  }
}

export function paramLabel(type: ContractSpec['type']): string {
  if (
    type === 'GAUSSIAN' ||
    type === 'SKEW_GAUSSIAN' ||
    type === 'TENT' ||
    type === 'SIGMOID' ||
    type === 'EXPONENTIAL'
  )
    return 'c';
  if (type === 'SPREAD' || type === 'TRAPEZOID') return 'mid';
  return 'K';
}

// A stable key for the SHAPE of the price-vs-parameter curve, independent of the
// swept parameter's value. Sliding a CALL's strike just moves the dot ALONG an
// invariant curve, so the curve can be memoised on this key; width-bearing kinds
// (spread / bell / tent / …) reshape as their non-swept params change, so those
// are folded in. Used to keep a handle-drag re-pricing one dot, not the whole sweep.
export function sweepKey(spec: ContractSpec): string {
  switch (spec.type) {
    case 'GAUSSIAN':
      return `G:${spec.width}`;
    case 'SPREAD':
      return `S:${spec.upper - spec.lower}`;
    case 'SKEW_GAUSSIAN':
      return `SK:${spec.widthLeft}:${spec.widthRight}`;
    case 'TENT':
      return `T:${spec.width}`;
    case 'SIGMOID':
      return `SG:${spec.width}`;
    case 'TRAPEZOID':
      return `TR:${spec.upper - spec.lower}:${spec.width}`;
    default:
      return spec.type; // strike family: curve is independent of the strike value
  }
}

export function reshapesWhileDragging(type: ContractSpec['type']): boolean {
  return (
    type === 'SPREAD' ||
    type === 'GAUSSIAN' ||
    type === 'SKEW_GAUSSIAN' ||
    type === 'TENT' ||
    type === 'TRAPEZOID' ||
    type === 'SIGMOID'
  );
}
