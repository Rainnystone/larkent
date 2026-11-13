# 01: Recreate the managed default workspace if the configured path is missing

**Blocked by:** None · **Status:** recorded, not implementing yet (room, 2026-11-13). · **Scope:** follow-up to the 2026-11-13 Devin `path-inaccessible` miss.

## Decision (room, 2026-11-13, Asia/Shanghai)

If the path is the bridge's own managed default (`appPaths.defaultWorkspaceDir` / the profile's `workspaces.default` written by the bridge), and that directory is missing, create it (`mkdir` recursive, mode `0o700`) and continue the run. Do not auto-create an arbitrary user-specified path.

## Why

`ensureProfileDefaultWorkspace` (`src/runtime/profile-runtime.ts:375-383`) only mkdirs when `workspaces.default` is empty (new profile / first fill). Once the path is in config, start assumes the directory exists. IM `resolveWorkingDirectory` (`src/policy/workspace.ts:36-38`) then `realpath`s and rejects a missing path as `path-inaccessible`. Cloud-doc comments already mkdir a managed fallback (`src/bot/comments.ts`); the group/IM start path does not.

## Instance

2026-11-13 15:47 (Asia/Shanghai), profile `devin`: someone asked Opus in the original group to fix a PDF. The configured cwd `/home/box/.lark-channel-workspaces/devin/default` was gone after the 2026-11-11 home rebuild (cursor / grok / cursor-claude defaults came back; devin did not). The Devin CLI itself was still present (`3000.12.43`). The run was rejected before spawn. The directory was created by hand at 15:54; no bridge restart needed.

## Acceptance

- [ ] A run whose cwd is the managed default, and whose directory is missing, creates that directory and proceeds. No `path-inaccessible` for this case.
- [ ] A missing user-specified / named workspace path is still rejected. No mkdir on those paths.
- [ ] Start-up and IM start share this behaviour; comment fallback stays as it is unless it already covers the same default.
- [ ] Local gate green; no production change until the user opens the implementation track.
