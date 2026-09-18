# 01: SYSTEM_MESSAGE envelope classifier scrub (supersede #30)

**What to build:** replace the #30 greedy / depth-matching `<SYSTEM_MESSAGE>` scrub with the locked positional + code-context + fingerprint classifier (D1–D9, D11–D12). Real envelopes leave Feishu; citations and non-fingerprinted unclosed tags stay byte-identical. Extract a pure module (e.g. `src/agent/antigravity/envelopes.ts`) used on both `translateResult` and `prependHeldBack` final_text paths. Two commits on the code PR: (1) fixtures/tests red (2) implementation green + `pnpm ci:local`.

**Blocked by:** None (can start immediately).

**Status:** delivered (code PR https://github.com/Rainnystone/larkent/pull/32 @ `eaacee9`)

## Parent

[docs/specs/agy-envelope-scrub-v2.md](../../../docs/specs/agy-envelope-scrub-v2.md) — Implementation Decisions D1–D12; fixture matrix A1–A4, B1–B5, C1–C3, T1.

## What to build

#30 strips from any `<SYSTEM_MESSAGE>` open through a depth-matched closer, or through end of string if unclosed. That fixed Incident A (leak) and caused Incident B (over-scrub): inline `` `<SYSTEM_MESSAGE>` `` in prose/blockquote and vitest titles peeled away the rest of the reply (e.g. 415→190, 864→469, 20885→259).

After this ticket:

- **D1** Opener candidacy is positional (line-start / string pos 0 only).
- **D2** Odd inline backticks on the line, or odd fence-line count so far → citation, retain.
- **D3** Fingerprint: within ~64 chars after tag match `^\s*\[Message\]\s+(timestamp|sender|priority|content)=`, OR preceding line is the known preamble. Keep a small shape table for future rows.
- **D4** Balanced → strip (fingerprint not required). Unclosed → strip-through-end **only if fingerprinted**; else byte-identical. Never strip-only-token.
- **D5** No nesting depth — first closer wins.
- **D6** When stripping, also remove immediately preceding preamble line if present.
- **D7** Post-strip trim; empty → existing empty SUCCESS / timeout-hint; ERROR untouched; case-sensitive tags; stray closer alone left alone.
- **D8** Seam stays antigravity translator; pure `envelopes.ts` (or equivalent); no channel/CoT/other translators.
- **D9** Telemetry: lengths + removed count, unclosed bool, preambleRemoved, sawSystemMessageStep; `jsonl.system_message_tag_retained` with reasons `mid-line` / `code-span` / `fence` / `unclosed-no-fingerprint`. Never log body.
- **D11** Two commits: red fixtures/tests, then green + `pnpm ci:local`.
- **D12** Matrix A1–A4, B1–B5, C1–C3, T1. Rewrite #30 unclosed test expectation. A2 cites Incident A message `om_x100b65e6a11b3cb4b10254b74b00974` when payload available.

Optional **D10** (`BRIDGE_SYSTEM_PROMPT` one-liner) may land in this ticket or a tiny follow-up — not load-bearing.

This ticket does **not** implement `<task_notification>` (that is 02). It **does** land the pure module 02 will extend.

## Acceptance criteria

- [x] Pure envelopes helper exists and is covered by unit tests for matrix rows A1–A4, B1–B5, C1–C3, T1 (inline objects and/or fixtures).
- [x] A1: balanced fingerprinted envelope + prose → prose only, no `<SYSTEM_MESSAGE` in `final_text`.
- [x] A2: Incident A–shaped (or redacted citing `om_x100b65e6a11b3cb4b10254b74b00974`) → envelope stripped, user answer kept.
- [x] A3: unclosed + fingerprinted → strip-through-end; no leak of envelope body.
- [x] A4: preamble line + envelope + prose → preamble and envelope gone; prose kept.
- [x] B1–B3: mid-line / inline-code / fence citations retained; `jsonl.system_message_tag_retained` reasons when applicable.
- [x] B4: unclosed, no fingerprint → **whole string byte-identical** (rewrites #30 unclosed peel-to-end expectation).
- [x] B5: stray closer alone left alone.
- [x] C1: nested-looking opens → first closer wins (no depth).
- [x] C2: envelope-only → no user-facing `final_text` from that content (empty / existing hint path).
- [x] C3: ERROR / FAILED mapping unchanged even if error text mentions the tag.
- [x] T1: scrub log includes lengths + removed count + unclosed + preambleRemoved (+ sawSystemMessageStep when applicable); never the body.
- [x] Both `translateResult` and `prependHeldBack` paths use the shared helper.
- [x] Code PR has two commits: (1) red tests/fixtures (2) green implementation; `pnpm ci:local` passes on (2).
- [x] No `.scratch/` or Spec files on the code PR. No channel.ts / keepalive changes.

## Blocked by

- None (can start immediately).
