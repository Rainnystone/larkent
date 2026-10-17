# A11: E2E in Bot Arena (controller-owned)

Spec: [../../automations.md](../../automations.md) Testing Decisions

**What to build:** run the isolated test bridge in Bot Arena with a fake clock or test-only floor override (never a production “1 分钟后” input): create → scripted end card → confirm → fire → reminder; stop the bridge across an instant, restart → one catch-up with "原定 HH:mm"; local wake for the same fire key → silent; agent fire → result post → thread follow-up; board pin, re-pin after manual unpin, Pause/Delete taps by a second member; status block read by the read-only monitor app (id/paused/updatedAt present); bot removed. Owned by the controller, not a cloud agent.

**Blocked by:** A0a–A10

**Depends on #47:** hard (via A1', A8).

**Status:** ready-for-human

- [ ] Each scenario has redacted evidence (no IDs, no secrets).
- [ ] Button callbacks verified with a real tap.
- [ ] Test messages unpinned and recalled afterwards.
