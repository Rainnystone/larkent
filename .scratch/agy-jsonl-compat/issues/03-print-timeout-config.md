# 03: First-class antigravity `--print-timeout` option

**What to build:** an antigravity profile can set `agent.options.printTimeout`. Print-mode argv then includes `--print-timeout <value>`. Unset keeps today's argv (agy's own five-minute default). This is the config surface only — it does not change empty-SUCCESS classification and does not write `10m` into the repo.

**Blocked by:** None (can start immediately). Independent of 01 and 02.

**Status:** ready-for-agent

## Parent

[docs/specs/agy-jsonl-compat.md](../../../docs/specs/agy-jsonl-compat.md) — section (c) print-timeout config surface.

## What to build

agy already documents `--print-timeout` (default five minutes). The bridge does not pass it today. Operators who need a longer ceiling (the Coder's host used a local `10m` patch) have no first-class option.

Add `printTimeout` to antigravity agent options. Accepted values are duration strings agy already accepts (`30s`, `5m`, `10m`, `1h`, and equivalents). When the option is set, `buildAntigravityArgs` appends `--print-timeout` and that value. When it is absent, omit the flag. Strict parse still rejects unknown keys; a present-but-invalid duration is rejected at options parse.

Do not put `printTimeout` into the policy fingerprint. Do not pass the flag for other agent kinds. Do not change Feishu reply behavior. The host-local `10m` value stays with the Coder — this ticket only makes the knob exist.

## Acceptance criteria

- [ ] `printTimeout` is a documented, parsed antigravity `agent.options` field. Invalid values fail parse; unknown option keys still fail the existing strict path.
- [ ] When `printTimeout` is set to a valid duration, print-mode argv contains `--print-timeout` followed by that exact value, and still includes today's unattended flags (`-p`, `--output-format stream-json`, `--dangerously-skip-permissions`, `--disable-slash-commands`).
- [ ] When `printTimeout` is unset, argv does **not** contain `--print-timeout` (agy default unchanged).
- [ ] Resume (`--conversation`) and `--model` still work when `printTimeout` is set.
- [ ] Restricted sandbox still throws before spawn; this option does not bypass that.
- [ ] Policy fingerprint inputs for antigravity stay empty with respect to `printTimeout` (changing the ceiling does not invalidate resume).
- [ ] Tests cover options parse + argv at the existing options/argv seam. No live agy. No `10m` default hardcoded as the product default.

## Blocked by

- None (can start immediately).
