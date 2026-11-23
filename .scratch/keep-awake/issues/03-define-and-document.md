# 03: Define the words and document the switch

**What to build:** A reader who was not there can find what keep-awake is, when the switch takes effect, what it cannot do, and why it was built this way.

**Blocked by:** 01: Hold the host awake while an opted-in profile is online. 02: Fail closed and never break the profile lifecycle.

**Status:** complete

- [x] `CONTEXT.md` defines keep-awake and holder, and separates them from keepalive and from awake time accounting.
- [x] The operations guide states the switch, its default, when it takes effect, and that it is advisory and no substitute for self-heal.
- [x] The setup guide points a deployer whose host idle-sleeps at the switch.
- [x] The operations guide lists the opt-in real-script smoke test and says why it is opt-in.
- [x] A docs contract test keeps the guide and the glossary from silently dropping them.
- [x] The spec and plan record the decisions, the rejected alternatives, what was verified and what was not.
- [x] `AGENTS.md` states the commit and PR language convention, which a shallow clone does not show.
