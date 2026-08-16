const {
    validateEmail,
    validatePassword,
    MIN_PASSWORD,
} = require('../../frontend/src/lib/authValidation');

// The point of these validators is that the message names the ACTUAL defect. A test that
// only asserted "returns something falsy/truthy" would pass just as well for a single
// generic "invalid email", which is the behaviour this replaced — so every case here
// asserts the specific key.

describe('validateEmail', () => {
    it('accepts ordinary addresses', () => {
        for (const ok of [
            'you@example.com',
            'first.last@example.co.il',
            'user+tag@example.com',
            'a@b.co',
            "o'brien@example.com",
        ]) {
            expect(validateEmail(ok)).toBeNull();
        }
    });

    it('tolerates surrounding whitespace, as pasting usually adds', () => {
        expect(validateEmail('  you@example.com  ')).toBeNull();
    });

    it('asks for an address when the field is empty', () => {
        expect(validateEmail('')).toBe('auth_err_email_empty');
        expect(validateEmail('   ')).toBe('auth_err_email_empty');
        expect(validateEmail(undefined)).toBe('auth_err_email_empty');
        expect(validateEmail(null)).toBe('auth_err_email_empty');
    });

    it('names an interior space rather than calling the whole thing invalid', () => {
        // Common when pasting from a document that wrapped the address.
        expect(validateEmail('you @example.com')).toBe('auth_err_email_space');
        expect(validateEmail('you@ example.com')).toBe('auth_err_email_space');
    });

    it('names a missing @', () => {
        expect(validateEmail('you.example.com')).toBe('auth_err_email_at');
        expect(validateEmail('eilon')).toBe('auth_err_email_at');
    });

    it('names a doubled @', () => {
        expect(validateEmail('you@@example.com')).toBe('auth_err_email_at_many');
        expect(validateEmail('you@example@com')).toBe('auth_err_email_at_many');
    });

    it('distinguishes a missing local part from a missing domain', () => {
        expect(validateEmail('@example.com')).toBe('auth_err_email_local');
        expect(validateEmail('you@')).toBe('auth_err_email_domain');
    });

    /**
     * The case worth having: "you@gmail" looks finished to the person typing it, passes a
     * naive presence-of-@ check, and is undeliverable. It needs its own message.
     */
    it('catches a domain with no dot', () => {
        expect(validateEmail('you@gmail')).toBe('auth_err_email_tld');
        expect(validateEmail('you@localhost')).toBe('auth_err_email_tld');
    });

    it('catches malformed dot placement in the domain', () => {
        expect(validateEmail('you@.com')).toBe('auth_err_email_domain_shape');
        expect(validateEmail('you@example.')).toBe('auth_err_email_domain_shape');
        expect(validateEmail('you@example..com')).toBe('auth_err_email_domain_shape');
    });

    it('reports the outermost problem first', () => {
        // Missing @ AND a space: the @ is the thing to fix once the space is gone, but the
        // space is what makes the value unparseable, so it is named first.
        expect(validateEmail('no at sign')).toBe('auth_err_email_space');
    });
});

describe('validatePassword', () => {
    it('asks for a password when empty, in both modes', () => {
        expect(validatePassword('', true)).toBe('auth_err_password_empty');
        expect(validatePassword('', false)).toBe('auth_err_password_empty');
        expect(validatePassword(undefined, true)).toBe('auth_err_password_empty');
    });

    it('enforces the minimum length on sign-up', () => {
        expect(validatePassword('short', true)).toBe('auth_err_password_short');
        expect(validatePassword('a'.repeat(MIN_PASSWORD - 1), true)).toBe('auth_err_password_short');
        expect(validatePassword('a'.repeat(MIN_PASSWORD), true)).toBeNull();
    });

    /**
     * A short password that already exists is the server's business, not the form's.
     * Blocking it here would lock an older account out of its own front door.
     */
    it('does not judge the length of an existing password on sign-in', () => {
        expect(validatePassword('1234', false)).toBeNull();
        expect(validatePassword('a', false)).toBeNull();
    });

    it('counts characters, not words, so spaces are legitimate', () => {
        expect(validatePassword('correct horse', true)).toBeNull();
        expect(validatePassword('  ', true)).toBe('auth_err_password_short');
    });

    it('agrees with the server minimum', () => {
        // authController.js MIN_PASSWORD_LENGTH — if these drift, the form accepts a
        // password the API then rejects with a message the user cannot act on.
        expect(MIN_PASSWORD).toBe(8);
    });
});
