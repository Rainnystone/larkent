# Translator differential baseline (D03b)

`tests/unit/agent/transcript-replay.test.ts` freezes the complete ordered
`AgentEvent` output of the translators at
`222d4c72ca96a89131271ede29820886b63ba3cf`. Production code is unchanged.
Each sequence uses a fresh translator and calls only `translate`, `finish`
and `fail`. Snapshots are checked-in literals, never regenerated during a
normal test run. D04 compares its translators against these same inputs and
snapshots; intentional liveness and tool-pairing changes need explicit review.

| Input provenance | Sequences | Meaning |
| --- | ---: | --- |
| D03a `<kind>/*.jsonl` | 42 | Six owner-machine captures for each of seven kinds |
| Existing Grok / Antigravity JSONL and Grok stderr | 9 | Existing recorded inputs, replayed without recapture |
| `goldens/stderr/` | 42 | All 12 samples; the five unattributed network samples are applied to every kind's `fail` seam |
| Existing envelope classifier matrices | 22 | Synthetic text examples through Antigravity's result boundary |
| Frozen `unit-inputs/<kind>.json` | 261 | Protocol sequences from the existing unit tests, with source test names |
| `synthetic-boundaries.ts` | 49 | Seven deliberately constructed sequences per kind |
| Total | 425 | Complete emitted event sequences, including empty sequences |

Only D03a and the existing recorded fixtures support claims about real CLI
output. Unit inputs, the envelope matrices, cross-kind network assignments
and the new boundary sequences are characterization inputs. They do not
establish CLI, Feishu, heartbeat timing or process-settlement facts.

## Capture replay

JSONL `line` records are parsed as `wrapParsedTranslator` does; non-JSON lines
are ignored. Devin consumes only ACP `update` records. Timestamps, stderr,
annotations and exits are not protocol updates. The recorded exit and stop
annotation select the JSONL translator's final `finish` / `fail` call;
nonzero errors include the runner's bounded, terminal-stripped stderr detail.
Devin's terminal annotation selects `end_turn`, `cancelled`, or `fail`.
Its unknown-model capture has zero session updates and a client-side error:
that case characterizes `fail`, not an invented ACP update. Resume metadata
added by the adapter outside the translator is outside this baseline.

All inputs run immediately in-process. The baseline does not replay wall-clock
gaps, launch any CLI, connect to Feishu or prove adapter/runner lifecycle
behaviour. Existing process and integration tests retain that responsibility.

## Frozen unit inputs

The unit corpus was recorded while running the unchanged base's 42 agent unit
test files (436 tests). Temporary call-through instrumentation recorded the
arguments of the seven translators' public methods, grouping calls by instance;
it did not replace their outputs. Nested internal calls were excluded so a
`finish` that calls `fail` is not replayed twice. Direct Claude `translateEvent`
calls were recorded as separate stateless sequences. No instrumentation or
module mocking is used by the committed replay tests.

The 261 sequences come from 16 test files. Kinds: Claude 15, Codex 29, Kimi 9,
Grok 123, Cursor 16, Antigravity 56, Devin 13. The JSON includes each original
source path, test title, per-test instance ordinal, call order and arguments,
including calls after termination and Devin's history-replay flag. These are
frozen inputs, independent of later changes to the originating unit tests.

`$undefined` preserves explicit undefined arguments; `$error` preserves Error
messages. `$repeat: [character, count]` and `$runs: [[character, count], ...]`
expand long line-cap inputs without trimming a byte. Large repeated output
strings use the same lossless run representation in snapshots, including
nonrepeating suffixes. No events or fields are filtered. Existing sample home
paths, emails and Feishu identifiers are replaced with consistent placeholders
before translation; the original fixtures remain untouched. The legacy fake
token sample is labelled `<SYNTHETIC_TOKEN>`.

`models.txt` is model-list output; `.mjs` files are process fixtures. They are
not run-translator inputs. Every JSONL / stderr file in the requested fixture
directories is covered. Envelope matrix rows are also replayed explicitly.

## Run and update

```bash
pnpm exec vitest run tests/unit/agent/transcript-replay.test.ts
pnpm typecheck
pnpm ci:local
```

To deliberately replace the baseline, use `pnpm exec vitest run
tests/unit/agent/transcript-replay.test.ts -u` and review every changed event
against the fixed source revision. Do not accept snapshot updates simply to
make a refactor pass. A temporary Grok final-text mutation was checked against
the real-capture group: four capture snapshots failed; removing it restored
the baseline. No mutation was written to production files.

The synthetic boundary group covers empty success, narration ending at EOF,
an unfinished tool, repeated messages, an error after text, interruption after
text, and late text / repeated terminals. It pins current quirks, including
unpaired tools and bare `system` liveness, for D04's explicit contract changes.

## D04 reviewed contract changes

The original D03b literals remain available at the fixed pre-D04 product commit
`2adc9543b55b9aff8e4f8c253ec449545efda01b`. D04 changes 194 of the 425
snapshots. An explicit comparison of every changed literal, after removing only
empty-system/liveness records, found these disjoint categories:

| Changed sequences | Reviewed difference |
| ---: | --- |
| 131 | Activity only: empty `system` becomes `liveness`, and captured held answers, thinking, turn/version records and tool updates report liveness |
| 42 | Stop/timeout releases held text as `text` with `heldBack: true`, preserving the existing explicit `/stop` partial reply through the bot's delivery filter; one also closes an unfinished tool |
| 11 | Terminal emits a failed result for an unfinished tool |
| 8 | Antigravity failure/unterminated EOF flushes scrubbed progress instead of incorrectly emitting successful `final_text` |
| 2 | Orphan Codex results are suppressed instead of emitting a result without a use |

Successful answer content, progress separators, usage values/order, resume
metadata and error messages retain their baseline values. All 425 sequences also
check that system events contain metadata; the six final-answer kinds additionally
check ordered pairing and terminal closure. These checks include the frozen unit
inputs even where their now-redundant originating hold-back tests were deleted.

Policy comments cite the D03a narration/tool captures. Grok's last-segment fallback
and Antigravity's envelope scrub retain existing characterized behavior: the D03a
captures do not demonstrate missing post-tool text or envelopes. Those details are
supported by the original D03b synthetic boundaries and existing incident fixtures,
not claimed as new real CLI observations. D04's silent-activity tests select actual
records from D03a captures; they establish event handling, not heartbeat timing.

Review also adds synthetic compatibility cases outside the frozen corpus: Codex
and Kimi release text at result boundaries; Grok preserves whitespace-only tails
and the stopped fallback after whitespace/control tokens; Devin retains array
input replacement; Antigravity retains explicit successful EOF. These preserve
legacy behavior and do not claim new native protocol observations. CoT ignores
terminal held partials, and the scripted ACP process tests verify that abnormal
exit rewriting retains the core's tool closures.
