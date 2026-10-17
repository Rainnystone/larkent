# A10: Backfill never queries auto:/meeting: scopes (F20)

Spec: [../../automations.md](../../automations.md) §11

**What to build:** when backfill derives chat ids from session scopes, `auto:` and `meeting:` scopes never enter chat-mode lookup and cannot mark a scan incomplete. (On master the scope prefix before the first `:` is taken as a chat id, so `auto:3:…` and `meeting:…` become the bogus chat ids `auto` / `meeting`.)

**Blocked by:** None

**Depends on #47:** soft (high conflict) — #47 rewrites backfill's session-chat discovery and incomplete-scan handling; wait for #47 to merge and apply the fix on top.

**Status:** ready-for-agent (after #47)

- [ ] Regression test with `auto:` and `meeting:` scopes in the catalog: no chat-mode query, scan complete.
