import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve from this module, independent of cwd, for source and single-file published bundles. */
export async function bridgePackageRoot(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 3; i++) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === 'lark-channel-bridge') return directory;
    } catch { /* keep looking up within the package */ }
    directory = dirname(directory);
  }
  throw new Error('bridge package root unavailable');
}
