# 01: Plan and compare complete test allocations locally

**What to build:** A contributor discovers all tests, obtains deterministic OS-specific allocations, verifies exact coverage and compares old/new scheduling locally using recorded costs.

**Blocked by:** None.

**Status:** complete

- [x] Every discovered specification appears exactly once, independent of input order.
- [x] New/renamed tests and malformed/missing weights remain scheduled with positive estimates.
- [x] Local replay compares both algorithms using explicit worker assumptions, not promised runtime.
- [x] Current 323-file baseline plus edge-case unit tests verifies the contract.
