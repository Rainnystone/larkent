# 06: `preferences.backfill` config block — portable defaults, kill switch, dry-run flag

**What to build:** Every profile, regardless of agent kind, gets the same `preferences.backfill` block with the spec §14 defaults applied when absent: `enabled: true`, `dryRun: false`, `lookbackMs: 6h`, `minGapMs: 60s`, `maxChats: 50`, `maxRawPerChat: 200`, `maxMentionsPerChat: 20`, `chats: []`. Invalid values are normalized (negative → default, non-array `chats` → `[]`, non-`oc_` ids dropped with a warn). `/doctor` prints the effective values so an operator can see what the profile will do before ticket 07 gives the block any behaviour. `enabled: false` and `dryRun: true` are the two operator safety levers and are honoured by tickets 07 and 08.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Typed `BackfillPreferences` on the shared `AppPreferences` (not on any adapter's options); profile normalizer fills defaults; typed getter(s) in the schema module following the existing `getRunIdleTimeoutMs`-style pattern.
- [x] Round-trips through profile load/save without adding the block to profiles that never set it (omit when equal to defaults, like `chatRequireMention`), or always writes it — pick one and pin it with a fixture test.
- [x] Web console / `/config` card **not** required; if touched, changes are display-only.
- [x] `/doctor` shows the effective block on one line (or appended to ticket 05's self-heal line).
- [x] Ledger pruning horizon (ticket 04) now reads `2 × lookbackMs` from this block.
- [x] Tests: absent block → defaults; partial block → merged; garbage values → normalized with warnings; fixture-based load parity for existing profiles of every registered agent kind (extend the existing profile fixtures, do not add kind-specific ones).
- [x] `docs/operations.md` config table gains one row for `preferences.backfill` (behaviour text lands with ticket 09).
