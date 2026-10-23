# 03: Verify the full unchanged platform matrix

**What to build:** A reviewed candidate improves scheduling on the existing free runner matrix and leaves evidence of correctness, observed timing and rollback.

**Blocked by:** 01 and 02.

**Status:** in-progress

- [x] Persist complete plan and baseline, complete available local verification and separate Standards/Spec reviews.
- [x] Keep existing three-platform seven-shard coverage, no assertion/timeout/product changes.
- [ ] Commit only after local optimization; use at most three hosted verification rounds.
- [ ] Verify exact-head CI, report measured results honestly, leave PR unmerged.
