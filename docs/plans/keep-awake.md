# Implement keep-awake

Baseline: `0933f1f2bf1227cf581e10e3bf3c44dd42c90d28` (`master` after PR #74). Contract: [spec](../specs/keep-awake.md). This is a single integration workstream, not dual track: the spec, this plan and the tickets land with the code. No external tracker or new session is required.

The code was written first, test-first. The spec, this plan and the tickets were written afterwards and describe what shipped, including the review-driven fixes.

## Local ticket graph

1. [Hold the host awake while an opted-in profile is online](../../.scratch/keep-awake/issues/01-hold-while-online.md).
2. [Fail closed and never break the profile lifecycle](../../.scratch/keep-awake/issues/02-fail-closed-and-keep-lifecycle.md), blocked by 1.
3. [Define the words and document the switch](../../.scratch/keep-awake/issues/03-define-and-document.md), blocked by 1 and 2.

## Seams

Each behaviour is tested at the widest seam that can observe it, and no wider.

- **Holder behaviour**: `createKeepAwake` takes the spawn function, the platform, the warn sink and the C# binding. A fake child covers every path without a real process.
- **The script itself**: one integration test spawns the real Windows PowerShell. It is the only seam that can tell whether the script still compiles and still asks for the right thing.
- **Lifecycle**: `SupervisorOptions.keepAwake`, driven through `startProfile`, `restartProfile`, `stopProfile` and `shutdown`.
- **The setting**: `normalizeProfileConfig` and a save-and-load round trip.

## Concrete changes

- `src/platform/keep-awake.ts`: `createKeepAwake` with the `acquire` / `release` contract, the Windows PowerShell holder, and no-ops elsewhere.
- `src/platform/timeout.ts`: `withTimeout`, moved out of the host-sleep probe and shared with the holder.
- `src/platform/host-sleep.ts`: uses the shared helper. No behaviour change.
- `src/runtime/supervisor.ts`: the profile owns its request. Start and reconnect match it to the switch; stop releases it last. `SupervisorOptions.keepAwake` is the test seam.
- `src/config/profile-schema.ts`, `src/config/profile-store.ts`: `keepAwake.enabled`, off by default, normalized and persisted.
- Tests: `tests/unit/platform/keep-awake.test.ts`, `tests/integration/platform/keep-awake-holder.test.ts` (real script, Windows only), `tests/integration/runtime/supervisor-keep-awake.test.ts`, `tests/unit/config/keep-awake-settings.test.ts`, and one case in `tests/unit/docs/readme-contract.test.ts`.
- Docs: `CONTEXT.md` (keep-awake, holder), `docs/operations.md`, `docs/agent-setup.md`, `AGENTS.md` (commit and PR language).

## Execution checklist

- [x] Find the real cause before touching code: read the kernel power events, not only the bridge log.
- [x] Write the failing tests for the holder, the setting and the supervisor wiring, then implement.
- [x] Run it on the real host with the two production profiles: hold, release, and no holder left after a hard kill.
- [x] Run Standards and Spec reviews on separate agents. Fix what they found.
- [x] Add a test that runs the real holder script, so a script that cannot compile its binding cannot pass.
- [x] Register the words in `CONTEXT.md`; state when the switch takes effect.
- [x] Run typecheck, build and the test suite locally, and record what this host cannot run.
- [ ] The complete CI matrix on the PR head is the authority. Its result belongs in the PR, not in this file.

## Acceptance and rollback

Correctness first. A profile that leaves the switch off behaves exactly as before. A profile that turns it on comes online whether or not the holder starts, and stops cleanly whether or not releasing works. The holder never reports `held` unless the operating system took the request.

Rollback is two-way. Set `keepAwake.enabled` to `false`, or revert the commits. An older build ignores the key and drops it the next time it saves the profile, which is harmless because the default is off.

## Local verification on the owner's host

- Typecheck and build pass.
- The focused suites pass: holder logic against a fake child, the real script on Windows PowerShell, the supervisor lifecycle, the setting, and the docs contract.
- The full suite on that host: 4111 passed, 2 failed, 38 skipped. The 2 are the symlink cases below.
- `pnpm ci:local` cannot pass there: two symlink cases in the plugin catalog suite fail with `EPERM` because the host cannot create symlinks. They do not touch this change. They were not skipped or worked around; a host that can create symlinks still needs them red when they break.
- A full-suite run rewrites the line endings of two snapshot files without changing their content. Restore them with `git checkout` before committing.

## Known limits and next steps

- **Not verified on a locked screen.** Whether the request alone stops a Modern Standby host from entering standby is unknown, because the hidden unattended-sleep timeout was also set to never. To settle it, restore that timeout (`powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP UNATTENDSLEEP 120`), lock for five minutes with a profile opted in, then read `Microsoft-Windows-Kernel-Power` events 506 and 566 in the System log. No 506 means the request held.
- **A holder that dies is not replaced.** Logging it was judged safer than silently retrying. A retry belongs in the profile, not in the holder, if it is wanted.
- **Battery is not considered.** The request is held on AC and on battery alike.
- **macOS and Linux have no holder.** `createKeepAwake` is the only place a `caffeinate` or `systemd-inhibit` holder would be added.

## Retrospective

What would have caught each miss before review, as a change to the environment rather than to this code:

- **A fake-only suite let a broken script pass.** The holder printed `held` after a failed compile and exited 1 on a clean release, and no test noticed. The real-script test now makes that a deterministic check.
- **The commit language was written nowhere a clone shows.** The first commit was in Chinese; the repo's history is in English. `AGENTS.md` now says so.
- **"Bots offline" was first blamed on the bridge's own reconnect logic.** One query of the kernel power log settled it. A pointer from the troubleshooting docs or `/doctor` to the host's power events would spare the next person that detour. Not changed here.
- **Two symlink cases cannot pass on a Windows host without symlink privilege.** `pnpm ci:local` therefore fails there for reasons unrelated to any change. An explicit "expected to fail without symlink privilege" note in that suite would make the failure self-explanatory. Left to the owner of that suite.
