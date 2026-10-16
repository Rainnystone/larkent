# A11: E2E in Bot Arena (controller-owned)

**What to build:** run the isolated test bridge in Bot Arena with a fake clock or test-only floor override (never a production “1 分钟后” input): create → scripted end card → confirm → fire → reminder; agent fire → result post → thread follow-up; board pin, re-pin after manual unpin, Pause/Delete taps by a second member; hook read by the read-only monitor app; bot removed. Owned by the controller, not a cloud agent.

**Blocked by:** A1–A10

**Status:** ready-for-human

- [ ] Each scenario has redacted evidence (no IDs).
- [ ] Button callbacks verified with a real tap.
- [ ] Test messages unpinned and recalled afterwards.
