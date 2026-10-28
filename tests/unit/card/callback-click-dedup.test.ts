import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_CARD_TTL_MS, AutoActionAuth, type AutoCardAction } from '../../../src/automations/action-auth';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { automationBoardCard } from '../../../src/automations/board-card';
import {
  automationConfirmCard, automationDeleteCard, automationReplaceCard, automationTargetSnapshot,
} from '../../../src/automations/confirm-card';
import { automationEndCard } from '../../../src/automations/end-card';
import type { AutomationItem } from '../../../src/automations/store';
import { NoticeActionAuth } from '../../../src/bot/interruption-notice';
import { accountCurrentCard, accountFormCard } from '../../../src/card/account-cards';
import { CallbackAuth } from '../../../src/card/callback-auth';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { configFormCard } from '../../../src/card/config-card';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState } from '../../../src/card/run-state';
import {
  helpCard, interruptionNoticeCard, resumeCard, statusCard, workspacesCard,
} from '../../../src/card/templates';
import { callbackButtons, sdkCardClickRig, sortedKeys, type CallbackButton } from '../../helpers/sdk-card-click';

const CHAT = 'oc_752b8bb8cca2d789ba269f34ae8c1372';
const OPERATOR = 'ou_0f3a9c1d2e4b5a6978c0d1e2f3a4b5c6';
const MESSAGE = 'om_x100b62b00dffcca0b0bbfdec8252029';
const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const DRAFT = `draft-${NOW}-0a1b2c3d`;

const nonceStore = new CallbackNonceStore('/nonexistent/callback-nonces.json');
const autoAuth = new AutoActionAuth({ secret: 'auto-secret', nonceStore, now: () => NOW });
const boardAuth = new BoardActionAuth({ secret: 'board-secret', now: () => NOW });
const noticeAuth = new NoticeActionAuth({ secret: 'notice-secret', nonceStore, now: () => NOW });
const callbackAuth = new CallbackAuth({ keys: [{ version: 1, secret: 'cb-secret' }], nonceStore, now: () => NOW });

const autoToken = (action: AutoCardAction) => autoAuth.sign({ draftId: DRAFT, chatId: CHAT, action, ttlMs: AUTO_CARD_TTL_MS });
const confirmTokens = () => ({ confirmToken: autoToken('auto.confirm'), rejectToken: autoToken('auto.reject') });

function item(overrides: Partial<AutomationItem> = {}): AutomationItem {
  return {
    id: 1, taskType: 'reminder', schedule: { kind: 'one-shot', fireAt: NOW + 3_600_000 }, timezone: 'UTC',
    startAt: NOW, endAt: NOW + 3_600_000, nextFireAt: NOW + 3_600_000, lastFireAt: 0, paused: false, missed: 0,
    lastStatus: 'never', fireHistory: [], chatId: CHAT, createdBy: 'ou_alice', name: '交周报',
    taskText: '提醒交周报', missedInstants: [], skippedInstants: [], ...overrides,
  };
}

const confirmBody = {
  taskType: 'reminder' as const, name: '交周报', taskText: '提醒交周报', timezone: 'UTC',
  schedule: { kind: 'one-shot' as const, fireAt: NOW + 3_600_000 }, now: NOW,
};

interface CardCase {
  name: string;
  render: () => object;
  /** Built through the shared callback builder, so each render carries its own click ids. */
  perRender?: boolean;
}

const CARDS: CardCase[] = [
  { name: 'status', render: () => statusCard({
    profileName: 'p', sessionStale: false, agentName: 'Agent', runtimeAccess: { label: 'permission', value: 'auto' },
    activeRun: false, ownerState: 'ok', scope: CHAT, chatMode: 'p2p',
  }) },
  { name: 'help', render: () => helpCard('Agent') },
  { name: 'workspaces', render: () => workspacesCard('/repo/a', { A: '/repo/a', B: '/repo/b' }) },
  { name: 'resume', render: () => resumeCard('/repo', [
    { sessionId: '7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f', preview: 'one', relTime: '1m' },
    { sessionId: '8a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d', preview: 'two', relTime: '2m' },
  ]) },
  { name: 'interruption notice', render: () => {
    const sign = (action: 'notice.continue' | 'notice.dismiss') => noticeAuth.sign({
      turnId: 'turn-0123456789abcdef', scope: CHAT, chatId: CHAT, action, policyFingerprint: 'f'.repeat(64), ttlMs: 60_000,
    });
    return interruptionNoticeCard({ body: '中断', continueToken: sign('notice.continue'), dismissToken: sign('notice.dismiss') });
  } },
  { name: 'config form', render: () => configFormCard({
    agentKind: 'claude', mode: 'personal', model: 'default', messageReply: 'markdown', showToolCalls: true,
    cotMessages: 'off', maxConcurrentRuns: 10, runIdleTimeoutMinutes: 15, requireMentionInGroup: true,
    larkCliIdentity: 'bot-only', allowedUsers: [], allowedChats: [], admins: [], knownChats: [],
  }) },
  { name: 'account current', render: () => accountCurrentCard({ appId: 'cli_0123456789abcdef', tenant: 'feishu' }) },
  { name: 'account form', render: () => accountFormCard() },
  { name: 'run card', render: () => renderCard(initialState, {
    signCallback: (action) => callbackAuth.sign({
      runId: '5d6e7f80-91a2-4b3c-8d4e-5f60718293a4', scope: CHAT, chatId: CHAT, operatorOpenId: OPERATOR,
      action, policyFingerprint: 'f'.repeat(64), ttlMs: 60_000,
    }),
  }) },
  { name: 'automation confirm', perRender: true, render: () => automationConfirmCard({ ...confirmBody, ...confirmTokens() }) },
  { name: 'automation delete', perRender: true, render: () => automationDeleteCard({
    target: automationTargetSnapshot(item()), ...confirmTokens(),
  }) },
  { name: 'automation replace', perRender: true, render: () => automationReplaceCard({
    ...confirmBody, target: automationTargetSnapshot(item()), ...confirmTokens(),
  }) },
  { name: 'automation end', perRender: true, render: () => automationEndCard({
    'auto.end.1w': autoToken('auto.end.1w'), 'auto.end.2w': autoToken('auto.end.2w'),
    'auto.end.1m': autoToken('auto.end.1m'), 'auto.end.3m': autoToken('auto.end.3m'),
    'auto.end.eoy': autoToken('auto.end.eoy'), 'auto.end.1y': autoToken('auto.end.1y'),
    'auto.end.custom': autoToken('auto.end.custom'), 'auto.reject': autoToken('auto.reject'),
  }) },
  { name: 'automation board', perRender: true, render: () => automationBoardCard({
    items: [item(), item({ id: 2, name: '交月报', paused: true })], auth: boardAuth,
  }) },
];

const rigs: Array<{ dispose(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.dispose();
});

function rig() {
  const next = sdkCardClickRig({ chatId: CHAT, operatorOpenId: OPERATOR, messageId: MESSAGE });
  rigs.push(next);
  return next;
}

describe.each([
  { order: 'as rendered', reorder: (value: Record<string, unknown>) => value },
  { order: 'keys sorted', reorder: sortedKeys },
])('card callback click dedup ($order)', ({ reorder }) => {
  const buttons = (card: object): CallbackButton[] =>
    callbackButtons(card).map((button) => ({ ...button, value: reorder(button.value) }));

  it.each(CARDS)('every button of one $name render reaches the handler', async ({ render }) => {
    const { received, click } = rig();
    const all = buttons(render());
    expect(all.length).toBeGreaterThan(0);
    for (const button of all) await click(button);
    expect(received.map((value) => value.cmd)).toEqual(all.map((button) => button.value.cmd));
  });

  it.each(CARDS)('an exact redelivery of each $name button is still dropped', async ({ render }) => {
    const { received, click } = rig();
    const all = buttons(render());
    for (const button of all) {
      await click(button);
      await click(button);
    }
    expect(received).toHaveLength(all.length);
  });

  it.each(CARDS.filter((card) => card.perRender))(
    'the same $name button from a later render on the same message reaches the handler',
    async ({ render }) => {
      const { received, click } = rig();
      const first = buttons(render());
      const second = buttons(render());
      expect(second).toHaveLength(first.length);
      for (const [index, button] of first.entries()) {
        await click(button);
        await click(second[index]!);
      }
      expect(received).toHaveLength(first.length * 2);
    },
  );
});
