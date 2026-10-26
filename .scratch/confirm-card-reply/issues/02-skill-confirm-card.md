# 02 — Automations skill: one sentence pointing at the 确认卡

Spec: `docs/specs/confirm-card-reply.md` (Problem rows 3-5, Approach T2, Decisions).
Blocked by: none. **Must land before or with 03.**
Code branch: `feat/confirm-card-reply`. Touch only `plugins/automation/skills/automations/SKILL.md` and tests that assert its content.

## Do — replace these sections verbatim

**`:12`**
```
模型负责把用户的自然语言映射到 schema 字段。保留原意与准确时间，明确时区。需要用户决定的内容（例如 agent 任务读取和写入的位置）在提交创建或替换前问清，使确认卡上的内容就是最终内容。收到 `needs-input` 时依据 `fields` 补必要信息或向用户提问；收到 `validation-failed` 时依据 `code` 在本轮修正，不重复原错误。业务边界、限制与可用性以实际 schema 和工具结果为准。
```

**`:16`**: delete from 「回复时展示时区…」 through 「…尚未创建、确认或执行。」; the line then starts at 「创建任务使用 `automation.create`…」, rest unchanged.

**`:18`**: `只有 \`waiting-confirmation\` 且有真实卡片回执时才能说等待确认；` → `只有 \`waiting-confirmation\` 且有真实卡片回执时才指向确认卡；`

**`:22-35`**
```
## 向用户说明结果

把工具事实翻译成用户的日常语言，说明当前状态和下一步。以下左列用于理解工具结果，右列用于组织回复；普通回复不输出 JSON 字段名、状态代码或 true/false 等布尔值。

确认卡是创建、替换和删除的唯一确认入口：它展示任务与排期详情，并在用户确认、取消或卡片过期、失效时就地更新状态。发出确认卡后，回复用一句话指向确认卡，排期详情和确认状态都由确认卡表达。没有确认卡的结果才在回复中写出排期：预览结果写出时区、起止边界、后续时刻和总次数，次数只引用结果中的 `occurrenceCount`（与确认卡同一算法），不按起止日自行加减；`occurrenceCountCapped` 为真时说超过该次数。预览成功只说明参数可用，尚未创建、确认或执行。

| 工具结果 | 用户表述 |
| --- | --- |
| `waiting-confirmation` | 用一句话指向确认卡，例如「已发确认卡，请在卡上确认。」仅在本轮实际发卡成功时使用。 |
| `applied` | 本次操作已生效；按实际操作说「任务已保存」「已暂停」「已恢复」或「已删除」。未来执行和送达仍以各自实际状态为准。 |
| `needs-input` | 还需要补充信息；用日常语言问清缺少的内容，例如「要提醒到哪一天？」缺结束日期时说「还需选择结束日期」。若已发补全卡，说「请在补全卡上选择结束日期，再在确认卡上确认」。 |
| `validation-failed` | 说明具体问题并按原意修正，例如「这个时间不可用，请提供未来的时间。」能依据原意修正时在本轮继续；需要用户决定时再提问。 |
| `unknown` | 暂时无法确认这次操作是否生效，我先查询原操作的结果。沿用原编号查询，不宣称成功或失败，也不重新创建。 |
| `execution-failed` | 这次操作未能完成；说明实际失败原因。若是已建立任务的后续运行失败，改说「任务本次运行失败」，不能说成创建失败。 |

回复陈述本轮工具结果中的事实，确认卡此后的变化由确认卡自身显示。用户询问任务或操作状态时，先查询最新结果再回答。生效、执行和送达分别按实际回执表述；只有实际运行成功且结果已送达时，才能同时说执行完成和已送达。
```

**`:42-45`**
```
- 两份待确认：「已发早间提醒和晚间提醒的确认卡，请分别在卡上确认。」
- 一份已确认、一份待确认：「早间提醒已保存；晚间提醒请在它的确认卡上确认。」
- 草稿已修订：「旧确认卡已失效，请在新的确认卡上确认。」仅在实际取代成功后这样说。
- 某份结果未知：「早间提醒请在确认卡上确认；晚间提醒的保存结果暂时无法确认，我先查询这次操作。」不能把未知说成失败或另建一份。
```

**`:51`** (the zone in the negative example uses the skill's existing `Europe/London` example)
```
- 等待确认：正例：「已发确认卡，请在卡上确认。」反例：「已发确认卡，点「是」后生效；现在尚未生效。时区 Europe/London，后续 4 次：……」或「waiting-confirmation，applied: false，operationId: op1.…」。
```

**`:58`**: `成功后说明「旧确认卡已失效，请在新的确认卡上确认」。`

Do **not** change `src/bridge-tools/prompt.ts`. Do **not** add backfill wording to this skill.

## Acceptance

- [ ] The sections above match verbatim; no other skill lines change.
- [ ] `rg '现在尚未生效|才能说等待确认|回复时展示时区' plugins/automation` returns only the negative example.
- [ ] Tests that assert skill content (grep `已发确认卡`, `occurrenceCount` under `tests/`) updated and green.
- [ ] `src/bridge-tools/prompt.ts` unchanged. CI green on the code PR head.
- [ ] Manual check on the test bridge per profile (grok, cursor, devin, kimi), generic task names: create → one sentence pointing at the card; preview → full schedule details; pause → short result; two drafts → one pointer per card.
