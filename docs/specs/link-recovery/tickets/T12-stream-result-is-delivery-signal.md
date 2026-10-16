# T12: The stream result is the only delivery signal

**Status:** ready-for-agent · Audit: D3 (F2, F3, F4, F25; original E2E A2)

## Goal

Delivery of a streamed answer is judged only by the `stream()` result the bridge awaited, never by the SDK's throttled writes (I2).
- `awaitRenderAwareStream` returns `{confirmed, messageId} | {failed, err} | {none}` instead of throwing. `deliverFinalReply` uses it:
  - confirmed: the stream message id becomes the reply receipt.
  - failed + link: stays staged. After recovery the **same card** is patched (replace-all) with the full answer; no new message.
  - failed + rejected/local: patch the same card with the full answer now. Only if that patch is itself rejected (card gone), or the stream message was never created, fall back to the uuid-protected send from T16 (read-back first). Never two answers (I1).
- Markdown final-flush failure must surface:
  - **Preferred:** a `pnpm patch` of `@larksuite/channel` so the markdown `run()` rejects with the last error when streaming failed or the final flush failed (card mode already rejects).
  - **Fallback if the patch is not viable:** a bridge-owned awaited final update. In card mode that is one `channel.updateCard(messageId, finalCard)`. In markdown mode it is a bridge-owned interactive card patched with `im.v1.message.patch` (verified live). CardKit `updateCardById` is **not** used for recovery: its content could not be verified by read-back (spec §4a.2).
  - Record the choice in the ticket PR.
- Record the stream message id at creation (verified: card-mode `stream()` exposes it at creation, equal to its return value), so the bridge's own echo is never taken as a CLI self-send (F25).
- SDK-faithful fake channel: `update`/`setContent` always resolve; only `stream()` rejects (card) or, with the patch, markdown `run()` (I10).

## Spec sections

Delivery invariants (I1, I2, I3, I10); §4 Outbox (streamed staging)

## Acceptance (behaviour, failing first, against the SDK-faithful fake)

- [ ] Streamed final patch fails (card, link error) → after recovery the **same card** ends with the full answer, and the chat holds no new message.
- [ ] Markdown stream, final write fails with ENETUNREACH → the failure is reported (SDK patch or bridge-owned interactive card), and after recovery the same message ends with the full answer and no new message appears.
- [ ] Card stream, short run, final patch fails → no 继续 notice for a completed turn; one full answer in the same card.
- [ ] Card stream, final patch 400 → the same card is re-patched with the full answer; if that is rejected too, one uuid-protected send. The chat holds exactly one complete answer, the notice is sent, and the journal shows delivered.
- [ ] Stream open fails (no message created) → one uuid-protected send of the full answer after recovery.
- [ ] A card run longer than 30 s whose final patch fails is not marked delivered (was F4).
- [ ] `pnpm ci:local` passes.

## Files likely touched

`src/bot/channel.ts` (`awaitRenderAwareStream`, `deliverFinalReply`, stream branches), `src/bot/self-message.ts` (record id at creation), `patches/@larksuite__channel*.patch` + `package.json` `pnpm.patchedDependencies` (if patched), test fake channel, `interruption-notice.test.ts`, `turn-journal.test.ts`

## Delete

- `stream-fallback.ts` and its tests
- `deliverUnseenStreamFallback`, `remainderReplyState`, `streamedBody`, `lastStreamedText`, `visibleStreamText`, `StreamPatchStatus`, `throwIfStreamPatchFailed`, `liveStreamFinalize`, `lastStreamPatch`
- `noteStreamFinalized` and `reply.streamFinalized` (the stream message id is the receipt)
- All remainder/prefix logic
- `failStreamPatchesAfterFirst` and the tests that depend on `update()` throwing or on top-level `{response:{status}}` errors (`interruption-notice.test.ts` ~329–461, `turn-journal.test.ts` ~148). Rewrite them against the new fake.

## Blocked by

T16
