import {
  BELIEF_TAIL,
  type ContractSpec,
  type ContractType,
  contractBeliefCompatible,
} from '@bmm/core';
import type { BeliefStateDTO, ModelTag } from '@bmm/shared';
import { HttpError } from './errors.ts';

export function specFromRow(type: ContractType, params: Record<string, number>): ContractSpec {
  switch (type) {
    case 'LINEAR':
      return { type };
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return { type, strike: params.strike };
    case 'SPREAD':
      return { type, lower: params.lower, upper: params.upper };
    case 'GAUSSIAN':
      return { type, center: params.center, width: params.width };
    case 'SKEW_GAUSSIAN':
      return {
        type,
        center: params.center,
        widthLeft: params.widthLeft,
        widthRight: params.widthRight,
      };
    case 'TENT':
      return { type, center: params.center, width: params.width };
    case 'TRAPEZOID':
      return { type, lower: params.lower, upper: params.upper, width: params.width };
    case 'SIGMOID':
      return { type, center: params.center, width: params.width };
    case 'POLYNOMIAL': {
      // coeffs stored as indexed keys c0,c1,… so `params` stays Record<string,number>.
      const coeffs: number[] = [];
      for (let k = 0; params[`c${k}`] !== undefined; k++) coeffs.push(params[`c${k}`] as number);
      return { type, coeffs };
    }
    case 'EXPONENTIAL':
      return { type, center: params.center, rate: params.rate };
    default:
      throw new Error(`specFromRow: unknown type ${type}`);
  }
}

export function paramsFromSpec(spec: ContractSpec): Record<string, number> {
  switch (spec.type) {
    case 'LINEAR':
      return {};
    case 'CALL':
    case 'PUT':
    case 'BINARY_CALL':
    case 'BINARY_PUT':
      return { strike: spec.strike as number };
    case 'SPREAD':
      return { lower: spec.lower as number, upper: spec.upper as number };
    case 'GAUSSIAN':
      return { center: spec.center as number, width: spec.width as number };
    case 'SKEW_GAUSSIAN':
      return {
        center: spec.center as number,
        widthLeft: spec.widthLeft as number,
        widthRight: spec.widthRight as number,
      };
    case 'TENT':
      return { center: spec.center as number, width: spec.width as number };
    case 'TRAPEZOID':
      return {
        lower: spec.lower as number,
        upper: spec.upper as number,
        width: spec.width as number,
      };
    case 'SIGMOID':
      return { center: spec.center as number, width: spec.width as number };
    case 'POLYNOMIAL': {
      const out: Record<string, number> = {};
      (spec.coeffs as number[]).forEach((a, k) => {
        out[`c${k}`] = a;
      });
      return out;
    }
    case 'EXPONENTIAL':
      return { center: spec.center as number, rate: spec.rate as number };
    default:
      throw new Error(`paramsFromSpec: unknown type ${(spec as ContractSpec).type}`);
  }
}

// Market fields the contract↔belief compatibility guard needs.
interface CompatRow {
  model: ModelTag;
  outcomeMin: number | null;
  outcomeMax: number | null;
  beliefState: BeliefStateDTO | null;
}

// Enforce the contract↔belief integrability + boundedness guard before a
// quote or trade. The v1 / bounded- contracts always pass; the two unbounded
// contracts (POLYNOMIAL / EXPONENTIAL) are rejected with a 400 + explanation
// when they'd diverge on a heavy-tailed belief or lack the bounded outcome support
// an unbounded payoff requires. See @bmm/core `contractBeliefCompatible`.
export function assertContractCompatible(spec: ContractSpec, m: CompatRow): void {
  const outcomeBounded = m.outcomeMin != null && m.outcomeMax != null;
  const outcomeSpan = outcomeBounded
    ? (m.outcomeMax as number) - (m.outcomeMin as number)
    : undefined;
  const nu = m.beliefState?.kind === 'student_t' ? m.beliefState.nu : undefined;
  const r = contractBeliefCompatible(spec, {
    tail: BELIEF_TAIL[m.model],
    nu,
    outcomeBounded,
    outcomeSpan,
  });
  if (!r.ok) throw new HttpError(400, r.reason ?? 'Contract is incompatible with this market');
}
