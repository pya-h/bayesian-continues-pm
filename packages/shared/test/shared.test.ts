import { describe, expect, test } from 'bun:test';
import {
  addMoney,
  beliefStateSchema,
  contractSpecSchema,
  createBeliefSchema,
  createMarketSchema,
  marketCfgSchema,
  registerSchema,
  round8,
  subMoney,
  sumMoney,
} from '../src/index.ts';

describe('money', () => {
  test('round8 round-half-even', () => {
    expect(round8(0.123456785)).toBe(0.12345678); // tie → even (…78)
    expect(round8(0.123456795)).toBe(0.1234568); // tie → even (…80)
    expect(round8(1.000000004)).toBe(1);
    expect(round8(2.5e-9)).toBe(0); // below precision
  });

  test('add/sub keep 8dp without float drift', () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(subMoney(0.3, 0.1)).toBe(0.2);
    expect(sumMoney([0.1, 0.1, 0.1])).toBe(0.3);
  });
});

describe('contractSpecSchema', () => {
  test('valid specs parse and round-trip', () => {
    for (const spec of [
      { type: 'LINEAR' },
      { type: 'CALL', strike: 100 },
      { type: 'SPREAD', lower: 90, upper: 110 },
      { type: 'GAUSSIAN', center: 100, width: 5 },
    ]) {
      const parsed = contractSpecSchema.parse(spec);
      expect(parsed).toEqual(spec as never);
    }
  });

  test('CALL without strike rejected', () => {
    expect(contractSpecSchema.safeParse({ type: 'CALL' }).success).toBe(false);
  });

  test('SPREAD with lower ≥ upper rejected', () => {
    expect(contractSpecSchema.safeParse({ type: 'SPREAD', lower: 110, upper: 90 }).success).toBe(
      false,
    );
  });

  test('GAUSSIAN with non-positive width rejected', () => {
    expect(contractSpecSchema.safeParse({ type: 'GAUSSIAN', center: 100, width: 0 }).success).toBe(
      false,
    );
  });

  test('outcome-axis magnitudes beyond the 1e12 ceiling rejected (C46)', () => {
    // huge strikes/centers used to overflow (θ−μ)² → NaN / silent belief corruption
    expect(contractSpecSchema.safeParse({ type: 'CALL', strike: 1e9 }).success).toBe(true);
    expect(contractSpecSchema.safeParse({ type: 'CALL', strike: 1e13 }).success).toBe(false);
    expect(contractSpecSchema.safeParse({ type: 'CALL', strike: 1e155 }).success).toBe(false);
    expect(
      contractSpecSchema.safeParse({ type: 'SPREAD', lower: -1e300, upper: 1e300 }).success,
    ).toBe(false);
    expect(
      contractSpecSchema.safeParse({ type: 'GAUSSIAN', center: 0, width: 1e200 }).success,
    ).toBe(false);
  });
});

describe('auth & market DTOs', () => {
  test('register validates username charset & lengths', () => {
    expect(registerSchema.safeParse({ username: 'ab', password: 'secret' }).success).toBe(false);
    expect(registerSchema.safeParse({ username: 'alice', password: '123' }).success).toBe(false);
    expect(registerSchema.safeParse({ username: 'alice_1', password: 'secret1' }).success).toBe(
      true,
    );
  });

  test('createMarket requires core fields; cfg overrides optional', () => {
    const ok = createMarketSchema.safeParse({
      title: 'BTC EOM',
      outcomeUnit: 'USD',
      initialMu: 65000,
      initialSigma: 5000,
      initialReserve: 1_000_000,
      cfg: { s0: 0.012, reserveAlpha: 0.99 },
    });
    expect(ok.success).toBe(true);
    expect(createMarketSchema.safeParse({ title: 'x' }).success).toBe(false);
  });

  test('marketCfg rejects reserveAlpha out of (0,1)', () => {
    expect(marketCfgSchema.safeParse({ reserveAlpha: 1 }).success).toBe(false);
    expect(marketCfgSchema.safeParse({ reserveAlpha: 0.99 }).success).toBe(true);
  });
});

// Multi-model refactor: the new belief variants parse and round-trip
// but are otherwise unwired (no service constructs them yet).
describe('gen_basis / gen_exact schemas (G0 scaffolding)', () => {
  test('createBelief round-trips for all five kinds', () => {
    const inputs = [
      { kind: 'gaussian' },
      {
        kind: 'mixture',
        components: [
          { pi: 0.5, mu: 0, sigma: 1 },
          { pi: 0.5, mu: 5, sigma: 1 },
        ],
      },
      { kind: 'student_t', nu: 4 },
      { kind: 'gen_basis', bumps: [{ mu: 0, sigma: 1, weight: 1 }] },
      { kind: 'gen_exact', lambdas: [1, 0, 0] },
    ];
    for (const input of inputs) {
      const parsed = createBeliefSchema.parse(input);
      expect(parsed).toEqual(input as never);
    }
  });

  test('createBelief gen_basis enforces ≥1 bump and the 12-bump cap', () => {
    expect(createBeliefSchema.safeParse({ kind: 'gen_basis', bumps: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 13 }, (_, i) => ({ mu: i, sigma: 1, weight: 1 }));
    expect(createBeliefSchema.safeParse({ kind: 'gen_basis', bumps: tooMany }).success).toBe(false);
    expect(
      createBeliefSchema.safeParse({ kind: 'gen_basis', bumps: [{ mu: 0, sigma: 0, weight: 1 }] })
        .success,
    ).toBe(false); // σ must be positive
  });

  test('createBelief gen_exact requires exactly three λ', () => {
    expect(createBeliefSchema.safeParse({ kind: 'gen_exact', lambdas: [1, 0] }).success).toBe(
      false,
    );
    expect(createBeliefSchema.safeParse({ kind: 'gen_exact', lambdas: [1, 0, 0, 0] }).success).toBe(
      false,
    );
  });

  test('belief_state round-trips a gen_exact snapshot', () => {
    const state = { kind: 'gen_exact', mu: 2, sigma: 1.5, lambdas: [1, 0.2, 0.1] };
    expect(beliefStateSchema.parse(state)).toEqual(state as never);
  });
});
