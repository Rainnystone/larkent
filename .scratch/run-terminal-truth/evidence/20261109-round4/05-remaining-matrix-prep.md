# 05 remaining matrix — minimal real E2E (after 01 partial)

**Do not mid-course change product.** Record bugs only; fix batch later.  
Venue: Bot Arena · 「Agent测试专员」· prefix `【端到端测试】` · real `@Test Bot`.  
Proxy/faults: only rt1 test bridge HTTPS_PROXY; host-scoped; never Feishu host; never production.

## Test profile budgets (from `adapter.effective-timing`, not full config)

| Field | Value | Wall meaning |
|-------|-------|--------------|
| `idleTimeoutMode` | configured | normal idle **enabled** |
| `idleTimeoutMs` | **900000** | **15 minutes** awake silence |
| `toolGraceMode` | configured | |
| `toolGraceMs` | **3600000** | **60 minutes** per-tool awake cap (= max(60m, idle)) |
| `printTimeoutMode` | omitted | no CLI hard cap; bridge watchdog owns timing |

**Do not shorten the 15-minute tool-silence requirement** (issue 05 / Spec Q1+Q5).  
Implied minimum calendar for the long-tool case alone: **>15 min** tool sleep (+ setup/teardown). Model-only hang case needs **≥15 min** silence after last progress. Reconnect+2 min silence is shorter but must stay **within** the 15 min idle (kill must *not* happen at 2 min).

Doc-comment (Q4): same budgets as chat. **Test docs only on Bot Arena “Test Only” wiki.**  
**Current gap:** test profile `comments` config is **empty**; no verified Test Only wiki/doc identity in evidence. **If user cannot supply a Bot Arena Test Only wiki doc + comment identity, skip doc-comment item and record “identity unavailable — not run” — do not touch other docs.**

## Item 0 status (recoverable then success) — already exercised

Desktop SEED→PING→PONG on same thread: **content recovered on PONG but false failure card**.  
Captured error = `MODEL_PLACEHOLDER_M418` (**not** proven Bad Gateway). **NOT PASS.** See `01-anomaly-for-agy.md`.

---

## Remaining 4 — minimal messages + safe faults

### R1 — Simulated reconnect + >2 min model silence (within normal idle)
**Goal:** run not killed early at ~2 min; survives until normal idle rules allow.  
**Safe fault (rt1 only):** after a real `@Test Bot` prompt that starts a long model wait, use harness **process freeze** only on test bridge if needed (`e2e:fault ws-freeze` / documented wake path) **or** natural WS blip already logged — prefer **no global network**. Do **not** fault Feishu host. Optional: brief model-host `disconnect` is **wrong** here (that’s ERROR path). Prefer silence without killing model CONNECT if testing “silence after reconnect”.  
**Messages:**  
1. `@Test Bot 【端到端测试】请开始一个需要长时间思考的任务，在完成前不要提前结束；先只回复：R1-START`  
2. After bridge shows run started: trigger **test-bridge-only** reconnect/wake path (operator) then wait **>2 min** without user text.  
**Pass cues:** no early kill at 2 min; run still alive or stops only per normal idle (≥15 min) with correct wording later — record actual stop time.  
**Approx duration:** >2 min observation (+ optional full idle if it hangs).

### R2 — Real tool silent >15 min; model talk does not cut grace (Q1/Q5)
**Goal:** long shell/tool not killed at 15 min idle; later model chatter doesn’t end tool grace early.  
**Safe fault:** none required on proxy. Prompt must force a **real** tool (`sleep 960` or similar ≥16 min).  
**Messages:**  
1. `@Test Bot 【端到端测试】请用 shell 执行：sleep 960 && echo R2-TOOL-DONE。工具运行期间不要提前结束；若你想说话可以简短说明仍在等待，但必须等 sleep 结束再给出最终结果。`  
2. After tool ACTIVE (~1–2 min in): send `@Test Bot 【端到端测试】R2-CHAT：请只回复“仍在等工具”，不要取消工具。`  
**Pass cues:** tool completes after >15 min; final contains `R2-TOOL-DONE`; mid-tool chat does not produce tool-grace kill.  
**Duration:** **≥16 min** wall (+ margins). **Do not shorten.**

### R3 — Model-only silent hang → normal idle stop copy (Q8)
**Goal:** stop at normal idle (~15 min) with “waiting budget used up” wording, timer name, awake minutes; no duplicate failure text.  
**Safe fault:** optional model-host `disconnect`/`blackhole` **only** `daily-cloudcode-pa.googleapis.com` **after** run starts, to induce hang — **or** ask model to wait silently without tools. Prefer prompt-only if reliable; if using proxy, clear with `proxy off` after.  
**Messages:**  
1. `@Test Bot 【端到端测试】R3：不要调用任何工具。回复一句 R3-WAIT 后保持沉默，等待我下一条指令（我可能很久不发）。`  
2. Do not send further user text for **≥15 min**.  
**Pass cues:** stop card/text includes budget-used-up wording + timer name + awake minutes; no duplicate failure blob.  
**Duration:** **≥15 min**.

### R4 — Document-comment same budgets (Q4)
**Goal:** comment task uses same idle/tool budgets as chat.  
**Prerequisite:** Bot Arena **Test Only** wiki/doc + identity. **If missing → skip, record gap, do not use other docs.**  
**Messages (only if identity exists):** on that test doc, comment `@Test Bot 【端到端测试】R4：…` mirroring R3 (model-only hang) **or** a shorter probe that still proves same watchdog path via logs (`idleTimeoutMs`/`toolGrace` path in comment consumer). Prefer one model-only hang ≥15 min for parity with R3.  
**Duration:** ≥15 min if full parity; or log-only proof if a shorter comment run still hits the shared watchdog seam (must cite log phases).

## Suggested calendar (serial, one Bot Arena thread or dedicated topics)
| Order | Item | Min wall |
|-------|------|----------|
| — | (done) 01 sticky/false-fail | done |
| 1 | R1 reconnect+>2m | ~5–20 min |
| 2 | R3 model idle 15m | ≥15 min |
| 3 | R2 tool 16m + mid chat | ≥16 min |
| 4 | R4 if wiki ready | ≥15 min or skip |
| **Total if all run full** | | **≳ 50–70+ min** exclusive of ops gaps |

Restore: `pnpm e2e:fault -- proxy off` then `pnpm e2e:down` when matrix finished.
