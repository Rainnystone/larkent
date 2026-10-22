import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { createRuntimeAgent } from '../../src/runtime/agent-runtime';
import { jsonlScript, PIN_AGENT_KINDS } from '../helpers/scripted-jsonl-cli';
import { createTmpProfile, type TmpProfile } from '../helpers/tmp-profile';
import { DEVIN_ACP_FIXTURE_SOURCE } from '../helpers/devin-acp-cli';

// Synthetic configuration for a user's existing CLI, git and MCP integrations.
const compatibilityEnv = {
  ANTHROPIC_BASE_URL: 'https://anthropic.synthetic.invalid/v1',
  ANTHROPIC_MODEL: 'synthetic-model',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  ANTHROPIC_VERTEX_PROJECT_ID: 'synthetic-project',
  CLOUD_ML_REGION: 'synthetic-region',
  GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/google-credentials.json',
  AZURE_OPENAI_API_KEY: 'synthetic-azure-key',
  MOONSHOT_BASE_URL: 'https://moonshot.synthetic.invalid/v1',
  KIMI_BASE_URL: 'https://kimi.synthetic.invalid/v1',
  GITHUB_TOKEN: 'synthetic-github-token',
  GH_TOKEN: 'synthetic-gh-token',
  GIT_SSH_COMMAND: 'ssh -i /synthetic/git-key',
  MCP_API_KEY: 'synthetic-mcp-key',
  MCP_AUTH_TOKEN: 'synthetic-mcp-token',
  MCP_PASSWORD: 'synthetic-mcp-password',
  MCP_WEBHOOK_SECRET: 'synthetic-mcp-webhook',
  'ProgramFiles(x86)': 'C:\\Synthetic Program Files (x86)',
  COMPUTERNAME: 'SYNTHETIC-PC',
  PROCESSOR_ARCHITECTURE: 'SYNTHETIC-ARCH',
  NVM_DIR: '/synthetic/nvm',
  NPM_CONFIG_PREFIX: '/synthetic/npm',
  COREPACK_HOME: '/synthetic/corepack',
  DISPLAY: ':99',
  AUDIT_SENTINEL: 'synthetic-custom-value',
};
const bridgeSecrets = {
  APP_SECRET: 'synthetic-app-secret',
  WAKE_WEBHOOK_KEY: 'synthetic-wake-key',
  WAKE_WEBHOOK_URL: 'https://wake.synthetic.invalid/private',
  SAND_BOX_AUTH_ID: 'synthetic-platform-auth',
  CLOUD_AGENT_INJECTED_SECRET_NAMES: 'synthetic-platform-secret-names',
};
const toolEnv = {
  LARK_BRIDGE_TOOL_ENDPOINT: 'http://127.0.0.1:9/tool',
  LARK_BRIDGE_TOOL_TOKEN: 'synthetic-run-token',
  LARK_BRIDGE_TOOL_CLIENT: '/synthetic/client.mjs',
};
const cleanup: TmpProfile[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map(tmp => tmp.cleanup()));
});

// Exercise real adapters/runners/children. Only the external model CLI is controlled.
it.each(PIN_AGENT_KINDS)('%s inherits existing integration settings without bridge secrets', async kind => {
  const tmp = await createTmpProfile(`spawn env & ${kind}-`);
  cleanup.push(tmp);
  for (const [key, value] of Object.entries({ ...compatibilityEnv, ...bridgeSecrets })) vi.stubEnv(key, value);
  vi.stubEnv('LARK_BRIDGE_TOOL_TOKEN', 'synthetic-stale-run-token');
  const binary = join(tmp.root, 'environment cli.mjs');
  const keys = [...Object.keys(compatibilityEnv), ...Object.keys(bridgeSecrets), ...Object.keys(toolEnv), 'LARK_CHANNEL'];
  await writeFile(binary, `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('0.0.0-synthetic'); process.exit(0); }
if (argv.includes('--help')) { console.log('Usage: agent --output-format stream-json --approve-mcps'); process.exit(0); }
if (${JSON.stringify(kind)} === 'claude' || ${JSON.stringify(kind)} === 'codex') for await (const chunk of process.stdin) {}
const answer = JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]])));
${DEVIN_ACP_FIXTURE_SOURCE}
if (${JSON.stringify(kind)} === 'devin') { await serveDevinAcp({lines:[answer]}); await new Promise(() => {}); }
for (const line of ${JSON.stringify(jsonlScript(kind, 'success').lines)}) {
  if (typeof line === 'string') { console.log(line === 'PINNED_ANSWER' ? answer : line); continue; }
  console.log(JSON.stringify(line, (key, value) => key === 'cwd' ? undefined : value === 'PINNED_ANSWER' ? answer : value));
}
`);
  await chmod(binary, 0o755);
  const cfg = createDefaultProfileConfig({
    agentKind: kind, binaryPath: binary,
    accounts: { app: { id: 'cli_synthetic', secret: 'synthetic', tenant: 'feishu' } },
    ...(kind === 'codex' ? { codex: { binaryPath: binary, codexHome: tmp.profile, inheritCodexHome: false } } : {}),
  });
  const agent = createRuntimeAgent(cfg, { profileDir: tmp.profile });
  const opts = { runId: 'synthetic-env', prompt: 'Check existing integration settings', cwd: tmp.workspace, toolEnv };
  await agent.prepareRun?.(opts);
  const run = agent.run(opts);
  try {
    const events = [];
    for await (const event of run.events) events.push(event);
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events.some(event => event.type === 'done')).toBe(true);
    const final = events.find(event => event.type === 'final_text');
    const answer = final?.type === 'final_text' ? final.content :
      events.map(event => event.type === 'text' ? event.delta : '').join('');
    const inherited = JSON.parse(answer);
    expect(inherited).toEqual({ ...compatibilityEnv, ...toolEnv, LARK_CHANNEL: '1' });
    for (const key of Object.keys(bridgeSecrets)) expect(inherited[key], key).toBeUndefined();
    expect(await run.waitForExit(1000)).toBe(true);
  } finally {
    await run.stop();
  }
});
