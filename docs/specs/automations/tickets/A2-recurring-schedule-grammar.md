# A2: Recurring schedules, floors, end required

**What to build:** daily / weekday / weekly times and every-N-min/hour (N≥10) with optional window (incl. cross-midnight); profile IANA timezone + DST rules; recurring requires end ≤ 1 year — missing end gets the deterministic scripted card before any confirm card; expired tasks are deleted. Pure parse/next-fire functions with injected clock.

**Blocked by:** A1

**Status:** ready-for-agent

- [ ] Table tests in a UTC host: weekday skips Sat/Sun; window 22:00–02:00 belongs to the start day; DST gap shifts to next valid minute, DST overlap fires once.
- [ ] Reminder interval < 10 min and agent interval < 1 h rejected.
- [ ] Missing end → scripted card (no agent involved); after the end is supplied the confirm card appears.
- [ ] After the last fire / endAt the task is deleted; no renewal message.
- [ ] Confirm card states weekday ignores 调休 and shows next 3 fires.
