import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCardAction } from '../../../src/card/dispatcher';
import { tryHandleCommand } from '../../../src/commands';
import { callbackButtons, sdkCardClickRig, type CallbackButton } from '../../helpers/sdk-card-click';
import { createUserActionHarness } from '../../helpers/user-action-context';

const OPERATOR = 'ou_operator';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness() {
  const h = await createUserActionHarness('group');
  cleanups.push(h.cleanup);
  h.controls.profileConfig.access.admins = [OPERATOR];
  const slash = async (content: string): Promise<object> => {
    await tryHandleCommand({ ...h.context, origin: 'slash', msg: { ...h.context.msg, messageId: 'om_slash', content } });
    return (h.channel.sent.at(-1)?.content as { card: object }).card;
  };
  const rig = (messageId: string) => {
    const next = sdkCardClickRig({
      chatId: 'oc_group', operatorOpenId: OPERATOR, messageId,
      onCardAction: (evt) => handleCardAction({ ...h.runtime, evt }),
    });
    cleanups.push(next.dispose);
    return next;
  };
  return { ...h, slash, rig };
}

/** What the clicker's Feishu client shows next: the callback's card if one came back, else the same card. */
function shownAfter(response: unknown, shown: object): object {
  const card = (response as { card?: { type?: string; data?: object } } | undefined)?.card;
  return card?.type === 'raw' && card.data ? card.data : shown;
}

function buttonOf(card: object, cmd: string, name?: string): CallbackButton {
  const found = callbackButtons(card).find((b) => b.value.cmd === cmd && (name === undefined || b.value.name === name));
  if (!found) throw new Error(`no ${cmd} ${name ?? ''} button`);
  return found;
}

function currentAlias(card: object): string | undefined {
  return JSON.stringify(card).match(/\*\*([^*]+)\*\* → [^"]*← 当前/)?.[1];
}

function sentTitles(sent: Array<{ content: unknown }>): string[] {
  return sent.map((s) => (s.content as { card?: { header?: { title?: { content?: string } } } }).card?.header?.title?.content ?? '');
}

async function aliases(h: Awaited<ReturnType<typeof harness>>) {
  const a = join(h.tmp.workspace, 'd11a');
  const b = join(h.tmp.workspace, 'd11b');
  await mkdir(a);
  await mkdir(b);
  const [ra, rb] = [await realpath(a), await realpath(b)];
  h.workspaces.saveNamed('d11a', ra);
  h.workspaces.saveNamed('d11b', rb);
  h.workspaces.setCwd('oc_group', rb);
  return { a: ra, b: rb };
}

describe('command cards are re-rendered on click so repeat clicks survive the SDK dedup', () => {
  it('/ws A -> B -> A: all three switches reach the handler and the card marks the new current cwd', async () => {
    const h = await harness();
    const dirs = await aliases(h);
    const { click, received } = h.rig('om_ws');
    let shown = await h.slash('/ws');
    expect(currentAlias(shown)).toBe('d11b');

    const after: Array<{ cwd?: string; marked?: string }> = [];
    for (const name of ['d11a', 'd11b', 'd11a']) {
      shown = shownAfter(await click(buttonOf(shown, 'ws.use', name)), shown);
      after.push({ cwd: h.workspaces.cwdFor('oc_group'), marked: currentAlias(shown) });
    }
    expect(received.map((value) => value.name)).toEqual(['d11a', 'd11b', 'd11a']);
    expect(h.channel.sent.filter((s) => JSON.stringify(s.content).includes('已切换到'))).toHaveLength(3);
    expect(after).toEqual([
      { cwd: dirs.a, marked: 'd11a' }, { cwd: dirs.b, marked: 'd11b' }, { cwd: dirs.a, marked: 'd11a' },
    ]);
  });

  it('still drops an exact redelivery of one /ws click', async () => {
    const h = await harness();
    await aliases(h);
    const { click, received } = h.rig('om_ws');
    const shown = await h.slash('/ws');
    const button = buttonOf(shown, 'ws.use', 'd11a');
    expect(await click(button)).toBeDefined();
    expect(await click(button)).toBeUndefined();
    expect(received).toHaveLength(1);
  });

  it('re-asserts the latest re-render after the click spinner and never an older one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await harness();
    await aliases(h);
    const { click } = h.rig('om_ws');
    const r0 = await h.slash('/ws');
    const r1 = shownAfter(await click(buttonOf(r0, 'ws.use', 'd11a')), r0);
    await vi.advanceTimersByTimeAsync(3_000);
    const r2 = shownAfter(await click(buttonOf(r1, 'ws.use', 'd11b')), r1);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(h.channel.updatedCards.map((u) => u.messageId)).toEqual(['om_ws', 'om_ws', 'om_ws']);
    expect(h.channel.updatedCards.map((u) => currentAlias(u.card as object))).toEqual(['d11a', 'd11b', 'd11b']);
    expect(h.channel.updatedCards.map((u) => u.card)).toEqual([r1, r2, r2]);
  });

  it('a later click whose re-render fails cancels the older pending re-asserts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await harness();
    const dirs = await aliases(h);
    const { click, received } = h.rig('om_ws');
    const r0 = await h.slash('/ws');
    const r1 = shownAfter(await click(buttonOf(r0, 'ws.use', 'd11a')), r0);
    vi.spyOn(h.workspaces, 'listNamed').mockImplementationOnce(() => { throw new Error('store unreadable'); });
    expect(await click(buttonOf(r1, 'ws.use', 'd11b'))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(received).toHaveLength(2);
    expect(h.workspaces.cwdFor('oc_group')).toBe(dirs.b);
    expect(h.channel.updatedCards).toEqual([]);
  });

  it.each([
    { from: '/help', title: '💡 使用帮助', cmd: 'status', opens: '📊 当前状态' },
    { from: '/status', title: '📊 当前状态', cmd: 'help', opens: '💡 使用帮助' },
  ])('$from: the same $cmd button clicked twice reaches the handler twice', async ({ from, title, cmd, opens }) => {
    const h = await harness();
    const { click, received } = h.rig('om_nav');
    let shown = await h.slash(from);
    h.channel.sent.length = 0;
    for (let i = 0; i < 2; i += 1) {
      shown = shownAfter(await click(buttonOf(shown, cmd)), shown);
      expect((shown as { header: { title: { content: string } } }).header.title.content).toBe(title);
    }
    expect(received).toHaveLength(2);
    expect(sentTitles(h.channel.sent)).toEqual([opens, opens]);
  });

  it('a button from a card rendered before this change still runs its command, without a re-render', async () => {
    const h = await harness();
    const dirs = await aliases(h);
    const { click, received } = h.rig('om_old');
    const response = await click({ value: { cmd: 'ws.use', name: 'd11a' } });
    expect(received).toHaveLength(1);
    expect(h.workspaces.cwdFor('oc_group')).toBe(dirs.a);
    expect(response).toBeUndefined();
    expect(h.channel.updatedCards).toEqual([]);
  });
});
