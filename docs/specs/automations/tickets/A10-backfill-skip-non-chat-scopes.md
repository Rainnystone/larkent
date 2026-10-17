# A10: Backfill never queries auto:/meeting: scopes (F20)

Spec: [../../automations.md](../../automations.md) §11

**What to build:** when backfill derives chat ids from session scopes, `auto:` and `meeting:` scopes never enter chat-mode lookup and can't mark a scan incomplete. On master, `chatIdFromScope` takes the prefix before the first `:` as a chat id (src/bot/backfill.ts:617-620, used by `uniqueSessionChatIds` at :551-567), so `auto:3:…` and `meeting:…` become the bogus chat ids `auto` / `meeting`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Regression test with `auto:` and `meeting:` scopes in the catalog: no chat-mode query, scan complete.
