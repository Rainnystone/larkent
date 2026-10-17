import { describe, expect, it } from 'vitest';
import { createFakeChannel } from '../../helpers/fake-channel';

describe('fake channel schema 2.0', () => {
  it('rejects a schema 1.0 card from createCard and updateCardById with Feishu 200610', async () => {
    const channel = createFakeChannel();
    const legacy = { config: { wide_screen_mode: true }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'x' } }] };
    await expect(channel.createCard(legacy)).rejects.toMatchObject({ code: 200610, msg: 'body is nil' });
    await expect(channel.updateCardById('card_x', legacy, 1)).rejects.toMatchObject({ code: 200610 });
  });
});
