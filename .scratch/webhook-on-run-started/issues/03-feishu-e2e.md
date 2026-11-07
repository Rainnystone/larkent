# 03: Real Feishu E2E checklist (Bot Arena)

**Blocked by:** 02 · **Status:** blocked · **Owner:** operator (human-run; no product code)

Test bridge only, Bot Arena group, test account 「Agent测试专员」, every message prefixed `【端到端测试】`. Never use the production bridge or a personal account. Receiver URL/key set via env on the test bridge only; never pasted into chat, PR or logs.

- [ ] One message ⇒ exactly one POST at the receiver; payload matches D2, no message text.
- [ ] Two different messages ⇒ two POSTs with different keys.
- [ ] Unreachable URL (e.g. `https://example.invalid/hook`) ⇒ reply latency unchanged vs. plugin off; one warn line, no URL/key in log.
- [ ] Restart bridge then re-trigger a redelivered message ⇒ any extra POST has the **same `task_key`** (new `run_id`); receiver creates **no duplicate patrol**: exactly one patrol for that message (same `task_key`, new `run_id`).
- [ ] Receiver resolves full ids by grepping the local bridge log for `run_id`; on a forced failure the patrol shows *pending verification*, never ids guessed from last-6 values.
- [ ] Two different messages ⇒ different `task_key`s, two patrols (never merged).
- [ ] `run_id` greps to the exact run in the local (unredacted) bridge log; `task_key` matches across the original and repeated wakes.
- [ ] URL unset ⇒ one startup notice, no POST.

Record results in `delivery-notes/03-feishu-e2e.md` on this docs branch.
