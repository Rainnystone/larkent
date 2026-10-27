# Real CLI transcripts (D03a)

For the frozen translator-output corpus and its provenance, see
[Translator differential baseline (D03b)](DIFFERENTIAL.md).

Captured on the owner's machine from the installed, logged-in agent CLIs by
`tests/helpers/capture-transcripts.ts` (opt-in, never run by CI). Each `<kind>/<scenario>.jsonl`
file is one real run and records exactly what the adapter's translator consumed:
raw stdout lines for the JSONL kinds, ACP `session/update` `params.update`
objects for `devin`.

## Record format

One JSON object per line. `t` is milliseconds since the child process was spawned.

| shape | meaning |
|---|---|
| `{"transcript":1,"kind","cliVersion","capturedAt","scenario","command","notes"}` | always line 1; `command` is the argv template with temp paths and prompts masked |
| `{"t":ms,"line":<raw stdout line string>}` | JSONL kinds: the exact line handed to `translator.translate` |
| `{"t":ms,"update":<object>}` | devin only: the ACP `session/update` `params.update` object |
| `{"t":ms,"stderr":<line or snapshot>}` | stderr output (separate record type) |
| `{"t":ms,"note":<text>}` | harness annotations (spawn pid, first text event, signals sent, terminal translator events) |
| `{"t":ms,"exit":{"code":n|null,"signal":name|null}}` | process exit; always the last record |

## Scenarios

- `answer-only`: `Reply with exactly: TRANSCRIPT-OK`
- `narration-tool-answer`: one sentence of narration, then shell `echo hello`, then report
- `two-tools`: `echo one` then `echo two` as two separate shell tool calls
- `long-tool`: shell `sleep 45 && echo done`; the `t` field shows whether the CLI emits anything during the silence
- `stop-mid-answer`: count to 300 in words; the harness sends the production stop
  (SIGTERM to the process group, SIGKILL after 5 s grace; devin: `session/cancel` + SIGTERM via `run.stop()`)
  after the first answer text/thinking appears
- `error-unknown-model`: run with `--model lark-nonexistent-model-0` (per-kind flag)

## Replaying

Skip the header record. For JSONL kinds feed each `line` record through
`wrapParsedTranslator(new <Kind>Translator(), <spawnName>).translate(line)`; for
`devin` feed each `update` through `DevinTranscriptTranslator.translate(update)`,
then call `finish`/`fail` as the runner would. `note`/`stderr`/`exit` records are
context, not translator input.

## Sanitization

Home paths → `<HOME>`, temp dirs → `<TMP>`/`<CWD>`, username → `<USER>`, emails →
`<EMAIL>`, session/conversation ids → `<SESSION_n>`, tool-call ids → `<TOOL_n>`,
other ids/UUIDs → `<ID_n>`/`<UUID_n>`, tokens → `<TOKEN_n>`, signatures →
`<SIG_n>`, hex runs ≥16 → `<HEX_n>`, base64-ish runs ≥40 → `<TOK_n>`.
Placeholders are consistent within each file so pairing still works.
Local-environment inventory (personal tool/skill/plugin/agent/command lists,
SessionStart hook output, socket paths) is replaced by `["<REDACTED_LOCAL_ENV>"]`
or `"<REDACTED_LOCAL_ENV>"`; records and keys stay in place. Model names are kept
verbatim — translators surface `init.model` into `system` AgentEvents. Per-kind
READMEs note anything that could not be produced.
