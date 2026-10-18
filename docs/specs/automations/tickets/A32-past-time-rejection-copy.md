# A32 — OBS-1: clean up the past-time rejection copy

Status: ready-for-agent · Blocked by: none · Track: code PR #49, branch `feat/automations-v2` (refs verified at b020c23) · Lands before merge · One ticket per session

## Problem (observed)

Creating an automation for a time earlier today gave this reply:

> 今天 00:30 已过。例如：明天 00:30「今天 00:30」。可写成「明天 09:00」「2026-10-18 15:50」…

There are two problems:

- The suggestion is duplicated: 「例如：明天 00:30」 and then 「可写成…」.
- The absolute example `2026-10-18 15:50` is hard-coded, and it is already in the past.

## Source (b020c23)

- `src/automations/command.ts:798` returns `今天 ${clock} 已过。例如：明天 ${clock}`.
- `src/automations/command.ts:271-278` (`automationRejectReplyLine`) wraps that reason and appends the fixed `可写成「明天 09:00」「2026-10-18 15:50」「10 分钟后」。` text.
- Related: `src/automations/proposal.ts:40` also hard-codes example dates in agent instructions. Review it, but change it only if the same fix applies trivially.

## Required outcome

1. The past-time rejection is one clear line with a single suggestion, for example 「今天 00:30 已过，可改为「明天 00:30」。」.
2. Any absolute-date example is derived from the current date (the injected `now`), never hard-coded.
3. No other behavior change: same rejection decision and verb, and other rejection reasons keep working.

## Tests

- Unit tests for the copy: the past-time case yields a single suggestion with no duplicated example.
- With a fixed `now`, any absolute-date example is on or after `now`, and it changes when `now` changes.
- Existing command tests still pass.

## Out of scope

Parser and schedule semantics.
