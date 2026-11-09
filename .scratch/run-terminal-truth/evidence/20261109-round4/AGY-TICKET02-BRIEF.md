# Ticket 02 — evidence gate, local agy fresh session

User explicitly requested a real Computer Use launch of local agy for the agy-specific fix. Work only from /workspace/rt-agy-fix, local branch work/agy-turn-attribution, base aabcefe68e148a153f89f57660009bb62ec65b28. Existing account/login; genuinely new conversation. Do not resume any other conversation. Do not change global model, login, API, proxy or network configuration.

Docs track: https://github.com/Rainnystone/larkent/pull/71 — docs/run-terminal-truth, local read-only /workspace/rt-docs/.scratch/run-terminal-truth/ . Read spec and issues/02-turn-attribution.md plus delivery-notes/01.md and delivery-notes/05.md. Code track: https://github.com/Rainnystone/larkent/pull/70 — fix/run-terminal-truth. Never create a PR, merge, force-push, or copy docs scaffolding onto the code track.

THIS PHASE IS DIAGNOSIS ONLY. Ticket 02 is blocked until a reliable current-turn discriminator is demonstrated. Do not edit product files, commit, push, post comments or start an implementation session now. The intended later sequence is one ticket / fresh session, /implement with /tdd, then in-session /code-review; it is not authorized by inference from this diagnostic prompt.

Read safe evidence:
- /workspace/rt-e2e-evidence-20261109/round4/02-marker-prep-for-local-agy.md
- /workspace/rt-e2e-evidence-20261109/round4/01-anomaly-for-agy.md
- /workspace/rt-e2e-evidence-20261109/round4/01-cli-summary.txt
- /workspace/rt-e2e-evidence-20261109/round4/r2-observe/R2-CORRELATED-DESKTOP.md

Facts: real agy 1.5.3 SEED succeeds; PING errors with model-placeholder failure; resumed PONG gives expected text and exit 0 yet result.status/error/finished_reason stay ERROR with byte-identical old error. Feishu therefore appends false failure and continuation card. A separate raw CLI model-stream Bad Gateway also stayed sticky on successful resume. Bridge runId identifies which invocation captured stdout, NOT which user turn originally generated the error. Increasing num_turns identifies position, NOT error ownership. Nonempty text and exit 0 alone are not a safe success rule. New Feishu topic does NOT mean new CLI session (group-scoped mapping).

R2 failed before any tool with location-not-supported upstream 400, with a structured AGY_ERROR error_id in a new error_message event. This is a candidate marker to investigate, not an established universal discriminator. No long-tool acceptance pass exists. Never change egress/account or retry with another region to get around the location restriction. If this normal interactive session itself hits that restriction, stop and report its exact redacted error.

Goal: independently inspect the existing adapter and safe raw event evidence; decide whether emitted user_input/error_message/step ordering or structured error ids establish CURRENT user-turn error attribution across both genuine-current-error and historical-error-success cases. Look for falsifying cases. Do not conflate process capture with turn attribution. If no robust discriminator exists, say so; no heuristic product patch. No new live model calls, fault injection or production operations from this diagnostic task.

Write your findings, exact evidence references, uncertainty and recommended minimal next gate to /workspace/rt-e2e-evidence-20261109/round4/AGY-TICKET02-FINDING.md (outside the code worktree). Report completion on screen. Keep credentials, prompts/reply bodies and unrelated histories private; do not inspect credentials. Do not run full test suites or install tools. Only current code reads and sanitized captures necessary for this ticket.

Matt skill entry points for later reference, read-only:
/home/box/.cursor/plugins/local/mattpocock-skills/skills/implement/SKILL.md
/home/box/.cursor/plugins/local/mattpocock-skills/skills/tdd/SKILL.md
/home/box/.cursor/plugins/local/mattpocock-skills/skills/code-review/SKILL.md
