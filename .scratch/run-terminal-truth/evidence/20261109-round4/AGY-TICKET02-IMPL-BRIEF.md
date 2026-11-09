# agy brief: implement ticket 02 (one ticket, this session only)

Worktree: /workspace/rt-agy-fix, branch work/agy-turn-attribution, base aabcefe6 (= origin fix/run-terminal-truth). Work only here.

Ticket (authoritative, read it first): /workspace/rt-docs/.scratch/run-terminal-truth/issues/02-turn-attribution.md
Spec D2 (amended): /workspace/rt-docs/docs/specs/run-terminal-truth.md
Diagnosis behind it: /workspace/rt-e2e-evidence-20261109/round4/AGY-TICKET02-FINDING.md

Process (Matt skills — read and follow them):
1. /home/box/.cursor/plugins/local/mattpocock-skills/skills/implement/SKILL.md
2. /home/box/.cursor/plugins/local/mattpocock-skills/skills/tdd/SKILL.md — failing test first for each acceptance item, then code.
3. /home/box/.cursor/plugins/local/mattpocock-skills/skills/code-review/SKILL.md — review your own diff at the end and fix real findings.

Rules:
- Product code and tests only. Do NOT copy .scratch, specs or this brief into the repo.
- Tests: run targeted vitest files with `pnpm exec vitest run <files> --maxWorkers 2 --minWorkers 1`. Do NOT run the full suite (I run the gate). Check `free -m` first; the box is shared.
- No live probes, no bridge start/stop, no network/auth/model changes, never touch ~/.lark-channel production.
- Commit in this worktree as: git -c user.name=Rainnystone -c user.email=Rainnystone@users.noreply.github.com commit, message prefixed `fix(02):`. Do NOT push.
- When done write /workspace/rt-e2e-evidence-20261109/round4/AGY-TICKET02-IMPL-REPORT.md: commits, files changed, which test covers each acceptance item, targeted test output, code-review findings and what you fixed.
