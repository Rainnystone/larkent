# Keep-awake: hold the host awake while a profile is online

Status: implemented, awaiting review. No merge authorization. Baseline: `master` at `0933f1f` (PR #74 merged).

## Problem and outcome

The owner runs the bridge on a laptop, a Modern Standby machine. Once the screen locks, Windows enters standby after its hidden "system unattended sleep timeout" (120 s by default), even with "Sleep" set to Never on AC power. Standby suspends desktop processes. The bridge process stays alive but stops answering: its heartbeat stops, nothing is logged, and `ps` still lists the bot as running because it reads the process registry rather than the process table. The owner sees "the bots went offline".

Self-heal already recovers the messages missed while the host slept. It cannot keep the bot reachable.

Outcome: a profile can ask the operating system not to idle-sleep while it is online. On the owner's machine the two production profiles hold that request, and the hidden timeout was set to never on AC power at the same time.

## User stories

1. As a bridge owner on a laptop, I want an opted-in profile to keep the host awake while it is online, so that the bot keeps answering after I lock the screen.
2. As an owner, I want the switch off by default, so that upgrading does not change how anyone else's machine sleeps.
3. As an owner, I want the request gone once the profile stops, so that the host sleeps again when no bot needs it.
4. As an owner, I want a bridge that dies without stopping to release the request anyway, so that a stale process never pins the host awake.
5. As an owner, I want a failed request to leave the bot online, so that a locked-down or unusual host still gets a working bridge.
6. As an owner, I want to turn the switch on or off through a reconnect like other profile settings, so that I do not need a full process restart.
7. As an owner on macOS or Linux, I want the switch to be harmless, so that one configuration file works everywhere.
8. As an operator, I want one log line when the request is held and one when it fails, so that "still sleeping" can be diagnosed from the profile log.
9. As a reviewer, I want a test that runs the real holder script, so that a script that compiles nothing cannot pass as working.
10. As a maintainer, I want the words written down, so that keep-awake, keepalive, wake reconnect and awake are not confused.

## Contract

1. `keepAwake.enabled` is a profile setting, off by default, stored with the profile. Any value other than boolean `true` reads as off.
2. While the switch is on and the profile is online, the profile owns one pending or held keep-awake request. It is released when the profile's own stop completes, after its bridge and its locks, and by a reconnect that finds the switch off. A stop also waits for a release that a reconnect already started.
3. Starting or reconnecting a profile never waits for the request. The bridge comes online first.
4. A failing request is never fatal to the profile. `acquire` and `release` resolve without throwing, and a source that throws anyway is logged and the profile's start, reconnect or stop still completes.
5. The holder reports `held` only after the operating system has taken the request.
6. The request is advisory. It does not stop an explicit sleep, the power or sleep button, a lid-close action, a restart, or a host policy that ignores such requests.
7. A holder that dies while held is not replaced. The next profile start, or an off-then-on switch change, tries again.
8. Platforms other than Windows acquire nothing and log `unsupported-platform`. No error, no process.
9. Nothing changes for a profile that leaves the switch off.

## Evidence and validation

- **Holder logic**, against a fake child through the injectable spawn: the confirmation gate, spawn failure, early exit, acquire timeout, death while held, release through stdin EOF, kill after the release timeout, idempotent release, and the guarded shape of the script.
- **The real script**, on Windows PowerShell, behind `KEEP_AWAKE_REAL_SMOKE=1` like the real CLI smoke tests: it holds and exits with code 0 once released, and a binding that cannot compile reports `holder-not-started` with the compiler output instead of `held`. It is opt-in because on a hosted Windows runner it never reached `held` within 60 s and slowed every test sharing that runner. See "Known limits" in the plan.
- **Lifecycle**, through the injectable `KeepAwake` and the supervisor's public entry points: off by default, hold and release across stop and shutdown, no delay to `profile-online`, a stop that waits for a pending request and for a release a reconnect already started, a rolled-back start that never asks, a reconnect that keeps, releases or acquires, and a throwing source that leaves the lifecycle intact.
- **Automated reviews on the pull request** (Codex, Cursor Bugbot, Devin) found two more failures after the first review round. Each is pinned by a test now: the stop that did not wait for a reconnect's release, and a stdin write to a holder that had just died.
- **The setting**: default, explicit opt-in and a save-and-load round trip.
- **The words**: a docs contract test keeps the operations guide and `CONTEXT.md` from silently dropping them.
- **The real host**: on the owner's Windows 11 Modern Standby laptop, each production profile logged `keep-awake` `held` about one second after `profile-online`. Stopping the bridge with `kill`, a hard termination on Windows, left no holder process after 5 s; starting it again bound a new holder to the new bridge process.
- **Hosted Windows**: shards 1 and 3 passed. Shard 2 failed. The real-script test never reached `held` there, and five unrelated tests timed out while sharing that runner with it. Every test that ran beside it took 5 to 58 times its usual time; the ones before it were normal.
- **Not verified**: that the request on its own prevents standby after lock on a Modern Standby host. The hidden timeout was changed at the same time, so a lock-screen test cannot attribute the result to either measure alone.
- **Not verified on other systems**: hosted CI ran out of Actions quota after the Ubuntu shards passed and before the macOS shards finished. The review fixes that came later ran only on Windows.
- **Local `pnpm ci:local` cannot pass on the owner's machine**: two symlink cases in the plugin catalog suite fail with `EPERM` there, for reasons unrelated to this change. Typecheck, build and the full suite were run separately. Hosted CI on all three systems is the authority.

## Out of scope

- Holders for macOS (`caffeinate`) and Linux (`systemd-inhibit`). `createKeepAwake` is the only place that would change.
- Changing the host's power plan. That is an operator decision, made outside Larkent.
- Keeping the display on, and away mode.
- Noticing AC power and releasing on battery.
- Replacing a holder that died.
- Diagnosing sleep from inside the bridge. The host-sleep probe already classifies an outage as `hostSuspended`.

## Methodology

The code was built test-first. The spec, plan and tickets were written afterwards, at the owner's request, so that the next person finds the reasoning and not only the code. This follows the repo's single integration workstream (as `ci-duration-scheduling`): spec, plan and tickets land with the code instead of on a separate docs branch. Ask Matt's `to-spec`, `to-tickets`, `code-review` and `pr` guidance shaped the documents and the PR. Standards and Spec were reviewed on separate agents; their findings became tickets 02 and 03.

## Resolved implementation details

- **Per profile, not per process.** The request belongs to the profile, so a reconnect can re-read the switch, and a supervisor hosting several profiles holds one request for each that opted in.
- **One holder process per opted-in profile.** Simpler ownership and cleanup than one shared process. About 79 MB per online profile on the owner's machine.
- **Windows PowerShell with an inline command and `Add-Type`, not a native Node addon.** No new dependency and no compiler toolchain at install time. Execution policy governs script files, not an inline command. Rejected alternatives:
  - `-EncodedCommand`: a common malware signal, likely to trip endpoint tooling.
  - A `.ps1` file: blocked wherever execution policy is restricted.
  - An FFI addon: a native dependency for every user of the package.
- **The holder owns the request on its own thread and parks on stdin.** EOF is the release signal, which is why a bridge that dies still ends it. `ES_SYSTEM_REQUIRED` only: the display may turn off.
- **Binding, request and confirmation sit in one guarded block.** PowerShell runs on past a failed statement inside a `-Command` string, so an unguarded script reported `held` after a failed compile. The Spec review found this; the real-script test now pins it.
- **The real-script test injects the C# binding** (`typeDefinition`), so a failing compile can be produced on purpose. That option exists for this test only.
- **The .NET calls in the script are assigned, not piped.** Piping one marks the statement as failed, which made a clean release exit with code 1.
- **Release comes last in the profile's stop, like the locks.** A stop that fails earlier keeps the request for the retry. Nothing in the stop depends on the holder's cooperation.
- **A stop waits for a release a reconnect already started.** The first version dropped the request from the profile's books as soon as a release began, so a stop issued during that release could finish first and leave a holder still starting. The Codex and Devin reviews found it.
- **Stream errors from the holder are absorbed.** A holder that dies an instant before release fails the next stdin write. That arrives as an `error` on the stream, which throws when nobody listens. The Cursor review found it.
- **The real-script test is opt-in**, behind the repo's `*_REAL_SMOKE=1` switch. It passed on the owner's machine and degraded a hosted Windows runner for a minute. Any failure prints the warn payload it collected.
- **A reconnect re-evaluates the switch**, because a reconnect already re-reads and applies the rest of the profile.
- **`withTimeout` moved out of the host-sleep probe** into a shared helper, so the probe and the holder do not each keep a copy. The Standards review flagged the duplication.
- **Default off, Windows only.** This is a new dependency on the host's power behaviour; nobody should inherit it by upgrading.
