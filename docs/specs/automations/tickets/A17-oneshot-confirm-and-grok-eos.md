# A17 — 一次性确认卡不写每月次数；Grok 控制符不算最终答复

Status: ready-for-agent
Severity: **high**（A11 @ `91b9dec`：结果帖正文是 `<|eos|>`；一次性确认卡显示「约每月 N 次」）
Blocked by: —（A14 的空结果句已在该 SHA；不挡其它票）
Track: 推到现有 code 分支 `feat/automations-v2`（PR #49），不开新 PR
Spec: [../../automations.md](../../automations.md) §3 / §8（确认卡）、§5（结果帖）、A14 空结果句

## (a) 一次性确认卡不显示每月次数

**现象（A11 @ `91b9dec`）**：一次性任务的确认卡出现「约每月 1 次」；触发在 30 天以外时是「约每月 0 次」。

**根因（`91b9dec` 只读核对）**
- `automationConfirmCard`（`src/automations/confirm-card.ts:84`、`:99`）对所有时间表都算 `monthlyFireCount`，并写上 `约每月 ${monthly} 次`。
- `monthlyFireCount`（`src/automations/schedule.ts:488-496`）数的是从 `now` 起 30 天窗口内的触发次数。一次性只有一次：落在窗口内是 1，窗口外是 0。
- 现有单测 `tests/unit/automations/confirm-card.test.ts:43` 断言的是工作日周期卡，不含一次性。

**要做**
- 一次性确认卡不要写每月次数。只保留已有的单次触发时刻，或改写「共 1 次」。二选一，单测锁住所选文案。
- 周期任务（daily / weekday / weekly / interval）仍写「约每月 N 次」。
- `monthlyFireCount` 留给周期任务；不要为了一次性改它的 30 天窗口。

**验收**
- [ ] 单测（`tests/unit/automations/confirm-card.test.ts`）：一次性卡正文不含「约每月」；30 天内与 30 天外各一条，都不出现「约每月 0 次」或「约每月 1 次」。唯一触发时刻仍在卡上（时间表行或接下来的触发列表）。若选择「共 1 次」，正文含这句。
- [ ] 现有工作日卡仍含「约每月」。

## (b) Grok 只含控制符的文本不算最终答复

**现象（A11 @ `91b9dec`，两次）**：agent 任务结果帖正文是「<|eos|>」。

**根因（`91b9dec` 只读核对）**
- `finalTextEvents`（`src/agent/grok/jsonl.ts:226-229`）把非空 `pendingText` 原样发成 `final_text`。
- `flushPendingText`（:240-244）把同一段未过滤文本发成 `text` delta。
- 交互回复、自动化结果帖、文档评论因此都会把它发出去。
- A14 的空结果句「任务已完成，agent 没有给出文字结果。」（`AGENT_EMPTY_RESULT`，`src/automations/agent-run.ts:65`；空正文时 :362）只在正文为空时出现。控制符是非空字符串，所以这句对 Grok 不会触发。

**要做**
- 只在 Grok translator 里处理：trim 之后整段匹配模型控制符（例如 `^<\|[a-z_]+\|>$`）则视为空，不发 `text` / `final_text`。
- 真正的答复里夹有该记号的，不剥离。
- 不在各个消费方各自过滤。

**验收**
- [ ] `tests/unit/agent/grok-jsonl.test.ts`：最终内容只有 `<|eos|>`（以及同类控制符，含前后空白）时，translator 不产出这段文本；普通句子仍原样产出。
- [ ] 自动化结果帖测试：上述 Grok 输出走 fire 路径后，帖子正文是「任务已完成，agent 没有给出文字结果。」，且不含 `<|eos|>`。正常 `final_text` 的结果帖不变（A14）。

## 不做

- 停机时的 process-group kill（另案，不在本票）。
- 不改其它 agent translator。
- 不开新 PR，不把 `docs/specs` 拷到 code 分支。

## 共同验收

- [ ] 先写失败测试，再实现。
- [ ] `pnpm ci:local` 绿；push 和 PR 两次 CI 在 macOS/Ubuntu/Windows 全绿。

## A11 需重跑的场景

一次性任务的确认卡（无「约每月」，能看到唯一触发时刻）；一次 Grok agent fire，模型只输出控制符时结果帖是空结果句，而不是「<|eos|>」。
