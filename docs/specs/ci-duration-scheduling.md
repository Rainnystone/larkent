# Duration-aware CI scheduling

Status: approved for implementation; no merge authorization. Baseline: PR #55 at `c0205481fbc8b4234bea5ddac0f8e4d507de8773`.

## Problem and outcome

Developers wait for a few overloaded test shards while others are idle. Vitest 2.1.9 currently assigns approximately equal file counts by path hash, then cold-start orders by file size. Small per-agent entry files hide expensive process suites. Reduce time to a trustworthy result without reducing tests or requiring paid infrastructure.

## User stories

- As a contributor, I receive the full existing platform validation sooner.
- As a maintainer, new and renamed tests run automatically without editing an allowlist.
- As a maintainer, I can compare allocation candidates locally using recorded platform costs before spending CI runs.
- As a reviewer, I can distinguish measured elapsed time, modeled time, missing data, and intentionally skipped tests.
- As a maintainer, I can revert scheduling without changing tests or migrating data.

## Contract

1. Preserve Ubuntu 2, Windows 3, macOS 2 standard-runner shards, current assertions, isolation, transport/process boundaries, and existing skip semantics. Do not alter product code or increase timeouts.
2. Start from Vitest's discovered specifications, never timing-map keys. Each specification belongs to exactly one shard. Identity is repository-relative normalized path plus project and pool. Partition consistently with the runner; retain original specification objects.
3. Use deterministic longest-estimated-work-first assignment to the lightest shard, with lexical identity and shard index tie-breaks. Use the same estimated-cost ordering inside each shard. Valid shard inputs and duplicate identities are checked.
4. Advisory versioned costs are per operating system. Accept only finite positive costs. Unknown/new files and absent, invalid, or stale cost data fall back to positive estimates and cannot disappear. A failed/skipped/interrupted sample cannot replace valid history with zero.
5. Every shard of one platform uses the same revision, discovery configuration, and checked-in timing snapshot. Local discovery/planning and the runtime adapter use the same planner. No mutable shared scheduling cache or remote scheduler.
6. Record actual file suite duration, collection and setup separately, outcome, environment, source revision and worker settings. File suite duration includes hooks/waits, not all loading overhead or CPU time. Standard JSON reporter test timestamp ranges are not a substitute. No credentials, absolute user paths, or test stdout in timing reports.
7. Preserve test exit status. Missing/duplicate/unexpected results or incomplete runs are explicit diagnostics, never success. Reconcile a selected manifest with reported results, including intentional skips. Any verification failure must be visible and block a claimed complete result.
8. The local tool supports discovery, exact-cover verification, old/new scheduling replay, and explicit candidate timing updates. It never writes tracked timing data during an ordinary run. A replay states worker assumptions, costs excluded, missing estimates and old-model residual; predictions are not measured speedups.
9. Keep normal local developer execution usable. Enable weighted scheduling explicitly for CI/benchmark runs, with a one-switch return to built-in scheduling. The offline verifier must exercise the same planner as CI.

## Evidence and validation

Latest baseline run: https://github.com/Rainnystone/larkent/actions/runs/39828685460 — 9m02s, nine jobs green, 323 files per OS. Test-step seconds: Ubuntu 235/402, Windows 271/306/366, macOS 262/475. Previous run: 39823318371. Both demonstrate variability; they are starting observations, not stable performance estimates.

Use invariant/behavior tests, actual Vitest discovery and adapter parity, type checking and available local test execution. Do not bypass an environment denial. Compare identical file sets and platform outcomes. Limit hosted optimization verification to at most three rounds; avoid remote pushes per local tuning experiment. Target meaningful median/tail reduction (initial aspiration 20–30%), never sacrifice correctness for a threshold. No guarantee is inferred from replay.

## Out of scope

No paid runner/storage/service, account or ruleset changes, merge queue, auto-merge, deployment, model invocation, live provider setup, assertion removal, flaky-test masking, fixture/process reuse, or wholesale test-framework redesign.

## Methodology

Read Ask Matt, to-spec, to-tickets, implement and code-review primary guidance from mattpocock/skills. Use a concise contract and local dependency-linked tickets for this bounded work; no separate dual-track branches or external tracker setup. End with independent Standards and Spec review. The user approved proceeding without another interview.

## Resolved implementation details

- Plan independently per runner pool, as Vitest invokes the sequencer per pool. CLI and replay use the same pool rule; selected manifests accumulate all invocations rather than overwrite.
- Initial weight metric is `suite-duration-ms`, matching existing log measurements. Store collection/setup separately; do not silently add them into the seed metric.
- Seed costs are medians of available successful observations in the two pinned runs. They are historical seeds, not a claim of identical measured worker cohorts. Future updates require complete successful reports and compatible platform, architecture, Node/Vitest and worker/configuration metadata; unknown metadata is explicit.
- Use full programmatic Vitest discovery for project/pool identities, not pool-less list JSON. Preserve case. Reject duplicate specification identities; repeated same path in different projects/pools is not a duplicate.
- Only the selected manifest from the sequencer establishes shard membership. Pre-shard collection events do not.
- Activation is `LARK_CI_SCHEDULER=weighted`; default local execution remains built-in. Local reports default to an ignored `.ci-timings` directory. Public telemetry contains relative test paths and timings only.
- The local entry point is `pnpm ci:schedule` with discover, verify, replay and update-timings. Candidate updates require an explicit output path.
