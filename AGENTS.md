# Agent entrypoint

- Setup, first deployment, connecting a new CLI, or adding a profile: read [docs/agent-setup.md](docs/agent-setup.md) first. Complete registration, full user-identity authorization, and real verification in order before reporting a usable state.
- For run and troubleshooting commands, see [README.md](README.md) (Chinese: [README.zh.md](README.zh.md)). The current checkout's `--help` output and `package.json` are authoritative for arguments and scripts.
- Before coding, check the current worktree, branch, and uncommitted changes. Preserve other people's changes. For production fixes, write a meaningful failing regression test first, then implement, then run `pnpm ci:local` in that worktree.
- For docs-only changes, verify paths, links, commands, and stated status. Do not start a real bot or re-request account authorization for them.
