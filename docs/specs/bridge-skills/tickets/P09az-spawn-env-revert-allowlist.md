# Task 09az — P09az #52 回退 spawn 环境 allowlist，只保留 bridge 自身密钥拒绝

**Status:** todo · bug · P1（#52）
**Owner:** Codex
**Follow-up of:** [P09ad](P09ad-grok-env-inherits-bridge-secrets.md)（修复提交 `f5e14c1`、`4aca859`）
**Blocked by:** P09aq（同文件；待 P09aq 绿后一批交接）
**Evidence:** 代码阅读 `7514c1e` 对比 merge-base `953e7bd`；**未 live 验证**（box PATH 上无各 CLI）。

## Root cause

`src/platform/spawn.ts` `agentSpawnEnv` 的 PASSTHROUGH allowlist 加拒绝正则 `/key|token|secret|password|auth|webhook/i` 作用于全部 6 个 adapter；#52 之前各 adapter 拿到完整 bridge 环境。

## Real-use impact

静默剥离必需变量，表现为无提示的认证/连接失败：ANTHROPIC_BASE_URL、ANTHROPIC_MODEL、CLAUDE_CODE_USE_BEDROCK/_USE_VERTEX、ANTHROPIC_VERTEX_PROJECT_ID、CLOUD_ML_REGION、GOOGLE_APPLICATION_CREDENTIALS、AZURE_OPENAI_API_KEY、MOONSHOT/KIMI_BASE_URL、GITHUB_TOKEN/GH_TOKEN、GIT_SSH_COMMAND、MCP `${VAR}` 密钥、Windows ProgramFiles(x86)/COMPUTERNAME/PROCESSOR_ARCHITECTURE、NVM_DIR、NPM_CONFIG_PREFIX、COREPACK_HOME、DISPLAY。

## Fix

从 #52 回退 allowlist 与通用拒绝正则，恢复先前环境行为；**保留** APP_SECRET 不传入子进程的保证及其断言（最小拒绝 bridge 自身密钥名，如 APP_SECRET 与 bridge webhook 密钥）。完整加固另见 [P09ba](P09ba-spawn-env-hardening-redesign.md)。

## Acceptance criteria

- [ ] 上述变量对 6 个 adapter 均原样透传。
- [ ] APP_SECRET 与 bridge webhook 密钥仍不传入子进程，原断言保留。

## Required tests

- 每个 CLI（claude、codex、kimi、cursor、antigravity、grok）各一条：示例变量（如 ANTHROPIC_BASE_URL、GH_TOKEN、NVM_DIR）透传；APP_SECRET 不透传。
