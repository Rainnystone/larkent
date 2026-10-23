import { defineConfig } from "vitest/config";
import DurationSequencer from "./tests/helpers/ci/test-sequencer";
import TimingReporter from "./tests/helpers/ci/test-timing-reporter";

const weighted = process.env.LARK_CI_SCHEDULER === "weighted";

// Match tsup's `.html` text loader (tsup.config.ts) so `import html from
// './generated/index.html'` returns the file's contents as a string under
// vitest too. Without this, vite's import-analysis tries to parse the built
// console HTML as JS and fails.
export default defineConfig({
  test: {
    setupFiles: ['tests/setup/isolate-app-locks.ts'],
    ...(weighted ? {
      sequence: { sequencer: DurationSequencer },
      reporters: ['default', ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions' as const] : []), new TimingReporter()],
    } : {}),
  },
  plugins: [
    {
      name: "html-string-loader",
      enforce: "pre",
      transform(code: string, id: string) {
        if (id.endsWith(".html")) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
        return null;
      },
    },
  ],
});
