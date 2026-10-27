# D02 Reminders and draft cards become Outbox items

Spec: D4, D5, D1, A2, A3. Blocked by: D01.
Touch: `src/automations/delivery.ts`, `src/automations/draft-delivery.ts`, `src/automations/store.ts` (draft delivery fields), `src/automations/migrations.ts`, the Outbox module, `src/bot/feishu-delivery.ts` (readback shared with the Outbox), tests, `CONTEXT.md`.

## Why

`automations/delivery.ts:126-190` stages reminders on the journal and re-implements redeliver + classify. `automations/draft-delivery.ts` keeps its own `prepared` / `sending` / `rejected` state in `automations.json` and its own `user_card_content` readback (`3930464c`, `0b558656`). These are the third and fourth copies of durable send.

## Do

1. Characterize: `tests/integration/bot/auto-delivery-outbox.test.ts`, `reminder-tools/*.test.ts`, `auto-recurring-create-and-expiry.test.ts`, `auto-nl-creation.test.ts`, `tests/unit/automations/*delivery*`, and any draft readback test stay green before and after.
2. Red: Outbox tests for two new item kinds. Reminder / result: staged under the fire turn, delivered once across restart. Draft card: created card id persisted before send (a crash after this point is unknown, never a new send), readback by the draft marker element id binds exactly one message, more than one match binds nothing, absence proves nothing; the receipt hook binds `messageId` / `cardId` / body to the draft.
3. Green: route reminders and draft-card sends through the Outbox. Delete the send / classify / readback code in `delivery.ts` and `draft-delivery.ts` that the Outbox now owns.
4. Migrate: bump `automations.json` schema; move in-flight `prepared` / `sending` draft deliveries to Outbox items atomically; add fixture tests for both states, including restart then exactly one card.
5. Rely only on Feishu behaviour that current code already relies on (D12). If a step seems to need a new one, stop, record the question on the docs PR, and do not guess; the owner or Grokbot verifies it with `lark-cli`.
6. Update `CONTEXT.md` (Outbox item kinds; automations persistence). `/code-review`.

## Acceptance

- [ ] No Feishu send-with-classify or readback logic remains in `automations/delivery.ts` or `automations/draft-delivery.ts`.
- [ ] Old `automations.json` with `prepared` / `sending` drafts upgrades atomically and yields exactly one bound card after restart.
- [ ] Tests listed in Do 1 green; `pnpm ci:local` green; delivery note posted.
