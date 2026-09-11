# 02: Problem A — bridge owns the final reply (agent instructions + docs)

**What to build:** Every agent kind, through the **shared** bridge instructions it receives on each run, is told: the bridge posts the final answer to the triggering chat; do not IM-send (`lark-cli im +messages-send`, `+messages-reply`, `send-card`) to the current `bridge_context.chat_id` as a way of answering; sending to *other* chats or on explicit user request is fine. `docs/operations.md` states the same rule for operators. This is the single-writer-of-truth principle (spec §0, principle 1) made explicit; it ships with zero runtime risk and reduces Problem A on its own before ticket 03 lands.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] The shared bridge instruction text (the block every adapter receives, not a per-agent-kind string) contains the rule; no `agentKind` branching is introduced.
- [x] Wording distinguishes "reply to the current chat" (forbidden — bridge's job) from "send elsewhere / user explicitly asked for a lark-cli send" (allowed).
- [x] `docs/operations.md` gains a short paragraph under chat behaviour: one turn → one bridge-owned final reply; agents must not post the final answer themselves.
- [x] A static test pins the instruction phrase so it cannot silently disappear (mirroring the existing README contract test style).
- [x] Existing prompt snapshot/parity tests updated once for the new line; no behaviour change elsewhere.
- [x] No profile, bot or host names in the new text.
