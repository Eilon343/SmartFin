const { urlBase64ToUint8Array } = require('../../frontend/src/lib/vapid');

// PushManager.subscribe() silently produces an unusable subscription (or throws an opaque
// InvalidAccessError) if the key bytes are wrong, so the decoding is pinned byte-for-byte.

describe('urlBase64ToUint8Array', () => {
    it('decodes URL-safe base64 without padding', () => {
        // bytes 0xfb 0xff 0xbf encode to "-_-_" in URL-safe base64 ("+/+/" in standard)
        expect(Array.from(urlBase64ToUint8Array('-_-_'))).toEqual([0xfb, 0xff, 0xbf]);
    });

    it('restores missing padding', () => {
        expect(Array.from(urlBase64ToUint8Array('AQ'))).toEqual([1]);
        expect(Array.from(urlBase64ToUint8Array('AQI'))).toEqual([1, 2]);
    });

    it('decodes a real 65-byte P-256 VAPID public key', () => {
        const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
        const bytes = urlBase64ToUint8Array(key);
        expect(bytes).toHaveLength(65);
        expect(bytes[0]).toBe(0x04); // uncompressed point marker
    });

    it('ignores surrounding whitespace from an env file', () => {
        expect(Array.from(urlBase64ToUint8Array(' AQ\n'))).toEqual([1]);
    });

    it('fails loudly on a missing key', () => {
        expect(() => urlBase64ToUint8Array('')).toThrow('VAPID public key is missing');
        expect(() => urlBase64ToUint8Array(undefined)).toThrow('VAPID public key is missing');
    });
});
