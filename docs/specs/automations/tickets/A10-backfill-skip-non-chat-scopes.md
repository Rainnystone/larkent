# A10: Backfill never queries auto:/meeting: scopes (F20)

**What to build:** when backfill derives chat ids from session scopes, `auto:` and `meeting:` scopes never enter chat-mode lookup and cannot mark a scan incomplete.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Regression test with auto: and meeting: scopes in the catalog: no chat-mode query, scan complete.
