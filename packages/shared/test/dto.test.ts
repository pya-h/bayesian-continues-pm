import { describe, expect, test } from 'bun:test';
import { OracleMode, UserRole } from '../src/enums.ts';
import {
  beliefStateSchema,
  createBeliefSchema,
  createMarketSchema,
  createMarketSchemaChecked,
  disputeSchema,
  oracleResolveSchema,
  resolveDisputeSchema,
  setRoleSchema,
} from '../src/index.ts';

// A minimal valid createMarket body; spread/override per case.
const baseMarket = {
  title: 'BTC EOM',
  outcomeUnit: 'USD',
  initialMu: 65000,
  initialSigma: 5000,
  initialReserve: 1_000_000,
};

// Net-new DTO coverage: the createMarket cross-field superRefine (oracle modes +
// bounds), numeric-floor rules on the market scalars, the create-belief variants'
// bad paths (mixture cardinality / weights, student-t ν, unknown kind), and the
// dispute / resolve / oracle / setRole input schemas. shared.test.ts already
// covers contractSpec, gen_basis/gen_exact, register, and marketCfg.

describe('createMarket — oracle-mode superRefine (createMarketSchemaChecked)', () => {
  test('api mode WITHOUT oracleToken is rejected', () => {
    const r = createMarketSchemaChecked.safeParse({
      ...baseMarket,
      oracleMode: OracleMode.API,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('oracleToken'))).toBe(true);
    }
  });

  test('api mode WITH oracleToken is accepted', () => {
    expect(
      createMarketSchemaChecked.safeParse({
        ...baseMarket,
        oracleMode: OracleMode.API,
        oracleToken: 'BTC',
      }).success,
    ).toBe(true);
  });

  test('centralized mode without oracleUserId is accepted (admin-resolved default)', () => {
    expect(
      createMarketSchemaChecked.safeParse({
        ...baseMarket,
        oracleMode: OracleMode.CENTRALIZED,
      }).success,
    ).toBe(true);
  });

  test('centralized with a valid oracleUserId UUID is accepted; a non-UUID is rejected', () => {
    expect(
      createMarketSchemaChecked.safeParse({
        ...baseMarket,
        oracleMode: OracleMode.CENTRALIZED,
        oracleUserId: '11111111-1111-1111-1111-111111111111',
      }).success,
    ).toBe(true);
    expect(
      createMarketSchemaChecked.safeParse({
        ...baseMarket,
        oracleMode: OracleMode.CENTRALIZED,
        oracleUserId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  test('decentralized mode is accepted (placeholder, no extra fields required)', () => {
    expect(
      createMarketSchemaChecked.safeParse({
        ...baseMarket,
        oracleMode: OracleMode.DECENTRALIZED,
      }).success,
    ).toBe(true);
  });

  test('an unknown oracleMode value is rejected by the nativeEnum', () => {
    expect(
      createMarketSchemaChecked.safeParse({ ...baseMarket, oracleMode: 'manual' }).success,
    ).toBe(false);
  });
});

describe('createMarket — bounds & numeric floors', () => {
  test('outcomeMin ≥ outcomeMax is rejected by the checked schema', () => {
    expect(
      createMarketSchemaChecked.safeParse({
        ...baseMarket,
        outcomeMin: 100,
        outcomeMax: 100,
      }).success,
    ).toBe(false);
    expect(
      createMarketSchemaChecked.safeParse({
        ...baseMarket,
        outcomeMin: 200,
        outcomeMax: 100,
      }).success,
    ).toBe(false);
    expect(
      createMarketSchemaChecked.safeParse({
        ...baseMarket,
        outcomeMin: 0,
        outcomeMax: 100,
      }).success,
    ).toBe(true);
  });

  test('the bounds rule lives in the superRefine, NOT the base object schema', () => {
    // The plain object schema validates fields independently — it does not run the
    // cross-field outcomeMin<outcomeMax check. Documents which schema enforces what.
    expect(
      createMarketSchema.safeParse({ ...baseMarket, outcomeMin: 200, outcomeMax: 100 }).success,
    ).toBe(true);
  });

  test('initialSigma must be finite & positive (spread)', () => {
    expect(createMarketSchema.safeParse({ ...baseMarket, initialSigma: 0 }).success).toBe(false);
    expect(createMarketSchema.safeParse({ ...baseMarket, initialSigma: -1 }).success).toBe(false);
  });

  test('initialReserve must be positive (zero / negative rejected)', () => {
    expect(createMarketSchema.safeParse({ ...baseMarket, initialReserve: 0 }).success).toBe(false);
    expect(createMarketSchema.safeParse({ ...baseMarket, initialReserve: -5 }).success).toBe(false);
  });

  test('initialMu beyond the ±1e12 outcome ceiling is rejected', () => {
    expect(createMarketSchema.safeParse({ ...baseMarket, initialMu: 1e13 }).success).toBe(false);
    expect(createMarketSchema.safeParse({ ...baseMarket, initialMu: -1e13 }).success).toBe(false);
  });

  test('initialSigma beyond the 1e12 spread ceiling is rejected', () => {
    expect(createMarketSchema.safeParse({ ...baseMarket, initialSigma: 1e13 }).success).toBe(false);
  });

  test('disputeWindowSec must be a non-negative integer within the 30-day cap', () => {
    expect(createMarketSchema.safeParse({ ...baseMarket, disputeWindowSec: 0 }).success).toBe(true);
    expect(createMarketSchema.safeParse({ ...baseMarket, disputeWindowSec: -1 }).success).toBe(
      false,
    );
    expect(createMarketSchema.safeParse({ ...baseMarket, disputeWindowSec: 1.5 }).success).toBe(
      false,
    );
    expect(
      createMarketSchema.safeParse({ ...baseMarket, disputeWindowSec: 30 * 24 * 3600 }).success,
    ).toBe(true);
    expect(
      createMarketSchema.safeParse({ ...baseMarket, disputeWindowSec: 30 * 24 * 3600 + 1 }).success,
    ).toBe(false);
  });

  test('non-ISO datetime strings for opensAt/closesAt are rejected', () => {
    expect(createMarketSchema.safeParse({ ...baseMarket, opensAt: 'tomorrow' }).success).toBe(
      false,
    );
    expect(
      createMarketSchema.safeParse({ ...baseMarket, closesAt: '2026-06-24T00:00:00.000Z' }).success,
    ).toBe(true);
  });

  test('title length and outcomeUnit are enforced', () => {
    expect(createMarketSchema.safeParse({ ...baseMarket, title: '' }).success).toBe(false);
    expect(createMarketSchema.safeParse({ ...baseMarket, outcomeUnit: '' }).success).toBe(false);
    expect(
      createMarketSchema.safeParse({ ...baseMarket, outcomeUnit: 'x'.repeat(21) }).success,
    ).toBe(false);
  });
});

describe('createBelief — variant bad paths', () => {
  test('mixture requires between 2 and 6 components', () => {
    // 1 component fails the.min(2)
    expect(
      createBeliefSchema.safeParse({
        kind: 'mixture',
        components: [{ pi: 1, mu: 0, sigma: 1 }],
      }).success,
    ).toBe(false);
    // empty fails too
    expect(createBeliefSchema.safeParse({ kind: 'mixture', components: [] }).success).toBe(false);
    // 7 components exceeds.max(6)
    const seven = Array.from({ length: 7 }, (_, i) => ({ pi: 1, mu: i, sigma: 1 }));
    expect(createBeliefSchema.safeParse({ kind: 'mixture', components: seven }).success).toBe(
      false,
    );
    // exactly 2 and exactly 6 are the inclusive boundaries
    const six = Array.from({ length: 6 }, (_, i) => ({ pi: 1, mu: i, sigma: 1 }));
    expect(createBeliefSchema.safeParse({ kind: 'mixture', components: six }).success).toBe(true);
  });

  test('mixture component pi must be positive and sigma positive', () => {
    // pi = 0 violates `positive`
    expect(
      createBeliefSchema.safeParse({
        kind: 'mixture',
        components: [
          { pi: 0, mu: 0, sigma: 1 },
          { pi: 1, mu: 5, sigma: 1 },
        ],
      }).success,
    ).toBe(false);
    // negative pi
    expect(
      createBeliefSchema.safeParse({
        kind: 'mixture',
        components: [
          { pi: -0.5, mu: 0, sigma: 1 },
          { pi: 1, mu: 5, sigma: 1 },
        ],
      }).success,
    ).toBe(false);
    // sigma = 0 violates `spread`
    expect(
      createBeliefSchema.safeParse({
        kind: 'mixture',
        components: [
          { pi: 1, mu: 0, sigma: 0 },
          { pi: 1, mu: 5, sigma: 1 },
        ],
      }).success,
    ).toBe(false);
  });

  test('mixture weights are NOT required to normalise to 1 (no such schema rule)', () => {
    // Each pi is just `positive`; the schema imposes no Σπ = 1 constraint. Weights
    // far from summing to 1 still parse — normalisation is a server-side concern.
    expect(
      createBeliefSchema.safeParse({
        kind: 'mixture',
        components: [
          { pi: 10, mu: 0, sigma: 1 },
          { pi: 7, mu: 5, sigma: 2 },
        ],
      }).success,
    ).toBe(true);
  });

  test('student_t requires ν strictly greater than 2 (finite-variance)', () => {
    expect(createBeliefSchema.safeParse({ kind: 'student_t', nu: 2 }).success).toBe(false);
    expect(createBeliefSchema.safeParse({ kind: 'student_t', nu: 1 }).success).toBe(false);
    expect(createBeliefSchema.safeParse({ kind: 'student_t', nu: 2.0001 }).success).toBe(true);
    expect(
      createBeliefSchema.safeParse({ kind: 'student_t', nu: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
  });

  test('the discriminated union rejects an unknown belief kind', () => {
    expect(createBeliefSchema.safeParse({ kind: 'cauchy' }).success).toBe(false);
    expect(createBeliefSchema.safeParse({ kind: 'mixture' }).success).toBe(false); // missing components
  });

  test('gen_basis bump weight must be positive', () => {
    expect(
      createBeliefSchema.safeParse({
        kind: 'gen_basis',
        bumps: [{ mu: 0, sigma: 1, weight: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe('beliefState — persisted snapshot bad paths', () => {
  test('gaussian state requires positive variance (sigma2)', () => {
    expect(beliefStateSchema.safeParse({ kind: 'gaussian', mu: 0, sigma2: 1 }).success).toBe(true);
    expect(beliefStateSchema.safeParse({ kind: 'gaussian', mu: 0, sigma2: 0 }).success).toBe(false);
    expect(beliefStateSchema.safeParse({ kind: 'gaussian', mu: 0, sigma2: -1 }).success).toBe(
      false,
    );
  });

  test('mixture state allows a single component but rejects empty', () => {
    // Note: persisted mixtureState is.min(1) — unlike create-input.min(2).
    expect(
      beliefStateSchema.safeParse({
        kind: 'mixture',
        components: [{ pi: 1, mu: 0, sigma2: 1 }],
      }).success,
    ).toBe(true);
    expect(beliefStateSchema.safeParse({ kind: 'mixture', components: [] }).success).toBe(false);
  });

  test('mixture state component pi may be zero (nonnegative), unlike create-input', () => {
    // mixtureComponentStateSchema uses nonnegative; creation uses positive.
    expect(
      beliefStateSchema.safeParse({
        kind: 'mixture',
        components: [{ pi: 0, mu: 0, sigma2: 1 }],
      }).success,
    ).toBe(true);
  });

  test('student_t state requires ν > 2', () => {
    expect(
      beliefStateSchema.safeParse({ kind: 'student_t', nu: 2, mu: 0, scale2: 1 }).success,
    ).toBe(false);
    expect(
      beliefStateSchema.safeParse({ kind: 'student_t', nu: 3, mu: 0, scale2: 1 }).success,
    ).toBe(true);
  });

  test('belief state rejects an unknown kind', () => {
    expect(beliefStateSchema.safeParse({ kind: 'logistic', mu: 0, sigma2: 1 }).success).toBe(false);
  });
});

describe('oracle / dispute / resolve / setRole input schemas', () => {
  test('oracleResolve requires a finite, in-bounds thetaStar', () => {
    expect(oracleResolveSchema.safeParse({ thetaStar: 65000 }).success).toBe(true);
    expect(oracleResolveSchema.safeParse({}).success).toBe(false);
    expect(oracleResolveSchema.safeParse({ thetaStar: 1e13 }).success).toBe(false); // beyond ceiling
    expect(oracleResolveSchema.safeParse({ thetaStar: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    );
  });

  test('dispute requires a non-empty reason within 1000 chars; proposedValue optional', () => {
    expect(disputeSchema.safeParse({ reason: 'wrong price' }).success).toBe(true);
    expect(disputeSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(disputeSchema.safeParse({ reason: 'x'.repeat(1001) }).success).toBe(false);
    expect(disputeSchema.safeParse({ reason: 'ok', proposedValue: 100 }).success).toBe(true);
    // proposedValue still bound by the outcome ceiling
    expect(disputeSchema.safeParse({ reason: 'ok', proposedValue: 1e13 }).success).toBe(false);
  });

  test('resolveDispute uphold requires secondaryValue; reject does not', () => {
    // uphold WITHOUT secondaryValue → rejected by the superRefine
    const upholdMissing = resolveDisputeSchema.safeParse({ action: 'uphold' });
    expect(upholdMissing.success).toBe(false);
    if (!upholdMissing.success) {
      expect(upholdMissing.error.issues.some((i) => i.path.includes('secondaryValue'))).toBe(true);
    }
    // uphold WITH secondaryValue → ok
    expect(
      resolveDisputeSchema.safeParse({ action: 'uphold', secondaryValue: 70000 }).success,
    ).toBe(true);
    // reject needs no secondaryValue
    expect(resolveDisputeSchema.safeParse({ action: 'reject' }).success).toBe(true);
    expect(
      resolveDisputeSchema.safeParse({ action: 'reject', note: 'resolution stands' }).success,
    ).toBe(true);
  });

  test('resolveDispute rejects an unknown action and an over-long note', () => {
    expect(resolveDisputeSchema.safeParse({ action: 'escalate' }).success).toBe(false);
    expect(
      resolveDisputeSchema.safeParse({ action: 'reject', note: 'x'.repeat(1001) }).success,
    ).toBe(false);
  });

  test('setRole accepts the UserRole enum members and rejects others', () => {
    expect(setRoleSchema.safeParse({ role: UserRole.ORACLE }).success).toBe(true);
    expect(setRoleSchema.safeParse({ role: UserRole.ADMIN }).success).toBe(true);
    expect(setRoleSchema.safeParse({ role: UserRole.USER }).success).toBe(true);
    expect(setRoleSchema.safeParse({ role: 'superadmin' }).success).toBe(false);
  });
});
