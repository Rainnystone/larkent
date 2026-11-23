# 01: Hold the host awake while an opted-in profile is online

**What to build:** A profile that turns on keep-awake keeps the host from idle-sleeping while it is online on Windows, without delaying its own start, and lets the host sleep again once it stops.

**Blocked by:** None.

**Status:** complete

- [x] `keepAwake.enabled` is off unless it is boolean `true`, and it survives a save and a load.
- [x] An opted-in profile acquires one request when it comes online and releases it when it stops or the process shuts down.
- [x] `profile-online` is logged without waiting for the holder; a stop issued while the holder is still starting waits for it and releases it.
- [x] A profile whose startup rolls back never asks.
- [x] A profile that leaves the switch off acquires nothing.
- [x] A host other than Windows acquires nothing and logs `unsupported-platform`.
- [x] Run on the real host with the two production profiles: held after start, no holder left after a hard kill.
