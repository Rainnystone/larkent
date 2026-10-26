# Spec: confirmation card is the single confirmation surface (reply cleanup)

Status: agreed. Docs track only; the code lands on `feat/confirm-card-reply`.

## Problem

A user asked an agent (kind `grok`) in a group to create a weekly agent task. The bridge sent the `确认自动化` card; the user clicked 「是」 and the card was updated in place to `已确认 #N` with its buttons removed. About a minute later the agent's final reply arrived as one long post that mixed six different sources:

| # | Text in the reply | Source |
|---|---|---|
| 1 | Process narration ("先看本群自动化插件怎么建任务…") | Grok adapter: `keepPendingBeforeTool` in `src/agent/grok/jsonl.ts` (~119-123) concatenates pre-tool text into the final answer. Grok-only: Kimi/Devin show it as progress, Cursor drops it. |
| 2 | "这条是刚才 bot 离线时发的，重连后补上" | Model reacting to the backfill hint `formatBackfillLatenessHint` (`src/bot/backfill.ts` ~68-81, injected at `src/bot/channel.ts` ~1859), which says 「如需，可先简短说明延迟原因」. |
| 3 | "已发确认卡…现在还没生效" | Skill template `plugins/automation/skills/automations/SKILL.md:28`; already false because the user had clicked. |
| 4 | Time zone, boundaries, next 4 runs | `SKILL.md:16` requires showing them, duplicating the card (card says 「接下来 3 次」/「共 4 次」, reply said 「后续 4 次」). |
| 5 | Source/target location plus "tell me before confirming" | Model's own addition, asked after the card was already sent. |
| 6 | "（回复生成期间已确认：已确认 #N）" | Bridge-appended by `src/automations/reply-state.ts` (`trackAutomationReply().notice()`, ~47-50) via `appendOutcomeNotice` in `deliverFinalReply` (`src/bot/channel.ts` ~2565-2566). |

The card already shows schedule, start, time zone, next 3 runs, end and total (`src/automations/confirm-card.ts` `automationConfirmBody`); the replace card shows the full new settings; the delete card shows the target's schedule, next run and end. The card already settles in place (`settleDraftCard`, `src/automations/draft-card.ts`) and expires (`expireDueDraftCards`, marks 「已过期」, no extra message).

## Approach

The confirmation card is the only confirmation surface. The reply points at it in one sentence and does not restate its contents or its status. Status changes are shown by updating the card, not by appended text.

- **T1 Grok adapter.** Pre-tool text becomes progress events, never part of the final answer. If no text follows the last tool, the adapter falls back to the last non-empty pre-tool segment as the final answer (also on the user-stop path), so the final answer is never empty.
- **T2 Skill rewrite.** Adopt the agreed text (ticket 02) for `SKILL.md` :12, :16, :18, :22-35, :42-45, :51, :58. Terminology is `确认卡` throughout (`补全卡` stays distinct). `waiting-confirmation` reply is 「用一句话」 pointing at the card, e.g. 「已发确认卡，请在卡上确认。」 (stays true after the click). Questions that need a user decision are asked before `create`/`replace`.
- **T3 Remove reply-state.** Delete `src/automations/reply-state.ts` and its wiring (caller `channel.ts` ~1834, automation notice through `appendOutcomeNotice` ~2062/~2565-2566/~2620). Add a settle-path fallback: only when an applied outcome (confirmed create, applied replace, applied delete) fails to update the card in place, the bridge replies to the card message once with fixed text such as `确认卡未能更新：已确认 #N`, built from `draftConfirmedStatus`/`draftReplacedStatus`/`draftDeletedStatus`. Once per operationId, persisted in the store; no loop retry; none for expired, superseded or cancelled.
- **T4 Backfill.** Format the sent time with the profile time zone (date included when not today; today the host TZ is used by mistake). New hint: `以下用户消息发于 {当地日期时间}（约 N 分钟前），bot 离线期间未处理；消息中的相对时间按发送时刻理解。bridge 已自行告知延迟，直接回答用户请求。` The bridge posts ONE fixed delay line per backfill batch, none for an empty batch.

## Decisions

- Card = single confirmation surface; drop the redundant follow-up.
- T2 must land before or together with T3: today `reply-state.ts` is the only thing correcting a stale 「现在还没生效」.
- The backfill instruction lives only in the backfill hint, not in the automations skill.
- One code PR collects all four tickets.

## Non-goals

- Confirmation TTL stays 24 h (`AUTOMATIONS_DRAFT_TTL_MS`, `src/automations/store.ts`) — **unchanged**.
- `src/bridge-tools/prompt.ts` — **unchanged** (shared discovery contract for all plugins).
- No backfill wording in the automations skill.
- No change to Kimi/Cursor/Devin adapters, card layouts, or the expiry flow (no message on expiry).
- No retry loop for failed card updates.

## Testing

Per ticket (see acceptance). Main seams: `GrokJsonlTranslator` unit tests (T1); skill-content assertions if any (T2); channel delivery with a draft settled during generation plus `settleDraftCard` with a failing channel (T3); `formatBackfillLatenessHint` with a host `TZ` different from the profile, and `runBackfill` batch posting (T4). Run `pnpm exec vitest run <files> --maxWorkers=2`; done = CI green on the code PR head.
