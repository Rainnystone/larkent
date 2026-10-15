import { writeFileSync } from 'node:fs';
import { consumeFault, nextInvocationId, parseFaultMode } from './fault-state';

export type ShimDecision =
  | { action: 'exec'; target: string; args: string[] }
  | { action: 'fault'; mode: string; args: string[]; target: string };

export async function decideShimAction(input: {
  argv: string[];
  target: string;
  faultDir: string;
}): Promise<ShimDecision> {
  const runId = process.env.LARKENT_E2E_RUN_ID?.trim() || (await nextInvocationId(input.faultDir));
  const meta = input.argv.includes('--version') || input.argv.includes('--help');
  if (meta) {
    return { action: 'exec', target: input.target, args: input.argv };
  }
  const hit = await consumeFault(input.faultDir, runId);
  if (hit) {
    parseFaultMode(hit.mode);
    return { action: 'fault', mode: hit.mode, target: input.target, args: input.argv };
  }
  return { action: 'exec', target: input.target, args: input.argv };
}

function writeDecisionFile(path: string, decision: ShimDecision): void {
  const lines =
    decision.action === 'exec'
      ? ['EXEC', decision.target, ...decision.args]
      : ['FAULT', decision.mode, decision.target, ...decision.args];
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
}

const decisionFlag = process.argv.indexOf('--decision-file');
const separator = process.argv.indexOf('--');
if (decisionFlag >= 0) {
  const file = process.argv[decisionFlag + 1];
  if (!file) {
    console.error('decide.ts requires --decision-file <path>');
    process.exit(2);
  }
  const argv = separator >= 0 ? process.argv.slice(separator + 1) : [];
  const target = process.env.LARKENT_E2E_SHIM_TARGET;
  const faultDir = process.env.LARKENT_E2E_FAULT_DIR;
  if (!target || !faultDir) {
    console.error('LARKENT_E2E_SHIM_TARGET and LARKENT_E2E_FAULT_DIR are required');
    process.exit(2);
  }
  const decision = await decideShimAction({ argv, target, faultDir });
  writeDecisionFile(file, decision);
}
