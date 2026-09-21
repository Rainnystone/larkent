# 02: Hardening, parity tests, glossary

**What to build:** Lock regressions and operator vocabulary so p2p backfill stays bounded and group behaviour stays identical; document session-known DM discovery in the self-heal glossary / ops notes.

**Blocked by:** 01 (tracer path must already enqueue real p2p messages).

**Status:** ready-for-agent

## Parent

[docs/specs/p2p-wake-up-backfill.md](../../../docs/specs/p2p-wake-up-backfill.md) — D5, D9, D10; Testing Decisions; Out of Scope.

## What to build

After 01’s tracer:

- Extend feishu-backfill parity / unit coverage for p2p vs group filter contrast, newest-N cap on p2p human messages, and combined `maxChats` over the union list.
- Confirm personal-mode DM denial still happens on the **intake** path (scanner does not invent a second allowlist); add a test only if prior art is missing.
- Update `CONTEXT.md` self-heal / backfill glossary: p2p session-known discovery; `maxMentionsPerChat` also caps p2p human messages; first-contact DM still out of scope.
- Short operator note in `docs/operations.md` (or equivalent existing ops doc) — no `/config` UI work.

## Acceptance criteria

- [ ] Automated tests cover: p2p no-@ enqueue; group no-@ drop; newest-N truncation on a p2p chat; union list respects `maxChats`.
- [ ] Glossary / ops docs updated per Spec D9–D10; no preference key renames.
- [ ] Code PR still free of `.scratch/` / Spec scaffolding; `/tdd` + in-session `/code-review`; `pnpm ci:local` green; delivery note on docs PR.

## Blocked by

- [01: P2P wake-up backfill tracer](01-p2p-backfill-tracer.md)
