# 02: Run the allocation in Vitest and record trustworthy observations

**What to build:** CI and local benchmark runs consume the same allocation, retain all tests, and produce bounded timing observations whose completeness can be checked.

**Blocked by:** 01: Plan and compare complete test allocations locally.

**Status:** complete

- [x] Adapter preserves original runner objects and exact planned membership.
- [x] Reporter separates timing components and states, detects missing/duplicate/unexpected outcomes, and never masks failure.
- [x] Local tool can explicitly produce a candidate timing snapshot without automatic tracked writes.
- [x] Weighted mode is optional locally and reversible without changing tests.
