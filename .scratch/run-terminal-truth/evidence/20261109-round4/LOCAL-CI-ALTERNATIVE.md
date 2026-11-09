# Local CI alternative (box) — Actions quota exhausted

Asia/Shanghai. **Prep only this turn:** no full suite run, no `pnpm install`, no Actions trigger/rerun, no product push, **no edits under `/workspace/rt-agy-fix`** (desktop agy diagnosis owns that tree).

Evidence sources: `/workspace/rt-fix` @ `aabcefe68e148a153f89f57660009bb62ec65b28` (same tip as `origin/fix/run-terminal-truth`), files `.github/workflows/ci.yml`, `package.json`, `vitest.config.ts`, installed **vitest/2.1.9** CLI `--help` / `node_modules/vitest/dist/config.js` + `resolveConfig` worker defaults.

---

## Box resources (snapshot 2026-11-09 11:10–11:12 CST)

| Metric | Value |
| --- | --- |
| `free -m` | Mem total **16002** / used ~**9263** / available ~**6738** (no swap) |
| `uptime` | ~8:43, load ~1.02 0.79 0.64 |
| `nproc` / `os.availableParallelism` | **8** |
| Default vitest workers if unconstrained | pool default **`forks`**; non-watch `maxForks` ≈ **`max(cpus−1, 1)` = 7** (vitest 2.1.9 `createForksPool`) + `fileParallelism` default **true** → **not** “unlimited,” but **high** on this box |

### Protect / do not kill
| PID (at prep) | Role |
| --- | --- |
| **445220** | desktop `agy -i` on ticket-02 brief — **leave alone** |
| **343151 / 343228 / 343328** | prod bridges cursor/grok/devin — **leave alone** |
| Feishu / Chrome / sand host | desktop Computer Use — **leave alone** |

### Safe cleanup (only when *this* local CI run left leftovers)
After a future local gate you start, reclaim **only** orphaned children of that run:
1. Record the parent shell PID / `vitest` PID at start.
2. On abort: `pkill -P <vitest_pid>` then kill vitest; or `pgrep -af 'vitest run'` and kill **only** PIDs whose cwd/cmdline is the intended worktree (not 445220, not prod bridges).
3. Do **not** `e2e:down` prod; rt1 test bridge already down from earlier prep.
4. Do not mass-kill `node` / `agy`.

---

## What GitHub Actions actually runs (`ci.yml`)

| Job | Runner | Command sequence (after checkout + Node 20 + install) | When |
| --- | --- | --- | --- |
| **static** | ubuntu-latest | `pnpm build:web` → `pnpm typecheck` → `pnpm build:ci` | always |
| **test-ubuntu** | ubuntu-latest × shard **1/2, 2/2** | `build:web` → `build:ci` → `LARK_CI_SCHEDULER=weighted pnpm test:shard N/2` | always (`needs: static`) |
| **test-windows** | windows-latest × shard **1/3..3/3** | same pattern `test:shard N/3` | only merge_group / schedule / PR→master\|release/* / push master\|release/* |
| **test-macos** | macos-latest × shard **1/2, 2/2** | `test:shard N/2` | same `if` as Windows |
| **ci-success** | ubuntu | asserts static+ubuntu success; Win/mac success **or skipped** unless full-matrix required | `always()` |

Install in CI: `pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild protobufjs` (Node **20**).

**Actions status this round:** quota exhausted → **intentionally not run**. That is a **policy skip**, not a pending check. **Do not wait** on cloud CI; do not treat missing Actions as a blocker loop.

---

## Package scripts (exact)

| Script | Definition |
| --- | --- |
| `ci:local` | `git diff --check && pnpm test && pnpm typecheck && pnpm build` |
| `test` | `vitest run` (**`pretest` → `pnpm build:web`**) |
| `test:shard` | `vitest run --shard` (pass `N/M` as args) |
| `typecheck` | `tsc --noEmit` |
| `build` | `pnpm build:web && tsup` |
| `build:ci` | `tsup` only |
| `ci:platform` | `pnpm test && pnpm typecheck && pnpm build` (no `git diff --check`) |

`vitest.config.ts` does **not** set `maxWorkers` / pool; weighted sequencer only when `LARK_CI_SCHEDULER=weighted`.

---

## Local Linux equivalent gate (recommended order)

Run in the **code** worktree under test (when authorized to execute — **not** this prep turn). Prefer `/workspace/rt-agy-fix` once desktop agy releases it, or a free copy of the same HEAD. Use Node ≥20 / repo-pinned pnpm via corepack.

### A. Low-concurrency “ci:local-shaped” (preferred on this box)

Default `pnpm ci:local` → `vitest run` can open **~7 forks** + file parallelism → risky with ~6–7 GiB available beside Feishu/agy/prod bridges.

**Supported low-concurrency options (vitest 2.1.9 `--help`, not guesses):**

```bash
# 1) whitespace/conflict markers
git diff --check

# 2) tests — pick ONE low-worker form (default pool is forks)
pnpm exec vitest run --maxWorkers 2 --minWorkers 1
# or stricter single worker:
pnpm exec vitest run --maxWorkers 1 --minWorkers 1
# or disable file parallelism (vitest forces maxWorkers=minWorkers=1):
pnpm exec vitest run --no-file-parallelism
# forks-pool explicit cap (same default pool):
pnpm exec vitest run --pool forks --poolOptions.forks.maxForks 2 --poolOptions.forks.minForks 1

# Note: `pnpm test` always runs `pretest` → build:web first.
# Equivalent with pretest:
pnpm build:web && pnpm exec vitest run --maxWorkers 2 --minWorkers 1

# 3) types
pnpm typecheck

# 4) full local build (web + tsup) — mirrors end of ci:local
pnpm build
# Closest to CI static CLI artifact without second web build:
# pnpm build:ci
```

**Do not** invent flags like `--threads 2` without `--pool` / `--poolOptions.*` as above.

Optional CI-parity shard (Ubuntu matrix only), still low workers:

```bash
LARK_CI_SCHEDULER=weighted pnpm exec vitest run --shard 1/2 --maxWorkers 2 --minWorkers 1
LARK_CI_SCHEDULER=weighted pnpm exec vitest run --shard 2/2 --maxWorkers 2 --minWorkers 1
```

(`pnpm test:shard 1/2` is `vitest run --shard 1/2` but does **not** add worker caps — append flags after `--` if using pnpm script: `pnpm test:shard 1/2 -- --maxWorkers 2 --minWorkers 1` only if the script forwards args; **safer:** `pnpm exec vitest run --shard 1/2 --maxWorkers 2 --minWorkers 1`.)

### B. What `pnpm ci:local` alone means vs Actions

| Gate | Covered by green `ci:local` on Linux box? |
| --- | --- |
| `git diff --check` | yes (local only; not in Actions static job) |
| unit/integration/process tests (vitest) | **Linux only** — approximate Ubuntu test job, **not** sharded unless you run shards |
| `typecheck` | yes ≈ static |
| `build` (web+tsup) | yes ≈ static build:web + build:ci |
| Ubuntu shard matrix 1/2+2/2 weighted | only if you run both shards with `LARK_CI_SCHEDULER=weighted` |
| **Windows** shards 1/3–3/3 | **no** — different OS, path/process semantics; cannot claim |
| **macOS** shards 1/2–2/2 | **no** — different OS; cannot claim |

**Rule:** local green ≠ macOS/Windows green. Record Linux result as **`local-linux`**. With Actions skipped for quota, acceptance language must say **full multi-OS CI not executed**; do not block forever waiting for Actions.

---

## Coverage gaps (why Linux cannot replace full CI)

1. **OS-specific tests / APIs** (paths, signals, `hostSuspended`, process groups) may only fail on Win/mac runners.
2. **Shard partitioning** differs (Ubuntu 2-way vs Windows 3-way); a single unsharded `vitest run` is a different schedule than CI shards.
3. **Node 24 on box vs Node 20 in Actions** (this host showed node-v24.22.1 under vitest banner) — possible skew; prefer Node 20 via `nvm`/`fnm`/mise if available when executing for closer parity (**not installed this prep**).
4. Weighted sequencer + timing map only when `LARK_CI_SCHEDULER=weighted` (as CI sets).

---

## Safe operations checklist (when you later run)

- [ ] Confirm `/workspace/rt-agy-fix` free of desktop agy (PID 445220 gone) **or** use another worktree at same HEAD — do not fight desktop session.
- [ ] `free -m` available ≳ 4 GiB before tests; if lower, free Chrome tabs or wait — do not kill prod/agy.
- [ ] Use `--maxWorkers 2` (or 1) / `--no-file-parallelism` — never bare `pnpm ci:local` under memory pressure without a worker cap.
- [ ] Run order: `git diff --check` → capped vitest → `typecheck` → `build` (or `build:ci` after one `build:web`).
- [ ] Optionally both Ubuntu shards with weighted env.
- [ ] Log: command, exit code, wall time, worker flags, Node version, HEAD sha.
- [ ] Label result **`local-linux`**; explicitly **skip** Win/mac with reason “no runner / Actions quota”.
- [ ] No `gh workflow run`, no empty wait on Actions, no push from this alternative path unless user asks.

---

## Minimal next step (after desktop agy diagnosis finishes)

1. Read agy ticket-02 finding file from the brief path (do not start a second agy here).
2. In `/workspace/rt-agy-fix` (or clone), run **one** low-worker gate:  
   `git diff --check && pnpm build:web && pnpm exec vitest run --maxWorkers 2 --minWorkers 1 && pnpm typecheck && pnpm build:ci`  
   Record as `local-linux`; mark Win/mac **skipped (Actions quota / no local runner)**.
3. Do **not** wait on GitHub Actions.

---

## This prep did / did not

| Did | Did not |
| --- | --- |
| Read `ci.yml` + scripts + vitest 2.1.9 help/defaults | Run full `ci:local` / vitest workers |
| Write this file under evidence | Install deps / touch `rt-agy-fix` |
| Snapshot free/uptime/PIDs | Trigger Actions, push, kill protected PIDs |
