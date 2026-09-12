# Delivery note — 03 `--print-timeout` config

**Status:** done
**Claimed by:** code track on [#28](https://github.com/Rainnystone/larkent/pull/28)
**Docs PR:** [#27](https://github.com/Rainnystone/larkent/pull/27)
**Feat PR:** [#28](https://github.com/Rainnystone/larkent/pull/28)
**SHA:** `08e222446b1d6bb94e973e29ec98c768e58b29dc`

## Evidence

- [x] Options parse tests (valid / invalid / unknown key): `tests/unit/agent/antigravity-options.test.ts`
- [x] Argv includes `--print-timeout <value>` when set; omits the flag when unset: `tests/unit/agent/antigravity-argv.test.ts`
- [x] No `10m` product default in the feat PR
- [x] Policy fingerprint unchanged with respect to `printTimeout`: `tests/unit/policy/fingerprint.test.ts`
- [x] Host-local `10m` applied by Coder outside this PR? n/a

TDD: failing-before strict parse threw `unknown antigravity agent option: printTimeout` and argv omitted `--print-timeout`. Passing-after: options + argv + fingerprint + profile-schema tests green. `pnpm ci:local`: 1396 passed, 4 skipped; typecheck and build clean. Rebased onto ticket 01 (`40b4aeb`) before push.

## Residual risk

- Duration check is Go-style (`30s` / `5m` / `1h` / `1h30m` and equivalents) plus a non-zero digit. agy may accept a slightly different subset; a typo still fails at parse rather than spawn.
- Unset still uses agy's own five-minute ceiling. Operators who need longer must set `printTimeout` themselves.
- Empty SUCCESS after print-timeout is unchanged (ticket 02).

## Notes

Config surface only. No Feishu reply-behavior change. Ticket 02 is not in this slice.
