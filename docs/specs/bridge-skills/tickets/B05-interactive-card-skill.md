# B05 — Card callback convention becomes the `interactive-card` skill

Status: ready-for-agent · Blocked by: B01 · Track: code branch `feat/bridge-skills` (refs verified at `953e7bd`) · One ticket per session · Run after B04 on the shared branch (shared file: system prompt)

## What to build

The "how to send an interactive card that calls back to you" manual leaves the shared system prompt and becomes a skill that only human IM turns see. The bridge's `bridge_token` verification stays the only authority; unattended runs no longer carry the manual.

1. **Tool.** Add `card-callback` (available on run kind `im`) to the tool table, using the same condition the card dispatcher uses to accept a `[card-click]` callback for this profile (if they differ, the dispatcher wins and the gate follows).
2. **Skill** `interactive-card` (`bridge-tools: card-callback lark-cli`): when to send a card versus plain text, `lark-cli im send-card` to `bridge_context.chat_id`, CardKit 2.0, callback buttons need both `__bridge_cb: true` and a `bridge_token` from the bridge-aware lark-cli signer (never guessed, forged, reused or hand-written), no signer → display-only card and ask for a text reply, extra state fields, what the `[card-click] {...}` message looks like, display-only cards carry neither field, the example button. Behaviour-equivalent move.
3. **System prompt.** Remove that section; keep the `interactive_card` section (it explains an input format, a contract) and the final-reply rule that allows cards.

## Source (953e7bd)

- `src/agent/bridge-system-prompt.ts:66-95` (发交互卡片的回调约定); `:49-64` `interactive_card` stays.
- Callback verification: `src/card/dispatcher.ts` and the `bridge_token` signer path; `src/bot/interactive-card.ts:26` comment references the system prompt.
- Tests: `tests/unit/agent/bridge-system-prompt.test.ts`; prior art for callbacks under `tests/integration/bot/`.

## Acceptance criteria

- [ ] Integration: a human IM turn lists `interactive-card` in `<bridge_skills>`; an agent-task fire, a comment run and a meeting run do not.
- [ ] Unit on the system prompt (all agent kinds): the callback section is gone; `interactive_card` remains.
- [ ] Skill contract: `__bridge_cb`, `bridge_token`, `send-card`, `schema: "2.0"` and the display-only rule are in the skill; the example button JSON parses.
- [ ] Existing card-callback tests unchanged and green (verification behaviour unchanged).
- [ ] `pnpm ci:local` passes in the worktree.

## Out of scope

New card tools (send / update card as bridge-native actions); changes to token signing.
