# 03: Real Feishu E2E checklist (Bot Arena)

**Blocked by:** 02 · **Status:** blocked · **Owner:** operator (human-run; no product code)

Test bridge only, Bot Arena group, test account 「Agent测试专员」, every message prefixed `【端到端测试】`. Never use the production bridge or a personal account. Receiver URL/key set via env on the test bridge only; never pasted into chat, PR or logs.

- [ ] One message ⇒ exactly one POST at the receiver; payload matches D2, no message text.
- [ ] Two different messages ⇒ two POSTs with different keys.
- [ ] Unreachable URL (e.g. `https://example.invalid/hook`) ⇒ reply latency unchanged vs. plugin off; one warn line, no URL/key in log.
- [ ] Restart bridge then re-trigger a backfilled/redelivered message ⇒ expect a second POST with a **new** `run_id` (accepted by design); confirm receiver does not create a duplicate patrol.
- [ ] Payload `run_id` greps to the run in the local (unredacted) bridge log.
- [ ] URL unset ⇒ one startup notice, no POST.

Record results in `delivery-notes/03-feishu-e2e.md` on this docs branch.
