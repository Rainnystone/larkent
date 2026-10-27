# D03 Real transcripts (D03a) and differential baseline (D03b)

Spec: D12, §5 Captured transcripts, A4. Blocked by: none (D03b after D03a).
Touch: new `tests/fixtures/transcripts/<kind>/`, a capture script under `scripts/` or `tests/helpers/`, new replay tests. No production code.

## Why

D04 rewrites how six translators hold back the answer. Two different facts are needed, and only one of them needs the real binaries:

- **What the CLIs emit** (D03a). D04's shared-core rules (where the answer boundary is, when liveness fires, how tool calls pair) must match the real protocols. This needs the logged-in CLIs, which exist only on the owner's machine, not in cloud workers.
- **What today's translators emit for a given input** (D03b). D04 is behaviour-preserving apart from liveness and pairing, so "unchanged" means "same `AgentEvent` sequence as today's translator". Proving that is a differential test and needs no CLI.

## D03a Capture (owner's machine, done before cloud work starts)

1. Run with the real binaries and each adapter's real argv (reuse the adapter's own argv builder, as the `tests/process/*-real.smoke.test.ts` files do) so the capture matches production flags.
2. Capture, per kind (`claude`, `codex`, `kimi`, `grok`, `cursor`, `antigravity`, `devin`), the scenarios in Spec §5: answer only; narration → tool → answer; two tools in one turn; a long-running tool (a shell `sleep` long enough to see the CLI's silence or heartbeat behaviour); user stop mid-answer; an unknown-model or auth error where the CLI produces one. Record raw stdout lines (JSONL) or ACP session updates (devin) verbatim.
3. Each file starts with a header record: kind, CLI version, capture date, command template, scenario. Scrub account names, emails, ids, tokens, absolute home paths. If a scenario cannot be produced by a CLI, record that fact and why in the kind's `README.md` instead of fabricating a file.
4. Land the fixtures as one commit on `feat/architecture-deepening` with a per-kind observation note: when narration precedes a tool, whether text repeats across message boundaries, whether the CLI emits anything during a long tool, how stop and errors terminate.

## D03b Differential baseline (cloud)

1. Corpus: the D03a transcripts, the existing real fixtures (`tests/fixtures/grok/`, `tests/fixtures/antigravity/`, `tests/fixtures/goldens/stderr/`), the protocol inputs already used in `tests/unit/agent/*`, and small synthetic sequences at hold-back edges (empty answer, narration only, tool without result, repeated message, error after text).
2. Replay tests feed every corpus entry through today's translator (`translate` / `finish` / `fail`) and snapshot the emitted `AgentEvent` sequence. They must be green with unchanged production code.
3. These snapshots are the baseline D04 must preserve, except where D04 changes the contract on purpose (liveness, pairing).

## Acceptance

- [ ] D03a: transcripts for all seven kinds exist, or each missing scenario is explained in that kind's README; observation note posted.
- [ ] D03b: replay snapshots cover the whole corpus and are green with unchanged production code.
- [ ] No secrets or identifying data in fixtures (grep for emails, `ou_`, `oc_`, `cli_`, home paths).
- [ ] `pnpm ci:local` green; delivery note posted for each part.
