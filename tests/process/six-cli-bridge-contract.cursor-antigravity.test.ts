import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { buildToolProcess } from '../helpers/bridge-tool-process';
import { createRecordingLarkChannel } from '../helpers/recording-lark-channel';
import type { PinAgentKind } from '../helpers/scripted-jsonl-cli';
import { registerSixCliContract } from './six-cli-bridge-contract-suite';
import type { startChannel as sourceStartChannel } from '../../src/bot/channel';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel }));

const cleanup: Array<() => Promise<unknown>> = [];
let client: Awaited<ReturnType<typeof buildToolProcess>>;
let startChannel: typeof sourceStartChannel;
beforeAll(async () => {
  client = await buildToolProcess({ channel: true });
  ({ startChannel } = await import(join(client.directory, 'dist/channel.js').replaceAll('\\', '/')));
}, 30000);
afterAll(async () => { await client?.cleanup(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); sdk.channel = undefined; vi.restoreAllMocks(); });

const KINDS: readonly PinAgentKind[] = ['cursor', 'antigravity'];
registerSixCliContract({ kinds: KINDS, getClient: () => client, getStartChannel: () => startChannel, sdk, cleanup });
