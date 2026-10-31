const { sendTelegramMessage } = require('../../backend/src/utils/telegram');

describe('sendTelegramMessage', () => {
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; });

    it('carries the HTTP status, so a caller can tell a blocked chat from an outage', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'blocked' });

        await expect(sendTelegramMessage('1', 'hi')).rejects.toMatchObject({ status: 403 });
    });
});
