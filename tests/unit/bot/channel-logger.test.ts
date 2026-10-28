import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../src/core/logger.js';
import * as channelModule from '../../../src/bot/channel.js';
import { sdkCardClickRig } from '../../helpers/sdk-card-click.js';

describe('Lark SDK logger noise filtering', () => {
  it('suppresses optional wiki-node permission failures that fall back to the original file token', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        [
          {
            message: 'Request failed with status code 400',
            config: {
              method: 'get',
              url: 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
            },
            response: {
              data: {
                code: 99991672,
                msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
              },
            },
          },
          {
            code: 99991672,
            msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
          },
        ],
      ]),
    ).toBe(true);
  });

  it('keeps unrelated permission failures visible', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        {
          message: 'Request failed with status code 400',
          config: {
            method: 'post',
            url: 'https://open.feishu.cn/open-apis/im/v1/messages',
          },
          response: {
            data: {
              code: 99991672,
              msg: 'Access denied.',
            },
          },
        },
      ]),
    ).toBe(false);
  });
});

describe('SDK card-click drops are logged', () => {
  const rigs: Array<{ dispose(): Promise<unknown> }> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const rig of rigs.splice(0)) await rig.dispose();
  });

  function rig() {
    const next = sdkCardClickRig({
      chatId: 'oc_group',
      operatorOpenId: 'ou_operator_secretish',
      messageId: 'om_status',
      onCardAction: async () => undefined,
      sdkOptions: channelModule.sdkLoggerOptions(),
    });
    rigs.push(next);
    return next;
  }

  const dropCalls = (info: { mock: { calls: unknown[][] } }) =>
    info.mock.calls.filter((call) => call[1] === 'card-action-dropped');

  it('a repeat of a stale card button is dropped by the SDK and logged without the click id', async () => {
    const info = vi.spyOn(log, 'info');
    const { received, click } = rig();
    const button = { value: { cmd: 'help', card: 'status' } };
    await click(button);
    await click(button);
    expect(received).toHaveLength(1);
    const drops = dropCalls(info);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toEqual([
      'sdk',
      'card-action-dropped',
      { reason: 'duplicate', msgId: 'om_status', cmd: 'help' },
    ]);
  });

  it('a repeat of a re-rendered button logs its click id and never a token or the operator', async () => {
    const info = vi.spyOn(log, 'info');
    const { received, click } = rig();
    const button = {
      value: { a: 'Zk3_x9Qa', cmd: 'auto.pause', auto_token: 'tok-SECRET-123' },
    };
    await click(button);
    await click(button);
    expect(received).toHaveLength(1);
    const drops = dropCalls(info);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toEqual([
      'sdk',
      'card-action-dropped',
      { reason: 'duplicate', msgId: 'om_status', cmd: 'auto.pause', clickId: 'Zk3_x9Qa' },
    ]);
    for (const call of info.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('tok-SECRET-123');
      expect(serialized).not.toContain('ou_operator_secretish');
    }
  });

  it('a single first click logs no card-action-dropped', async () => {
    const info = vi.spyOn(log, 'info');
    const { received, click } = rig();
    await click({ value: { cmd: 'help', card: 'status' } });
    expect(received).toHaveLength(1);
    expect(dropCalls(info)).toHaveLength(0);
  });
});
