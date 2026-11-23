# 02: Fail closed and never break the profile lifecycle

**What to build:** Whatever the holder does — fails to compile, dies, throws, or meets a changed switch — the profile's own start, reconnect and stop still complete, and the log says what happened.

**Blocked by:** 01: Hold the host awake while an opted-in profile is online.

**Status:** complete

- [x] The holder prints `held` only after the OS took its request; a binding that cannot compile reports `holder-not-started` with the compiler output.
- [x] A test runs the real holder script on Windows PowerShell and is skipped elsewhere.
- [x] A released holder exits with code 0.
- [x] An `acquire` or `release` that throws is logged (`acquire-failed`, `release-failed`) and the profile still starts, stops and restarts.
- [x] A reconnect keeps the request while the switch stays on, releases it when the switch turns off, and acquires it when the switch turns on.
- [x] The holder and the host-sleep probe share one timeout helper instead of a copy each.
