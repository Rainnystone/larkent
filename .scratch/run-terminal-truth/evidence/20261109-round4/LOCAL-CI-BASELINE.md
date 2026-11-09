# Local Linux CI baseline — SHA `aabcefe6`

Asia/Shanghai. **This is a BASELINE of commit `aabcefe68e148a153f89f57660009bb62ec65b28` only.** It does **not** claim any future fix commit passes. Win/mac **not run**. GitHub Actions **not triggered** (quota exhausted — policy skip, not waiting).

## Environment

| Item | Value |
| --- | --- |
| Worktree | `/workspace/rt-fix` (detached `aabcefe6`) — **not** `/workspace/rt-agy-fix` |
| Start/End SHA | `aabcefe68e148a153f89f57660009bb62ec65b28` (unchanged) |
| Node / pnpm / vitest | v24.22.1 / 10.33.0 / 2.1.9 |
| Runner PID | **458110** (`bash …/run-baseline.sh`) |
| Log | `/workspace/rt-e2e-evidence-20261109/round4/local-ci-logs/baseline-20261109-111517.log` |
| Wall window | 2026-11-09 **11:15:17 → 11:23:06 CST** (~7.8 min overall stop at vitest) |
| free -m before | avail ~8830 MiB (11:14) |
| free -m after | avail ~10483 MiB (11:23:52) |
| Protected left alone | agy **445220**; prod bridges **343151 / 343228 / 343328** |
| Leftover vitest/workers | **none** after exit |

### Shared `node_modules` (reported, isolated)

- `/workspace/rt-fix/node_modules` → **symlink** to `/home/box/src/larkent/node_modules` (same inode).
- `/workspace/rt-fix/dist` is a **separate** directory from prod `dist` (safe to write).
- `build:web` outDir = `rt-fix/src/ui/generated` (worktree only, not prod).
- To avoid writing Vite/Vitest cache into shared nm, used **untracked** helpers:
  - `web/vite.config.local-ci.mts`
  - `vitest.config.local-ci.ts`  
  with `cacheDir=/workspace/rt-e2e-evidence-20261109/round4/local-ci-cache/vite`.
- Shared `/home/box/src/larkent/node_modules/.vite` mtime stayed **2026-11-07 19:19:57** (not updated this run). Isolated cache written under evidence `local-ci-cache/vite/vitest`.
- **No `pnpm install`.** No product commits. No Actions.

Gate ≈ requested  
`git diff --check && build:web && vitest --maxWorkers 2 --minWorkers 1 && typecheck && build:ci`  
with cacheDir isolation (same semantics as `&&`: **stop after first failure**).

## Step results

| Step | Exit | Elapsed | Notes |
| --- | --- | --- | --- |
| `git diff --check` | **0** | 0s | clean |
| `vite build web` (local-ci config) | **0** | 2s | wrote `src/ui/generated/index.html` (~430 kB) |
| `vitest run --maxWorkers 2 --minWorkers 1` | **1** | **467s** (~7.8 min) | see tests below |
| `pnpm typecheck` | **not run** | — | skipped: `&&` chain stopped after vitest |
| `pnpm build:ci` | **not run** | — | skipped: same |

**OVERALL_EXIT=1**

## Vitest summary (local-linux)

| Metric | Count |
| --- | --- |
| Test files | **1 failed** \| 356 passed \| 7 skipped (**364**) |
| Tests | **1 failed** \| **4030** passed \| 16 skipped (**4047**) |
| Duration | **466.87s** (vitest reported) |

### Failure (verbatim cause — not masked)

```
FAIL  tests/integration/e2e-harness/proxy.test.ts
  > test-bridge fault proxy > eai_again is simulated with an unresolvable proxy host

AssertionError: expected false to be true // Object.is equality
 ❯ tests/integration/e2e-harness/proxy.test.ts:71:9
```

Assertion expected proxy error code/text to match `ETIMEOUT|ENOTFOUND|EAI_AGAIN|timeout|…`; received condition **false** (this environment did not surface an accepted failure signature). **Baseline fact for aabcefe6 on this box — not fixed here.**

## Platform matrix honesty

| Gate | Status |
| --- | --- |
| local-linux (this run) | **FAIL** (1 test) @ `aabcefe6` |
| Windows CI shards 1/3–3/3 | **未跑** (no Windows runner; Actions quota) |
| macOS CI shards 1/2–2/2 | **未跑** (no macOS runner; Actions quota) |
| GitHub Actions | **未触发** — do not wait |

## What this does / does not mean

- **Does:** record Linux box baseline for **`aabcefe6`** with exact log/PID/SHA.
- **Does not:** prove macOS/Windows; prove a future agy fix; greenwash by skipping the failing assert.

## Minimal next (after desktop agy diagnosis)

1. Keep treating this SHA as **known-fail baseline** (`proxy.test.ts` eai_again).
2. Optionally run `pnpm typecheck && pnpm build:ci` alone on the same tree for static-only numbers (not done this turn because chain stopped).
3. When a fix commit exists in `rt-agy-fix`, re-run the same capped gate there and **diff against this baseline** — never relabel this file as that fix’s pass.

## Follow-up (2026-11-09 ~11:25–11:26 CST) — verify-only

Asia/Shanghai. Still SHA `aabcefe68e148a153f89f57660009bb62ec65b28`. **No code changes, no commits, no Actions.** Win/mac still **未跑**. Protected left alone: agy **445220**; prod bridges **343151 / 343228 / 343328**. Leftover vitest/tsc from this follow-up: **none**. Prod `node_modules/.vite` mtime still **2026-11-07 19:19:57**. Cache isolation via `vitest.config.local-ci.ts` unchanged.

Pre-check: `free -m` avail ~10573 MiB; `uptime` load 0.79 / 1.52 / 1.15 (11:24:56 CST). Post: avail ~10441 MiB (11:26:09 CST).

### 1) Skipped steps from prior `&&` chain

| Step | Exit | Elapsed | Log |
| --- | --- | --- | --- |
| `pnpm typecheck` | **0** | **8.33s** | `local-ci-logs/followup-typecheck-20261109-112520.log` |
| `pnpm build:ci` | **0** | **2.04s** | `local-ci-logs/followup-buildci-20261109-112600.log` |

### 2) `proxy.test.ts` re-run (maxWorkers 1) ×2

| Run | Exit | Elapsed | Result |
| --- | --- | --- | --- |
| 1 | **1** | 1.63s | 1 failed / 5 passed — same `eai_again…` assert |
| 2 | **1** | 1.73s | identical failure |

Logs: `local-ci-logs/followup-proxy-run1-20261109-112700.log`, `…-run2-…`.

Unresolvable host used by code: **`eai-again.larkent-e2e.invalid:9`** (`EAI_AGAIN_URL` in `e2e/test-bridge/proxy.ts`).

### 3) Environment diagnosis (one-line evidence)

**Conclusion: 环境相关且与 #70 无关.**

Evidence:
- `/etc/resolv.conf` → `nameserver 10.0.0.2` (sandbox egress resolver). No `/etc/hosts` override.
- `getent hosts eai-again.larkent-e2e.invalid` → **`198.18.0.1`** (exit 0). Node `dns.lookup` same address, `err:null`. `.invalid` should be NXDOMAIN; this box’s resolver sinkholes it.
- Sandbox markers: `SAND_HTTP_PROXY_NAME=runner-egress-proxy`, `SAND_EGRESS_TUNNEL_PROXY_ADDR=127.0.0.1:8791`.
- Node CONNECT to that host:9 with 800ms client timer returned **`CONNECT_OK` in ~5ms** (no EAI_AGAIN / ENOTFOUND / timeout) — so the test’s `rejects.toSatisfy(…)` sees a success path and the assert stays false.
- PR #70 vs `origin/master`: `proxy.test.ts` and `proxy.ts` **blob-identical** (`45805b54…` / `bc611848…`). `git log origin/master...aabcefe6 --` those two files is **empty**. aabcefe6 itself only touches `jsonl.ts` / `run-outcome.ts` / `run-state.ts`. (PR does touch unrelated `e2e/test-bridge/{README,cli,driver}.ts` — not the eai_again simulator.)

Not a #70 regression; not indeterminate given the resolve+CONNECT_OK proof.

### Platform matrix (unchanged honesty)

| Gate | Status |
| --- | --- |
| local-linux typecheck / build:ci @ aabcefe6 | **PASS** (this follow-up) |
| local-linux full vitest @ aabcefe6 | **FAIL** 1 test (env DNS) — baseline unchanged |
| Windows CI shards | **未跑** |
| macOS CI shards | **未跑** |
| GitHub Actions | **未触发** — quota exhausted |
