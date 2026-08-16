const crypto = require('crypto');
const db = require('./setup/dbMock');
const {
    issueLinkCode,
    redeemLinkCode,
    hashCode,
    generateCode,
    CODE_LENGTH,
} = require('../../backend/src/services/telegramLink');

// The claim is a conditional UPDATE, so "already used" and "expired" are decided by the DB
// matching zero rows. These helpers model that: the SQL carries
// `used_at IS NULL AND expires_at > NOW()`, so a code that fails either condition simply
// does not match.
function claimSucceeds() {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
}
function claimMatchesNothing() {
    db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
}

describe('code generation', () => {
    it('produces unguessable Crockford base32 codes', () => {
        const codes = new Set();
        for (let i = 0; i < 500; i++) {
            const code = generateCode();
            expect(code).toHaveLength(CODE_LENGTH);
            // No I, L, O or U — those are the characters people mistype when reading a code
            // off a screen and into a chat.
            expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
            codes.add(code);
        }
        expect(codes.size).toBeGreaterThan(495); // effectively no collisions
    });

    it('hashes case- and whitespace-insensitively so a retyped code still matches', () => {
        expect(hashCode('abcd1234')).toBe(hashCode(' ABCD-1234 '));
    });

    it('stores a SHA-256, never the code', () => {
        const code = generateCode();
        expect(hashCode(code)).toBe(crypto.createHash('sha256').update(code).digest('hex'));
        expect(hashCode(code)).not.toContain(code);
    });
});

describe('issueLinkCode', () => {
    it('burns outstanding codes before issuing a new one', async () => {
        db.query
            .mockResolvedValueOnce([{ affectedRows: 1 }])
            .mockResolvedValueOnce([{ insertId: 1 }]);

        const { code, expires_at } = await issueLinkCode(42);

        expect(db.query.mock.calls[0][0]).toMatch(/UPDATE telegram_link_codes SET used_at = NOW\(\)/i);
        expect(db.query.mock.calls[0][1]).toEqual([42]);

        // Only one code is ever live, so clicking "generate" twice cannot leave the first
        // one usable by whoever happened to see it.
        expect(db.query.mock.calls[1][1][1]).toBe(hashCode(code));

        const ttl = new Date(expires_at).getTime() - Date.now();
        expect(ttl).toBeGreaterThan(9 * 60 * 1000);
        expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    });
});

describe('redeemLinkCode', () => {
    it('links the chat to the code owner', async () => {
        claimSucceeds();
        db.query
            .mockResolvedValueOnce([[{ user_id: 777 }]])  // owner
            .mockResolvedValueOnce([[]])                  // chat not bound elsewhere
            .mockResolvedValueOnce([{ affectedRows: 1 }]); // bind

        const result = await redeemLinkCode('ABCD1234', '55501');

        expect(result).toEqual({ ok: true, user_id: 777 });
        const bind = db.query.mock.calls[3];
        expect(bind[0]).toMatch(/UPDATE users SET telegram_chat_id/i);
        expect(bind[1]).toEqual(['55501', 777]);
    });

    /**
     * Single use is the whole security property: a code seen over someone's shoulder, or
     * left in a chat log, must not link a second chat.
     */
    it('rejects a code that has already been used', async () => {
        claimMatchesNothing();

        const result = await redeemLinkCode('ABCD1234', '55501');

        expect(result).toEqual({ ok: false, reason: 'invalid' });
        expect(db.query).toHaveBeenCalledTimes(1); // no lookup, no bind
    });

    it('rejects an expired code', async () => {
        claimMatchesNothing();

        const result = await redeemLinkCode('EXPIRED1', '55501');

        expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects an unknown code', async () => {
        claimMatchesNothing();

        const result = await redeemLinkCode('ZZZZZZZZ', '55501');

        expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects an empty code without touching the database', async () => {
        expect(await redeemLinkCode('', '55501')).toEqual({ ok: false, reason: 'invalid' });
        expect(await redeemLinkCode(undefined, '55501')).toEqual({ ok: false, reason: 'invalid' });
        expect(db.query).not.toHaveBeenCalled();
    });

    /**
     * Unknown, expired and already-used all collapse to the same reason on purpose —
     * distinguishing them would help someone guessing at the code space.
     */
    it('gives the same answer for unknown, expired and used codes', async () => {
        claimMatchesNothing();
        const unknown = await redeemLinkCode('AAAAAAAA', '1');
        claimMatchesNothing();
        const expired = await redeemLinkCode('BBBBBBBB', '1');
        claimMatchesNothing();
        const used = await redeemLinkCode('CCCCCCCC', '1');

        expect(expired).toEqual(unknown);
        expect(used).toEqual(unknown);
    });

    it('refuses when the chat is already linked to a different account', async () => {
        claimSucceeds();
        db.query
            .mockResolvedValueOnce([[{ user_id: 777 }]])
            .mockResolvedValueOnce([[{ user_id: 999 }]]); // chat owned by someone else

        const result = await redeemLinkCode('ABCD1234', '55501');

        expect(result).toEqual({ ok: false, reason: 'chat_taken' });
        // Critically: no UPDATE users ran, so a chat cannot be moved between accounts.
        const binds = db.query.mock.calls.filter(c => /UPDATE users/i.test(c[0]));
        expect(binds).toHaveLength(0);
    });

    it('is idempotent when the same chat re-links to the same account', async () => {
        claimSucceeds();
        db.query
            .mockResolvedValueOnce([[{ user_id: 777 }]])
            .mockResolvedValueOnce([[{ user_id: 777 }]]) // same owner
            .mockResolvedValueOnce([{ affectedRows: 1 }]);

        const result = await redeemLinkCode('ABCD1234', '55501');

        expect(result).toEqual({ ok: true, user_id: 777 });
    });

    it('normalizes a code the user retyped with different case or spacing', async () => {
        claimSucceeds();
        db.query
            .mockResolvedValueOnce([[{ user_id: 777 }]])
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([{ affectedRows: 1 }]);

        await redeemLinkCode(' abcd-1234 ', '55501');

        expect(db.query.mock.calls[0][1]).toEqual([hashCode('ABCD1234')]);
    });
});
