import { describe, expect, it } from 'vitest';
import { getRunIdleTimeoutMs } from '../../../src/config/schema';

const app = { id: 'cli_test', secret: 'secret', tenant: 'feishu' as const };

describe('getRunIdleTimeoutMs', () => {
  it('defaults unset to 15 minutes and treats 0 as disabled', () => {
    expect(getRunIdleTimeoutMs({ accounts: { app } })).toBe(15 * 60_000);
    expect(getRunIdleTimeoutMs({ accounts: { app }, preferences: {} })).toBe(15 * 60_000);
    expect(getRunIdleTimeoutMs({
      accounts: { app },
      preferences: { runIdleTimeoutMinutes: 0 },
    })).toBeUndefined();
    expect(getRunIdleTimeoutMs({
      accounts: { app },
      preferences: { runIdleTimeoutMinutes: 20 },
    })).toBe(20 * 60_000);
  });
});
