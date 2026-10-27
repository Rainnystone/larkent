# D03 Capture real transcripts for seven CLIs

Spec: D12, §5 Captured transcripts, A4. Blocked by: none.
Touch: new `tests/fixtures/transcripts/<kind>/`, a capture script under `scripts/` or `tests/helpers/`, new replay tests. No production code.

## Why

D04 rewrites how six translators hold back the answer. Their per-agent policy differences must come from what the binaries actually emit, not from memory. All seven CLIs are installed and logged in on the owner's machine (versions in Spec D12).

## Do

1. Must run on the owner's machine with the real binaries; it spends model quota. Use each adapter's real argv (reuse the adapter's own argv builder, as the `tests/process/*-real.smoke.test.ts` files do) so the capture matches production flags.
2. Capture, per kind (`claude`, `codex`, `kimi`, `grok`, `cursor`, `antigravity`, `devin`), the scenarios in Spec §5: answer only; narration → tool → answer; two tools in one turn; a long-running tool (e.g. a shell `sleep` long enough to see the CLI's silence or heartbeat behaviour); user stop mid-answer; an unknown-model or auth error where the CLI produces one. Record raw stdout lines (JSONL) or ACP session updates (devin) verbatim.
3. Each file starts with a header record: kind, CLI version, capture date, command template, scenario. Scrub account names, emails, ids, tokens, absolute home paths. If a scenario cannot be produced by a CLI, record that fact and why in the kind's `README.md` instead of fabricating a file.
4. Write replay tests that feed each transcript through today's translator and snapshot the emitted `AgentEvent` sequence. They must be green on `master` (characterization). These snapshots are the baseline D04 must preserve, except where D04 changes the contract on purpose (liveness, pairing).
5. In the delivery note, list per kind the observed facts D04 depends on: when narration precedes a tool, whether text repeats across message boundaries, whether the CLI emits anything during a long tool, how stop and errors terminate.

## Acceptance

- [ ] Transcripts for all seven kinds exist, or each missing scenario is explained in that kind's README.
- [ ] Replay tests are green on the branch with unchanged production code.
- [ ] No secrets or identifying data in fixtures (grep for emails, `ou_`, `oc_`, `cli_`, home paths).
- [ ] `pnpm ci:local` green; delivery note with per-kind observations posted.
