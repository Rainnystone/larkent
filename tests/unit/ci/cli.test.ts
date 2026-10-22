import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discover } from '../../helpers/ci/cli';
import { identity, planShards, readWeights, verifyCoverage } from '../../helpers/ci/test-plan';

describe('scheduling discovery', () => {
  it('uses actual Vitest discovery with pool metadata without importing tests, and includes newly added files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-discovery-'));
    try {
      const config = join(root, 'vitest.config.mjs');
      writeFileSync(config, "export default {test:{include:['*.test.ts'],poolMatchGlobs:[['**/thread.test.ts','threads']]}};");
      writeFileSync(join(root, 'fork.test.ts'), "throw new Error('Do not execute during discovery');");
      writeFileSync(join(root, 'thread.test.ts'), "throw new Error('Do not execute during discovery');");
      const before = await discover(root, config);
      expect(before.map(spec => [spec.path, spec.pool]).sort()).toEqual([['fork.test.ts', 'forks'], ['thread.test.ts', 'threads']]);
      writeFileSync(join(root, 'new.test.ts'), "throw new Error('New files must be discovered automatically');");
      const after = await discover(root, config);
      expect(after.map(identity)).toHaveLength(3);
      expect(verifyCoverage(after, planShards(after, 3, readWeights(undefined, 'linux', '2.1.9')))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
