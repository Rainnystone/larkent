import { loadTestBridgeConfig } from '../config';
import { DEFAULT_LOCAL_CONFIG } from '../paths';
import { setProxyMode, up } from '../driver';
import { readProxyState } from '../proxy-control';
import { runWithCleanup } from '../scenario-cleanup';
import { readTesterMessages, sendTesterMessage } from '../tester';

export interface RedeliveryResult {
  gapSec: number;
  sentText: string;
  recovered: boolean;
  viaHint: 'unknown' | 'present-after-restore';
  note: string;
}

/**
 * Disconnect the fault proxy for 20–30s, send an @ message, restore, then
 * see whether the chat shows the tester message again. The live Feishu WS /
 * backfill conclusion belongs in the docs-track delivery note — this only
 * records redacted evidence.
 */
export async function runRedeliveryShortGap(opts: {
  configPath?: string;
  gapSec?: number;
  realCli?: boolean;
  startBridge?: boolean;
}): Promise<RedeliveryResult> {
  const gapSec = clampGap(opts.gapSec ?? 25);
  const config = await loadTestBridgeConfig(opts.configPath ?? DEFAULT_LOCAL_CONFIG);
  if (opts.startBridge) {
    await up({ config, realCli: opts.realCli === true });
  }
  if (!(await readProxyState(config.dataRoot))) {
    throw new Error('redelivery-short-gap needs a running test bridge (e2e:up)');
  }

  const token = `e2e-gap-${Date.now().toString(36)}`;
  return runWithCleanup(
    async () => {
      await setProxyMode(config.dataRoot, 'disconnect');
      await sleep(500);
      const sent = await sendTesterMessage(config, `continue ${token}`);
      await sleep(gapSec * 1000);
      await setProxyMode(config.dataRoot, 'off');
      await sleep(8_000);
      const messages = await readTesterMessages(config, { pageSize: 30 });
      const recovered = messages.some((item) => item.text.includes(token));
      return {
        gapSec,
        sentText: redact(sent.text),
        recovered,
        viaHint: recovered ? 'present-after-restore' : 'unknown',
        note: recovered
          ? 'tester message is visible after restore; inspect bridge logs for WS redelivery vs backfill (card.final / backfill.*).'
          : 'tester message was not visible after restore in the read-back window; do not treat this as a short-gap skip proof.',
      };
    },
    async () => {
      await setProxyMode(config.dataRoot, 'off').catch(() => {});
    },
  );
}

function clampGap(sec: number): number {
  if (!Number.isFinite(sec)) return 25;
  return Math.min(30, Math.max(20, sec));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function redact(text: string): string {
  return text.replace(/<at user_id="[^"]+"><\/at>/g, '<at user_id="redacted"></at>');
}
