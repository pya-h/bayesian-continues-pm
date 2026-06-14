import { describe, expect, test } from 'bun:test';
import {
  BELIEF_TAIL,
  type ContractSpec,
  type ModelTag,
  type TailKind,
  contractBeliefCompatible,
} from '../src/index.ts';

describe('BELIEF_TAIL', () => {
  test('Gaussian-derived models decay Gaussian; only Student-t is heavy-tailed', () => {
    const gaussianTailed: ModelTag[] = ['gaussian', 'mixture', 'gen_basis', 'gen_exact'];
    for (const m of gaussianTailed) expect(BELIEF_TAIL[m]).toBe('gaussian');
    expect(BELIEF_TAIL.student_t).toBe('polynomial');
  });

  test('covers every model tag', () => {
    const tags: ModelTag[] = ['gaussian', 'student_t', 'mixture', 'gen_basis', 'gen_exact'];
    for (const m of tags) expect(BELIEF_TAIL[m]).toBeDefined();
    expect(Object.keys(BELIEF_TAIL).sort()).toEqual([...tags].sort());
  });
});

describe('contractBeliefCompatible (G0 stub)', () => {
  test('accepts every current contract under both tails', () => {
    const specs: ContractSpec[] = [
      { type: 'LINEAR' },
      { type: 'CALL', strike: 100 },
      { type: 'PUT', strike: 100 },
      { type: 'BINARY_CALL', strike: 100 },
      { type: 'BINARY_PUT', strike: 100 },
      { type: 'SPREAD', lower: 90, upper: 110 },
      { type: 'GAUSSIAN', center: 100, width: 5 },
    ];
    const tails: TailKind[] = ['gaussian', 'polynomial'];
    for (const spec of specs) {
      for (const tail of tails) expect(contractBeliefCompatible(spec, tail)).toBe(true);
    }
  });
});
