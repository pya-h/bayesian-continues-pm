import { describe, expect, test } from 'bun:test';
import { CORE_VERSION } from '../src/index.ts';

describe('core scaffold', () => {
  test('package is importable', () => {
    expect(CORE_VERSION).toBe('0.1.0');
  });
});
