# CI 提速实施计划

## Summary

目标：把典型 PR 的 CI 反馈从当前的约 15 分钟降到 3–5 分钟，同时保留合并前的三平台门禁。

手段按收益排序：

1. 拆分两个串行执行的重型测试文件，消除单文件关键路径。
2. 增加 `concurrency` 取消重复 run，并给 job 设置超时。
3. 拆出只跑一次、且先于测试执行的 `static` job。
4. 平台门禁分层：功能分支只跑 Ubuntu，合并到 `master` / `release/*` 与 nightly 跑 macOS + Windows。
5. 去掉每个 job 内重复的 `build:web`。

本计划不修改任何生产代码，不改变测试断言，不新增 skip。

## Current State Analysis

### CI 配置

[ci.yml](file:///workspace/.github/workflows/ci.yml#L1-L39) 当前行为：

- `push` 与 `pull_request` 都触发，同一 commit 常产生两个 run（已观察到 `39551311443` / `39551327793`、`39606271607` / `39606300522`）。
- 单一 `test` job，matrix 为 `macos-latest`、`ubuntu-latest`、`windows-latest`。
- 步骤顺序：checkout → corepack → setup-node(cache: pnpm) → install → test → typecheck → build。
- 没有 `concurrency`、`timeout-minutes`、sharding；typecheck/build 在 3 个 OS 上各跑一遍，且在数分钟测试之后才执行。

### 实测耗时（run 39551815394，全绿）

| Job | 总耗时 | Test 步骤 | 最大单文件 |
| --- | --- | --- | --- |
| ubuntu | 6m43s | 6m18s | `six-cli-bridge-contract` 238.6s；`reminder-tools` 166.9s |
| macos | 11m58s | 11m05s | `six-cli` 358.9s；`reminder-tools` 208.1s |
| windows | 15m24s | 14m03s | `six-cli` 601.7s；`reminder-tools` 282.2s |

Windows 上 `six-cli` 单文件占整个 job 的约 72%。

### 根因

- [six-cli-bridge-contract.test.ts](file:///workspace/tests/process/six-cli-bridge-contract.test.ts#L53-L195) 是一个 `it.each(PIN_AGENT_KINDS)`，6 个 agent 在同一个文件内串行执行。Vitest 只按文件并行，单文件内的 case 不会并行；每个 case 启动大量真实子进程，6 个叠加即 600s 量级。
- [reminder-tools.test.ts](file:///workspace/tests/integration/bot/reminder-tools.test.ts#L35-L924) 单文件 30 个重型集成测试，同样串行。
- 两个文件都依赖 [bridge-tool-process.ts](file:///workspace/tests/helpers/bridge-tool-process.ts#L8-L28) 的 `buildToolProcess`，每个测试文件在 `beforeAll` 执行一次真实的 tsup 构建。
- [vitest.config.ts](file:///workspace/vitest.config.ts#L7-L23) 未设置 pool / 并发 / 全局 timeout，完全依赖默认值；当前默认值不是瓶颈，瓶颈是单文件串行。
- [package.json](file:///workspace/package.json#L36-L55) 的 `pretest` 会执行 `build:web`；CI 的 `build` 又执行一次 `build:web`；`prepare` 在 install 阶段还会执行一次完整 `build`。单个 job 内 web 构建实际发生 3 次。

### 测试分布

- `tests/unit`：186 个文件
- `tests/integration`：105 个文件
- `tests/process`：14 个文件
- `tests/static`：5 个文件
- 合计 310 个测试文件；Ubuntu 运行 3048 passed + 12 skipped，Windows 运行 3031 passed + 29 skipped。

## Proposed Changes

### 1. 拆分 `six-cli-bridge-contract.test.ts` 为 3 个文件

**目标**：把 6 个 agent 的 6 个 case 分散到 3 个 worker 并行，Windows 单文件耗时从约 600s 降到约 200s。

**新增共享套件**：`tests/process/six-cli-bridge-contract-suite.ts`

- 从原文件移入：
  - `NOW`、`CORRECTED_PREVIEW`、`CONTRACT_ROW_TIMEOUT_MS`（原文件 L25-L31）。
  - `expectResumeArgv`（L43-L49）。
  - `it.each` 的完整测试体（L53-L195），但改为由函数注册。
- 导出 `registerSixCliContract(input)`，参数：
  - `kinds: readonly PinAgentKind[]`
  - `getClient: () => Awaited<ReturnType<typeof buildToolProcess>>`
  - `getStartChannel: () => typeof sourceStartChannel`
  - `sdk: { channel: ReturnType<typeof createRecordingLarkChannel> | undefined }`
  - `cleanup: Array<() => Promise<unknown>>`
- 测试体内部的 `cleanup.push`、`sdk.channel = channel`、`vi.spyOn(Date, 'now')`、`vi.restoreAllMocks()` 保持不变。
- 不要在共享模块顶层保存可变状态；所有可变状态必须由调用方按文件传入。

**新增 3 个测试文件**（每个文件 2 个 agent）：

- `tests/process/six-cli-bridge-contract.claude-codex.test.ts` → `['claude', 'codex']`
- `tests/process/six-cli-bridge-contract.kimi-grok.test.ts` → `['kimi', 'grok']`
- `tests/process/six-cli-bridge-contract.cursor-antigravity.test.ts` → `['cursor', 'antigravity']`

每个文件保留原文件 L1-L41 的骨架：

- `vi.hoisted` 创建 `sdk`。
- `vi.mock('@larksuite/channel', ...)`。
- `beforeAll` 调用 `buildToolProcess({ channel: true })`，并动态 import `dist/channel.js`。
- `afterAll` 调用 `client.cleanup()`。
- `afterEach` 执行 `cleanup.splice(0).reverse()`、重置 `sdk.channel`、`vi.restoreAllMocks()`。
- 最后调用 `registerSixCliContract({ kinds, getClient: () => client, getStartChannel: () => startChannel, sdk, cleanup })`。

**删除**：原 `tests/process/six-cli-bridge-contract.test.ts`。

**结果**：测试文件数 +2，case 数仍为 6；不新增 skip，不改断言。

### 2. 拆分 `reminder-tools.test.ts` 为 4 个文件

**目标**：30 个串行集成测试按主题拆到 4 个 worker，Windows 单文件从约 280s 降到约 90s。

**新增共享设置**：`tests/integration/bot/reminder-tools/harness.ts`

- 移入常量：`NOW`、`FIRES`、`END`、`schedule`、`reminder`（原文件 L20-L24）。
- 导出 `createReminderHarness({ client, cleanup, setChannel })`，内部复用 [automation-tool-harness.ts](file:///workspace/tests/helpers/automation-tool-harness.ts#L18-L34) 的 `createAutomationToolHarness`。
- 保留原 `harness(chatMode, agentTasks, journalMaxEntries)` 的默认参数行为。

**新增 4 个测试文件**，按原文件行区间原样迁移：

- `tests/integration/bot/reminder-tools/creation-and-confirmation.test.ts`：原 L35-L109，3 个测试（创建、预览、缺 end 的确认卡）。
- `tests/integration/bot/reminder-tools/persistence-and-retries.test.ts`：原 L110-L356，8 个测试（语义重试、持久化、草稿恢复）。
- `tests/integration/bot/reminder-tools/confirmation-lifecycle.test.ts`：原 L357-L543，9 个测试（恢复、暂停、恢复、删除、替换确认）。
- `tests/integration/bot/reminder-tools/replacement-and-agent-tasks.test.ts`：原 L544-L924，10 个测试（替换、agent task、dashboard、revision、原子 rename）。

**Mock 规则**：

- 每个文件保留 `vi.hoisted` 的 `sdk` 与 `vi.mock('@larksuite/channel', ...)`。
- 只有 `persistence-and-retries` 与 `replacement-and-agent-tasks` 需要 `fsFault`（原文件 L344、L411、L797 使用），这两个文件保留 `vi.mock('node:fs/promises', ...)`。
- 其余两个文件不要复制 `fsFault` mock，避免无意义的模块替换。

**删除**：原 `tests/integration/bot/reminder-tools.test.ts`。

**结果**：测试文件数 +3，测试数仍为 30；测试标题与断言原样保留。

### 3. 重写 `.github/workflows/ci.yml`

目标结构：

```yaml
name: CI

on:
  push:
  pull_request:
  schedule:
    - cron: '0 18 * * *'

concurrency:
  group: ci-${{ github.workflow }}-${{ github.event.pull_request.head.repo.full_name || github.repository }}-${{ github.event.pull_request.head.ref || github.ref_name }}
  cancel-in-progress: true

jobs:
  static:
    name: Static checks
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build:web
      - run: pnpm typecheck
      - run: pnpm build:ci

  test-ubuntu:
    name: Test on ubuntu-latest
    needs: static
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build:web
      - run: pnpm test:ci

  test-platform:
    name: Test on ${{ matrix.os }}
    needs: static
    if: >
      github.event_name == 'schedule' ||
      (github.event_name == 'pull_request' &&
        (github.base_ref == 'master' || startsWith(github.base_ref, 'release/'))) ||
      (github.event_name == 'push' &&
        (github.ref == 'refs/heads/master' || startsWith(github.ref, 'refs/heads/release/')))
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build:web
      - run: pnpm test:ci
```

说明：

- `concurrency` 用 head repo + head ref 作为 key，让同一分支的 push run 与 PR run 互相取消；nightly 用 `ref_name` 也不会误伤其他分支。
- `static` 只在 Ubuntu 跑一次 typecheck/build，失败会阻止后续测试。
- `test-platform` 的 `if` 实现“功能分支只跑 Ubuntu，合并到 master/release 或 nightly 跑三平台”。如果团队要求所有 PR 都跑三平台，把 `if` 改为 `true` 即可，其余结构不变。
- 三个 job 都保留 pnpm cache；install 仍是 4–9s，不需要额外缓存层。

### 4. `package.json` 增加 CI 专用脚本

在 [package.json](file:///workspace/package.json#L36-L45) 中新增：

```json
"test:ci": "vitest run",
"build:ci": "tsup"
```

- `test:ci` 不触发 `pretest`，避免 CI 中重复 `build:web`；调用前必须已执行 `pnpm build:web`。
- `build:ci` 假定 `build:web` 已完成，只跑 tsup。
- 保留现有 `test`、`build`、`pretest`、`ci:local`，不改变本地开发行为。

### 5. Out of scope

以下项不在本次实施范围内，等拆分后的实测数据再决定：

- macOS / Windows 的 `--shard` 分片。
- docs-only 改动的 `paths-ignore` 与轻量 docs job。
- 更大的 runner、Node 22 matrix、coverage 上传。
- `prepare` 生命周期在 install 阶段的构建优化。

## Assumptions & Decisions

- 默认分支为 `master`，发布分支为 `release/*`；与现有 CI run 的分支命名一致。
- 平台策略采用上一轮讨论的结论：功能分支只跑 Ubuntu；PR 合并到 `master` / `release/*`、push 到这两个分支、nightly 跑 macOS + Windows。
- `six-cli` 拆 3 个文件而不是 6 个：在 4 核 runner 上 3 个 tsup fixture 构建更均衡，避免 6 个构建互相争抢。
- `reminder-tools` 拆 4 个文件，保持每个文件 3–10 个测试、耗时相对均衡。
- 测试只做物理拆分与共享代码提取，不改任何断言、超时或测试标题。
- 不修改生产代码；`pnpm ci:local` 的语义保持不变。
- 拆分后的测试文件数：310 + 2 + 3 = 315；测试总数仍为 3060。

## Verification

### 本地验证

1. `pnpm install --frozen-lockfile`
2. `pnpm build:web && pnpm test:ci`
   - 断言 315 个测试文件、3060 个测试；通过/跳过数量与拆分前一致。
3. `pnpm typecheck && pnpm build`
4. 单独验证拆分文件：
   - `pnpm exec vitest run tests/process/six-cli-bridge-contract.*.test.ts`：6 个 case 全部通过。
   - `pnpm exec vitest run tests/integration/bot/reminder-tools`：30 个测试全部通过。
5. `git diff --check`

### CI 验证

1. 推送一个功能分支，确认：
   - `static` 与 `test-ubuntu` 运行；
   - `test-platform` 不运行；
   - 同一分支的 push / PR run 只有一个处于运行状态，另一个被取消。
2. 向 `master` 或 `release/*` 开 PR，确认 `test-platform` 在 macOS 与 Windows 上运行。
3. 用 `gh run list` 与 `gh api repos/.../actions/runs/<id>/jobs` 对比耗时。

### 验收指标

- `static` job ≤ 1.5 分钟。
- Ubuntu `test-ubuntu` job ≤ 4 分钟（当前 6m43s）。
- Windows `test-platform` job ≤ 8 分钟（当前 15m24s）。
- 所有测试通过，测试总数不减少，不新增 skip。
- 重复的 push/PR run 被自动取消。

## Rollout & Rollback

- 分 3 个提交落地，便于单独回滚：
  1. 拆分 `six-cli` 与 `reminder-tools`。
  2. 新增 `test:ci` / `build:ci` 脚本。
  3. 重写 `ci.yml`。
- 如果拆分后出现 flaky 或资源争抢，先回滚对应测试拆分提交，保留 workflow 的 `concurrency` / `timeout` / `static` 改动。
- 如果平台门禁策略需要调整，只改 `test-platform.if`，不影响测试拆分。
