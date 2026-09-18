# 02: Scrub `<task_notification>` envelope family #2

**What to build:** extend the pure envelopes module from 01 so `<task_notification>…</task_notification>` (and unclosed only when fingerprinted, once a fingerprint is confirmed) is scrubbed at the same antigravity final_text seam. Fixture TN1: task_notification blob + vitest failure line whose **test name** contains `<SYSTEM_MESSAGE>` + trailing Chinese answer → drop the task_notification envelope; do **not** peel-to-end from the title citation; keep the Chinese answer.

**Blocked by:** 01 (classifier module + SYSTEM_MESSAGE rules must already land so TN1 does not reintroduce #30 peel-to-end, and 02 only adds a family row).

**Status:** delivered (code PR https://github.com/Rainnystone/larkent/pull/32 @ `fdadb17`)

## Parent

[docs/specs/agy-envelope-scrub-v2.md](../../../docs/specs/agy-envelope-scrub-v2.md) — D13; fixture **TN1**; Problem Statement post-22:24 verification.

## What to build

Private-chat evidence 2026-09-18 ~22:27 CST: outbound scrubbed **20885→259** because a `<task_notification>`-prefixed body also contained an unclosed `<SYSTEM_MESSAGE>` inside a vitest test title. #30 peeled from that title tag through end; Feishu only got ~259 chars ending at `nested`. Separately, #30 never strips `<task_notification>`, so Feishu can still receive that prefix even when SYSTEM_MESSAGE scrub “succeeds.”

After 01’s classifier, the SYSTEM_MESSAGE-in-title case must already retain (B4). This ticket adds family #2:

- Positional opener candidacy for `<task_notification>` / `</task_notification>` (same D1 spirit; case-sensitive exact tags).
- Balanced pairs strip without requiring a fingerprint (D4 analog).
- Unclosed: strip-through-end only if a confirmed fingerprint exists; until a fingerprint row is documented in the shape table, prefer retain-unclosed over peel-to-end (do not re-litigate D4’s rejection of “always keep unclosed” for SYSTEM_MESSAGE — apply the same rule once fingerprinted).
- Code-context / mid-line citations of the tag string stay retained (D2).
- Same seam: pure module + both final_text emission paths. Telemetry may reuse scrubbed-length logs with a family discriminator or a sibling event name — never log body.
- Do not invent a general HTML sanitizer. Do not touch channel.

This ticket does **not** rework the SYSTEM_MESSAGE classifier (01). It does **not** treat fullwidth `【SYSTEM_MESSAGE】` evasion (residual risk only).

## Acceptance criteria

- [x] TN1 fixture (or inline): `<task_notification>…</task_notification>` (or unclosed blob if fingerprinted) + vitest failure line with `<SYSTEM_MESSAGE>` in the test **title** + trailing Chinese answer → `final_text` contains the Chinese answer, contains **no** `<task_notification`, and still contains the test-title citation region byte-identical for the SYSTEM_MESSAGE mention (no peel-to-end).
- [x] Balanced task_notification + clean prose → prose only.
- [x] Mid-line / code-span / fence citation of `task_notification` retained.
- [x] ERROR path still untouched.
- [x] Translator both emission paths covered via the shared module.
- [x] Tests red-then-green acceptable as one or two commits on the same code PR; `pnpm ci:local` green.
- [x] Delivery note filled; no Spec/scratch on the code PR.

## Blocked by

- [01: SYSTEM_MESSAGE envelope classifier scrub (supersede #30)](01-envelope-classifier-scrub.md)
