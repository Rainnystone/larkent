# 01: Log agy terminal facts (tracer)

**Blocked by:** none · **Owner:** agy

## Why

Tickets 02 and 03 branch on "did agy produce an answer this turn". Today `terminal-result` cannot tell. Make the branch condition observable first.

## What to build

On every agy `terminal-result` log line (`src/agent/antigravity/jsonl.ts`, `logTerminalResult`), add: `finished_reason`, `responseChars` (length of `result.response`, 0 when absent), and `heldAnswerChars` (length of held-back answer text in the final-answer core at terminal time). Lengths only, never content.

## Acceptance

- [ ] Unit tests over captured agy JSONL fixtures: ERROR with response, ERROR without, success, `print_timeout`, `interrupted` each log the three fields correctly.
- [ ] Real probe on this box: one short `agy -p` success and one forced ERROR (e.g. shim `agy-print-timeout`, or a real error you can trigger safely) show the fields in the test bridge log.
- [ ] Note in `delivery-notes/01.md`: for an ERROR-with-answer turn, which of `result.response` and held text carries the answer. Ticket 02 builds on this.
