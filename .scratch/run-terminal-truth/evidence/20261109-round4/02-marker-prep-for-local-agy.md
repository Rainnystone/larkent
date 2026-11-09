# 02 marker prep — private evidence for local agy (read-only)

Asia/Shanghai. No product code written. No agy started this turn. No network/proxy egress/account change. No further model tests.

## Preflight
| Item | Value |
| --- | --- |
| free -m (10:10:51) | Mem 16002 / used 5598 / available 10403 |
| uptime | 8:32 load 0.28 0.45 0.52 |
| Bridge (was) cwd | `/workspace/rt-fix` |
| Bridge argv | `…/rt-fix/bin/lark-channel-bridge.mjs run -c …/rt1/config.json --profile test-bot` |
| Bridge HEAD (detached) | `aabcefe68e148a153f89f57660009bb62ec65b28` (= origin/fix/run-terminal-truth tip) |
| origin/fix/run-terminal-truth | `aabcefe6` 2026-11-08 18:47:11 +0000 fix(09): restore ticket-03 partial overlay on stop |
| origin/docs/run-terminal-truth | `98651dea` (docs track; separate worktree `/workspace/rt-docs`) |

## Worktree created
| Field | Value |
| --- | --- |
| Path | `/workspace/rt-agy-fix` |
| Branch | `work/agy-turn-attribution` (tracks `origin/fix/run-terminal-truth`) |
| HEAD | `aabcefe68e148a153f89f57660009bb62ec65b28` |
| Action | **created** (path was absent; not overwritten) |
| Sibling worktrees | `/workspace/rt-fix` (detached aabcefe6, e2e harness — not modified beyond down), `/workspace/rt-docs` (docs/run-terminal-truth) |
| Prod `/home/box/src/larkent` | untouched (still dirty metadata.ts only) |

## Skill absolute paths (read-only; not installed/changed)
| Skill | Path |
| --- | --- |
| matt-dual-track | `/home/box/agent-data/workflows/matt-dual-track/SKILL.md` |
| implement | `/home/box/.cursor/plugins/local/mattpocock-skills/skills/implement/SKILL.md` |
| tdd | `/home/box/.cursor/plugins/local/mattpocock-skills/skills/tdd/SKILL.md` |
| code-review | `/home/box/.cursor/plugins/local/mattpocock-skills/skills/code-review/SKILL.md` |
| ask-matt (router) | `/home/box/.cursor/plugins/local/mattpocock-skills/skills/ask-matt/SKILL.md` |

## Independent cwd new session — official agy syntax
Sources: local `agy --help`; `/workspace/rt-e2e-evidence-20261109/round4/agy-session-isolation-official.md` (Antigravity CLI headless/resume docs).

```bash
cd /workspace/rt-agy-fix
# New conversation: do NOT pass -c / --continue / --conversation
agy -i '…'                    # interactive initial prompt, new session for this cwd
# or headless new each process:
agy -p --output-format stream-json '…'
```

Rules: never `-c` / `--continue`; never `--conversation <old-id>` (especially never `6b9dd5db-…`). Session stickiness of `-c` is keyed by **absolute workspace cwd**.

## Bridge shutdown (rt1 only)
| Step | Result |
| --- | --- |
| Active run check | last run `f11893f7…` failed 10:07:31; flush end; journal notice-delivered; no agy child |
| `pnpm e2e:fault -- proxy off` | exit 0; mode off |
| `pnpm e2e:down` | exit 0; `test-bridge down` |
| rt1 pids 406279/406266 | **gone** |
| Prod 343151 / 343228 / 343328 | **still running** (untouched) |
| sleep960 / R2 orphans | **none** |

## R2 fact table (for 02 marker diagnosis — not a fix claim)
| Fact | Evidence |
| --- | --- |
| Same cid as 09:37 SEED | resumeHandle / conversationId `6b9dd5db-bd08-4f29-adb6-a0380b7f563f`; num_turns=4 |
| Failure class | **location precondition**, not MODEL_PLACEHOLDER sticky |
| Raw error | `FAILED_PRECONDITION (code 400): User location is not supported for the API use.` |
| AGY_ERROR blob | `short_error` same text; `status=INVALID_ARGUMENT`; `error_code=400`; `retryable=false`; `error_id=a91dfcea-dbea-418e-83d9-584af6e5ef18-10` |
| Tool events | **none** (no run_command / command_status ACTIVE) |
| UI new topic | Feishu new root topic still mapped to same group scope → bridge reused sticky resumeHandle |

### Candidate note (unvalidated)
`AGY_ERROR.error_id` appeared on this turn’s stderr and is a **candidate** field for an `error_message` / attribution event in ticket 02 work — **not** validated as a reliable marker yet. Do not treat it as an accepted criterion without a controlled diagnostic. Regional API limit stops further live model tests this round; no egress/account bypass.

Detail: `r2-observe/R2-CORRELATED-DESKTOP.md`, capture `stdout-agy-f11893f7-….jsonl`.
