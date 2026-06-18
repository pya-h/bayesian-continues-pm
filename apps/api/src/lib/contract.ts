import type { ContractSpec, ContractType } from '@bmm/core';

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
    default:
      throw new Error(`paramsFromSpec: unknown type ${(spec as ContractSpec).type}`);
  }
}
