# 02: ERROR with an answer → deliver it, discard the session, no 继续

**Blocked by:** 01 · **Owner:** agy

## What to build

When agy ends with `ERROR`/`FAILED`, `finished_reason` is not `interrupted`/`print_timeout`, and the turn produced an answer (use the source 01 proved reliable), finish as a delivered reply: the card ends normally with that answer, no `⚠️ agent 失败` tail, no 继续 notice. Still discard the session (`invalidateResume`), because agy's ERROR may stick on later resumes. Log the original error at warn so it stays diagnosable.

Decide from first principles what counts as "an answer" (e.g. a fragment cut mid-sentence vs a finished reply) and write the rule and its reason in `delivery-notes/02.md`. Prefer the simplest rule the evidence supports.

## Acceptance

- [ ] ERROR + answer: one normal reply, no failure tail, no 继续 card, session discarded (next message logs `session fresh`).
- [ ] `interrupted` / `print_timeout` paths unchanged (existing tests stay green).
- [ ] Other CLIs unchanged.
- [ ] Test bridge (`rt1`, real agy): reproduce or simulate an ERROR-after-answer turn and show the card.
