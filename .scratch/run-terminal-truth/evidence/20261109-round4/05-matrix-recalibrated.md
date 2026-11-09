# 05 Remaining Matrix — Recalibrated Prep (no send / no fault)

Timebase: Asia/Shanghai. Proxy stays **off**. Production untouched.

Sources (schema / harness / evidence — not guesses):
- agy binary tool schema (`WaitMsBeforeAsync` 500–10000; `command_status` `WaitDurationSeconds` max **300**)
- fixture `tests/fixtures/transcripts/antigravity/long-tool.jsonl` (agy 1.4.8): `run_command` ACTIVE→DONE span **46.49s** for `sleep 45` (ACTIVE persists through “background task” stderr)
- `e2e/test-bridge/README.md` + `cli.ts` fault subcommands
- `e2e/test-bridge/proxy.ts`: modes apply on **new CONNECT** only; `setMode` does not tear existing tunnels
- Spec/delivery notes Q1–Q9; `CommentConfig = Record<string, never>` (empty `comments: {}` is normal, not “feature off”)
- lark-cli user wiki read: unique space **Bot Arena Test Only** (1 of 11)

---

## R2 — Executable foreground long-tool prompt + safe observation

### Schema facts (must drive the prompt)
| Tool / field | Limit | Effect |
| --- | --- | --- |
| `run_command.WaitMsBeforeAsync` | **500–10000** ms (required) | After this window the CLI may background the shell for the *model*; max synchronous wait is **10s**, not 960s |
| `run_command` “indefinitely” / daemon-style flag | leave **false** | Schema: true only for processes not expected to finish (dev servers). Sleep must terminate |
| `command_status.WaitDurationSeconds` | **0–300** (max **300**) | Poll/wait after a backgrounded command; **cannot** alone cover 960s in one call |
| Bridge tool grace | opens on structured `tool` ACTIVE (CommandLine); closes on DONE | Q6: unstructured stderr `waiting … background task(s)` is **not** a grace signal |

### Important evidence vs the “10s clears pendingTool” fear
1.4.8 long-tool: ACTIVE at t≈14.3s, stderr “background task(s)” at t≈29.5s, DONE at t≈60.7s with `duration_seconds≈46.49` for `sleep 45`. So **NDJSON tool ACTIVE can outlive the WaitMs background notification** for the full sleep. Treat 1.5.3 the same only after the **early ACTIVE check** below — do not wait 16 minutes to learn ACTIVE never stuck.

### Immediately executable Feishu message text (R2)
Send **once** (new topic or allowed thread), real `@Test Bot`, prefix required. **Do not** send a second user message mid-run (that is Q5 intake / queue / cancel — not same-run model chatter; cannot claim Q5 pass).

```
@Test Bot 【端到端测试】R2：只做一件事。立刻调用 run_command，参数必须同时满足：
1) CommandLine 精确为：python3 -c 'import time; time.sleep(960); print("R2-TOOL-DONE")'
2) WaitMsBeforeAsync=10000（schema 上限；禁止用更小值“早点背景化”）
3) 不要把该命令标成 indefinitely/daemon；命令必须自己结束
4) 禁止在工具仍 ACTIVE 时向用户发中途进度/假完成；禁止开并行无关工具；禁止再等用户第二句话
5) 若 CLI 在 WaitMs 后提示已 background：立刻用 command_status，WaitDurationSeconds=300，对同一命令反复轮询直到结束（可连续多次 300s，覆盖满 960s），不要结束 turn
6) 仅当 stdout 出现 R2-TOOL-DONE 后，再用一句话回复：R2-OK
```

### Safe observation (abort early — no 16‑min surprise)

**T0** = intake/run start in bridge log / stdout-capture.

| When | Check | Pass continue / Abort |
| --- | --- | --- |
| ≤60s | stdout-capture has `step_type=tool` `tool_name=run_command` `state=ACTIVE` and **no** matching DONE yet; CommandLine contains `sleep(960)` or `R2-TOOL-DONE` | If no ACTIVE by 60s → **ABORT** (model ignored tool). If DONE with duration≪60 and no successor `command_status` ACTIVE → **ABORT: cannot keep structured tool ACTIVE** (schema/Q6 gap) |
| 90s | Still no DONE for that tool step **or** a `command_status` tool step is ACTIVE | If tool DONE and only stderr “background task” with no structured tool ACTIVE → **ABORT** (pendingTool gone; Spec Q6) |
| 15m+ (only if early checks passed) | Same tool id still open **or** continuous successor tool ACTIVE covering the gap; bridge has **not** fired normal 15m idle stop | PASS candidate for “tool silent past 15m” |
| ~16m+ | Eventually DONE + bot says `R2-OK` with `R2-TOOL-DONE` in tool output | Full duration proof |

### How to prove tool still ACTIVE >15m from bridge logs
1. **Stdout capture** under `~/.lark-channel-e2e/rt1/stdout-captures/`: timestamps of `step_update` with `step_type:"tool"`, `state:"ACTIVE"` then later `DONE`, same `step_index` / tool name. Wall delta ACTIVE→DONE (or unbroken ACTIVE chain via `command_status`) must be **>900s**.
2. **Bridge run log / journal**: look for tool-grace / pending-tool / awake-watchdog path that records open tool (unit tests describe `tool_use` + alive past 15m until 60m `timer:'tool-grace'`). Live log phrases vary; prefer pairing stdout ACTIVE with “no idle-stop at 15m”.
3. **Negative proof**: if idle-stop / run cancel fires at ~15m **while** stdout still shows tool ACTIVE → product bug (record). If ACTIVE ended at ~10s and only unstructured stderr remains → **not** a valid R2 (Q6 gap), stop.

Do **not** claim R2 pass from: model replied then silence; or second user ping; or background stderr alone.

---

## R1 — Mid-run reconnect / model-path fault (real harness only)

### Documented fault subcommands (`e2e/test-bridge/README.md` / `cli.ts`)
`arm <mode>`, `proxy <disconnect|blackhole|eproto|eai_again|slow|off> [--host …]`, `kill-cli`, `ws-freeze` / `ws-unfreeze`.

| Mode | What it really is | OK for R1? |
| --- | --- | --- |
| `ws-freeze` | **SIGSTOP wake-up helper only** (process freeze of bridge; not model hang) | **No** as model hang |
| `proxy disconnect/blackhole/…` | Affects **new CONNECT** to selected hosts; **existing tunnels keep flowing** (`proxy.ts` switch on new CONNECT; `setMode` does not destroy keepalives) | Only if a **new** model egress connect happens after arm; cannot assume it cuts an already-open stream |
| `arm hang` / `cursor-stall` / `agy-*` | **Shim** fake path | Not a real model-host hang |
| `kill-cli` | Kills CLI process | Different failure class (death, not silent model) |

### Distinctions required
- **Real model/SDK timeout or stream error** (e.g. sticky ERROR + response) ≠ bridge idle stop.
- **Bridge idle 15m** after a **completed** SUCCESS turn ≠ hang pass.
- Model replies `WAIT` then ends turn → run finishes → **not** an active hang.

### Reproducible method (narrow) or gap
1. Prefer **model-host-scoped** proxy (`--host` = model egress, not Feishu) **before** the run starts, or force a mid-run **new** connect (hard with keepalives).
2. If the live stream rides an existing tunnel, `proxy disconnect` after SEED **will not** cut it — that is an evidenced harness limit, not a pass.
3. **Gap:** no documented fault keeps a **real** model request open while silencing progress for ≥2m after reconnect without also ending the turn or faking via shim. Do not use “normal end + 2m quiet” as R1 pass.

---

## R3 — Model-only hang (no tool)

### Invalid
- Prompt “reply WAIT then stay silent” → normal SUCCESS end; idle watchdog on a finished run is irrelevant.
- Same-thread second user message → intake queue/cancel; **forbidden** as Q5 / same-run chatter proof.

### Real options / gap
- Shim `arm hang` = fake agent, not model.
- Proxy blackhole on model host **before** first token: may yield eligibility / connect errors (as seen with MODEL_PLACEHOLDER class failures) — that is **faulted ERROR**, not “model hang while run stays ACTIVE”.
- **Gap:** with print-mode one-shot agents, there is no harness-documented way to hold an open run in “model thinking, no tool, no result” for ≥2m without shim fakes or killing the CLI. Record **identity-of-failure gap**; do not mark pass on quiet completed turns.

---

## R4 — Comment task same budgets (Q4)

### Research done (unblock-research)
- Profile `comments: {}` is **by design** (`CommentConfig = Record<string, never>`; `normalizeComments` → `{}`). **Not** a reason to ask the user for docs.
- Notion / Google Drive / OneDrive: no Bot Arena Test Only wiki hit (Feishu wiki lives elsewhere).
- Feishu MCP connector: **installed but needsAuth** (0 tools until reconnect) — not used.
- **lark-cli user** wiki read (authorized): among 11 spaces, **exactly one** name match: **`Bot Arena Test Only`**.
- Top-level nodes (titles only): `首页`; `测试材料（以下仅供 Agent 测试，非生产）` (has_child); `写入实验（可删除）` (has_child); `Skeam Skill Hub（未上线）` (has_child). Prefer a leaf under **测试材料** / **写入实验** only — never other wikis; **do not post comments in this prep**.

### Executable method when desktop is authorized
1. Open **only** Bot Arena Test Only → choose a disposable leaf under 测试材料/写入实验.
2. Comment: `@Test Bot 【端到端测试】R4：…` (mirror a short shared-watchdog probe; full 15m only if R3-class hang is otherwise solved — else prove same watchdog seam via log phases).
3. Observe same idle/tool budgets as chat in bridge logs.
4. **No** comments on any other wiki; **no** inventing comment text into foreign docs.

### Remaining R4 gap
- Feishu MCP still needsAuth for connector-only path; wiki identity is confirmed via lark-cli.
- Full “model-only hang in a comment” inherits **R3 gap**. Prefer tool-grace comment probe once R2 path is proven, or log-only shared-watchdog proof.

---

## Hard bans (reconfirmed)
- No production restart / prod config / `/home/box/src/larkent` edits.
- Test proxy remains **off** until an explicit fault step.
- No mid-run second user message to “prove” Q5.
- No claiming R1/R3 pass from normal completion + silence.
- No ws-freeze as model hang.
