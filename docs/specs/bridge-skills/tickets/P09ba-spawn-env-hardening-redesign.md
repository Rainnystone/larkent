# Task 09ba — P09ba 重新设计子进程环境加固（含按 adapter 的环境契约测试）

**Status:** wontfix（用户 2026-10-21 决定：不重新设计；P09az 已恢复改动前的全量继承，仅额外拒绝 bridge 自身飞书密钥，足够）
**Owner:** Codex
**Follow-up of:** [P09ad](P09ad-grok-env-inherits-bridge-secrets.md)、[P09az](P09az-spawn-env-revert-allowlist.md)
**Blocked by:** #52 合并
**Evidence:** 代码阅读 `7514c1e` 对比 merge-base `953e7bd`；**未 live 验证**（box PATH 上无各 CLI）。

## Root cause

P09ad 的通用 allowlist+拒绝正则误伤各 CLI 的合法配置；P09az 回退后只剩最小拒绝。

## Real-use impact

当前（P09az 后）agent shell 仍能读到 bridge 之外的凭据类变量；但盲目 allowlist 会造成静默认证失败。

## Fix

二选一并写入设计说明：(a) 只拒绝 bridge 自身密钥名；或 (b) allowlist + 前缀（ANTHROPIC_*、CLAUDE_CODE_*、OPENAI_*、CODEX_*、GOOGLE_*、AWS_*、GH_/GITHUB_*、GIT_*）及平台必需变量。

## Acceptance criteria

- [ ] 每个 adapter 有书面环境契约（必需透传 / 必须拒绝）。
- [ ] bridge 自身密钥从不透传。

## Required tests

- 按 adapter 的环境契约测试（6 个 CLI 各一组），含 Windows 变量名。
