# Implement duration-aware CI scheduling

Baseline: `c0205481fbc8b4234bea5ddac0f8e4d507de8773`. Contract: [spec](../specs/ci-duration-scheduling.md). This is a single integration workstream, not dual track. No external tracker or new Cloud session is required.

## Local ticket graph

1. [Plan and replay](../../.scratch/ci-duration-scheduling/issues/01-plan-and-replay.md).
2. [Run and observe](../../.scratch/ci-duration-scheduling/issues/02-run-and-observe.md), blocked by 1.
3. [Integrate and verify](../../.scratch/ci-duration-scheduling/issues/03-integrate-and-verify.md), blocked by 1 and 2.

## Concrete changes

- `tests/helpers/ci/test-plan.ts`: pure identity, weights, exact-cover planning, longest-first ordering and fixed-worker replay.
- `tests/helpers/ci/test-sequencer.ts`: small public Vitest BaseSequencer adapter, returning original specs.
- `tests/helpers/ci/test-timing-reporter.ts`: manifest/outcome reconciliation and bounded timing reports.
- `tests/helpers/ci/test-timings.json`: advisory per-OS measured-cost seed with source metadata.
- `tests/helpers/ci/cli.ts`: discover, verify, replay and explicit candidate update commands.
- `tests/unit/ci/`: behavior and integration-seam tests.
- Minimal `vitest.config.ts`, `package.json`, workflow and ignore-file changes. Existing product/test behavior stays unchanged.

## Execution checklist

- [x] Read current Ask Matt routing and related spec/ticket/implementation/review guidance.
- [x] Inspect current code, pin latest completed CI and persist contract plus dependency-linked local tickets.
- [x] Implement the pure planner through behavior tests; exercise all current discovered files.
- [x] Seed OS weights from existing successful logs; skipped/unmeasured rows never become zero-cost observations.
- [x] Wire sequencer, reporter and local CLI; test planner/adapter parity and incomplete-result handling.
- [x] Run local replay for old/new plans and worker sensitivity before any hosted experiment.
- [x] Run typecheck, focused tests, build and permitted aggregate checks. Record blocked checks, do not circumvent them.
- [x] Review Standards and Spec independently; correct relevant findings locally.
- [ ] Stage only the intended files, confirm remote head, commit/push without rewriting history.
- [ ] Observe complete exact-head matrix; at most three hosted optimization rounds. Report real durations, not simulation as success.

## Measurement and local feedback loop

Discover with Vitest rather than a maintained file list. `list --filesOnly` lists files but does not apply the sequencer; verify allocations with the shared pure planner and adapter parity. Ordinary runs never commit timing updates.

Use a tiny local CLI for discover → verify → replay. Replay both current SHA1 equal-count/cold-size ordering and weighted allocation with identical file costs and explicit workers. Keep job preparation and unexplained old-model residual separate. Compare several historical samples, not just one lucky run. Once stable, run real local tests where permitted, then one full platform validation candidate. Linux timing is not Windows/macOS evidence.

File result duration includes hooks and waiting but excludes collection/setup/transform. Keep those fields separate. Default Vitest JSON assertion time ranges omit some costs; record file results directly. Store relative identities and numerical observations only. A report is diagnostics, not a replacement for the test process exit code. Missing results are not passes.

## Baseline

Run [39828685460](https://github.com/Rainnystone/larkent/actions/runs/39828685460), full wall 542s. Test steps: Ubuntu 235/402s; Windows 271/306/366s; macOS 262/475s. Every OS discovers 323 files; existing provider/platform skips remain explicit. Static checks 26s. Preparation/install/build is much smaller than test time, except variable Windows setup.

Prior run [39823318371](https://github.com/Rainnystone/larkent/actions/runs/39823318371) finished in 563s, with different platform stragglers. Existing two samples are a seed, not a stable distribution. Scratch replay suggests value in balancing and heavy-first ordering, but does not establish a speedup.

## Acceptance and rollback

Correctness first: exact union, no duplicated specs, unchanged original assertions/platforms/skips and complete failure propagation. New scheduler tests are reported separately. Measure full workflow wall time and slowest job, not sum of parallel durations. Target a worthwhile reduction without promising a number; if benefit does not justify maintenance, retain built-in scheduling.

Disable the weighted mode to restore Vitest defaults. No service or data migration. Do not change runner counts, widen timeouts, reuse live fixture hosts or make unrelated optimization changes in this candidate.

## Local interfaces (implementation contract)

`pnpm ci:schedule discover` obtains full runner specifications. `verify` checks exact cover. `replay --platform <linux|darwin|win32> --shards <count> --workers <count>` compares modeled layouts. `update-timings` requires an explicit `--output`; ordinary runs never rewrite the snapshot. Consult the CLI help for finalized input/output options after implementation.

Initial timing seed: median of available passed file-suite observations from the two baseline runs, positive floor 1ms for rounded near-zero observations. Skipped/missing files are not stored as zero. Cross-run variation is retained in source evidence; these seeds must not be advertised as stable estimates.

Methodology primary source pinned at `mattpocock/skills@5beb35b040e3de97e54fa9e386d7e42d15c295c2`: `skills/engineering/ask-matt`, `to-spec`, `to-tickets`, `implement`, `code-review`. Read directly because no callable Ask Matt connector was found. No external person/agent was contacted.

## Local verification before the first hosted candidate

- Discovery: 327 files, comprising all 323 baseline files and four new scheduler test files. Exact cover passes for Linux (164/163), macOS (164/163), and Windows (108/110/109). No original test file or assertion changed.
- Twenty focused tests pass. Actual weighted two-shard execution produces complete reports with a disjoint full union. Real installed BaseSequencer parity is tested, not a reimplementation compared only to itself.
- Tiny local forks/threads fixtures verify hook-inclusive duration, intentional skips, and nonzero exit on an assertion failure. A vmForks fixture verifies the pinned result-pool alias. Name-filtered execution succeeds but is not eligible for timing updates.
- Independent Spec and Standards reviews found and resolved incompatible cohort mixing, filtered training data, vmForks result/worker metadata, and preservation of GitHub Actions failure annotations. Both re-reviews report no remaining material findings.
- Type checking and whitespace checks pass. The package-manager build wrapper could not bootstrap its managed pnpm installation in this environment; equivalent installed Vite and tsup commands passed, including declaration generation. Full local aggregate execution remains unavailable because a previous suite encountered a denied loopback HTTPS request; it was not retried or bypassed. Focused checks are not a full-suite pass.
- Baseline-only replay uses exactly the original 323 paths, while execution always includes all 327. Median historical suite costs and one-to-four worker sensitivity favor the candidate, but exclude loading, runner setup, contention and changing costs. At representative assumptions, modeled critical suite time changes Linux 297.0→210.2s (three workers), macOS 410.3→302.4s (two), Windows 388.8→249.0s (three). These are predictions, not measured CI speedups.
- Hosted optimization rounds used at this checkpoint: zero. The next step is one exact-head full-matrix validation. Keep this PR unmerged.

## Reproduce and maintain

Use the repository-pinned pnpm version. Ordinary test commands remain unchanged; benchmark weighted execution with `LARK_CI_SCHEDULER=weighted pnpm test:shard 1/2` on POSIX, or set that environment variable with the platform shell before the same command.

- `pnpm ci:schedule discover`
- `pnpm ci:schedule verify --platform linux --shards 2`
- `pnpm ci:schedule replay --platform linux --shards 2 --workers 3`
- `pnpm ci:schedule update-timings --output .ci-timings/candidate.json report-1.json report-2.json`

The last command requires a complete successful compatible hosted cohort. It rejects filtered/incompatible samples and cannot overwrite the checked-in snapshot; review a candidate before deliberately adopting it. Reports are written locally to ignored `.ci-timings` and emitted as `LARK_CI_TIMING_REPORT` JSON in existing logs, without a new artifact storage service. Actual runner/configuration metadata accompanies the report. Remove the three workflow `LARK_CI_SCHEDULER` entries to roll back to Vitest defaults.
