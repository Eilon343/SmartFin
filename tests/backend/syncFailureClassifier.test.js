const { classifySyncFailure } = require('../../backend/src/services/syncFailureClassifier');

const conn = (status, last_sync_status, last_sync_error = '') => ({ status, last_sync_status, last_sync_error });

describe('classifySyncFailure - healthy connections', () => {
    it('says nothing about a working connection', () => {
        expect(classifySyncFailure(conn('active', 'ok'))).toBeNull();
    });

    it('says nothing about a first sync still in progress', () => {
        expect(classifySyncFailure(conn('pending_first_sync', null))).toBeNull();
    });

    it('says nothing about a connection the user simply switched off', () => {
        expect(classifySyncFailure(conn('disabled', null, ''))).toBeNull();
    });

    it('handles a missing connection', () => {
        expect(classifySyncFailure(null)).toBeNull();
    });
});

describe('classifySyncFailure - the Max case', () => {
    // A mistyped username on Max never reaches an "invalid password" response. The site
    // rejects it and stays on the login page, so the scraper times out waiting for a
    // redirect. Reported as a plain timeout, this retries hourly forever and spends a
    // real login attempt each time — against an issuer that locks after about three.
    const maxFailure = conn(
        'error',
        'TIMEOUT',
        'waiting for redirect from https://www.max.co.il/login?ReturnURL=https:%2F%2Fwww.max.co.il%2Fhomepage'
    );

    it('reads a timeout on the login page as a credentials problem', () => {
        expect(classifySyncFailure(maxFailure).code).toBe('login_failed');
    });

    it('keeps the raw scraper message for the details disclosure', () => {
        expect(classifySyncFailure(maxFailure).detail).toContain('max.co.il/login');
    });

    it('still reports that it is retrying, because the scheduler is', () => {
        // The user needs to know an hourly retry is burning login attempts.
        expect(classifySyncFailure(maxFailure).retrying).toBe(true);
    });
});

describe('classifySyncFailure - timeouts are split by where they happened', () => {
    it('treats a timeout after login as a genuine transient', () => {
        const f = classifySyncFailure(conn('error', 'TIMEOUT', 'Navigation timeout of 30000 ms exceeded'));
        expect(f.code).toBe('timeout');
    });

    it('matches the login page case-insensitively', () => {
        expect(classifySyncFailure(conn('error', 'Timeout', 'waiting for REDIRECT from /LOGIN')).code)
            .toBe('login_failed');
    });

    it('spots a sign-in page that is not spelled "login"', () => {
        expect(classifySyncFailure(conn('error', 'TIMEOUT', 'timed out at https://bank.co.il/connect.aspx')).code)
            .toBe('login_failed');
    });
});

describe('classifySyncFailure - explicit bank responses', () => {
    it('maps a rejected password, and never marks it retrying', () => {
        const f = classifySyncFailure(conn('invalid_credentials', 'InvalidPassword', 'Invalid username/password'));
        expect(f.code).toBe('invalid_credentials');
        // Retrying known-bad credentials is what locks a real bank account.
        expect(f.retrying).toBe(false);
    });

    it('maps a forced password change', () => {
        expect(classifySyncFailure(conn('error', 'ChangePassword')).code).toBe('change_password');
    });

    it('maps a blocked account', () => {
        expect(classifySyncFailure(conn('error', 'AccountBlocked')).code).toBe('blocked');
    });

    it('maps missing two-factor support', () => {
        expect(classifySyncFailure(conn('error', 'TwoFactorRetrieverMissing')).code).toBe('two_factor');
    });

    it('maps an unreadable credential blob', () => {
        expect(classifySyncFailure(conn('error', 'error', 'Could not decrypt stored credentials')).code)
            .toBe('decrypt');
    });

    it('falls back to unknown rather than inventing a cause', () => {
        expect(classifySyncFailure(conn('error', 'Generic', 'something odd')).code).toBe('unknown');
    });
});

describe('classifySyncFailure - retry flag', () => {
    it('marks a disabled connection as not retrying', () => {
        // Disabled is how a failing connection gets parked, so the user must be told
        // nothing will happen until they act.
        expect(classifySyncFailure(conn('disabled', 'TIMEOUT', 'waiting for redirect from /login')).retrying)
            .toBe(false);
    });

    it('marks an errored connection as retrying', () => {
        expect(classifySyncFailure(conn('error', 'Generic', 'x')).retrying).toBe(true);
    });
});

/**
 * The regression these guard.
 *
 * Every case above was written against the spelling of the scraper's enum MEMBER NAMES
 * ('InvalidPassword'). What the library actually puts on a failed result is the enum's
 * VALUE ('INVALID_PASSWORD'), and that is what the scheduler writes to last_sync_status.
 * With a plain lowercase, 'invalid_password'.includes('invalidpassword') is false, so in
 * production every branch below was dead and a rejected password, a blocked account and
 * a 2FA-only bank all came back as 'unknown' — the code the UI has nothing to say about.
 */
describe('classifySyncFailure - the error types the scraper really emits', () => {
    const REAL = [
        ['INVALID_PASSWORD', 'invalid_credentials'],
        ['CHANGE_PASSWORD', 'change_password'],
        ['ACCOUNT_BLOCKED', 'blocked'],
        ['TWO_FACTOR_RETRIEVER_MISSING', 'two_factor'],
        ['TIMEOUT', 'timeout'],
    ];

    it.each(REAL)('maps the underscored value %s to %s', (errorType, expected) => {
        expect(classifySyncFailure(conn('error', errorType, 'something went wrong')).code).toBe(expected);
    });

    it('never reports a real error type as "unknown"', () => {
        for (const [errorType] of REAL) {
            expect(classifySyncFailure(conn('error', errorType, 'x')).code).not.toBe('unknown');
        }
    });

    // Rows written before the fix hold the member-name spelling. They must keep working.
    it('still classifies rows stored in the old member-name spelling', () => {
        expect(classifySyncFailure(conn('error', 'AccountBlocked')).code).toBe('blocked');
        expect(classifySyncFailure(conn('error', 'TwoFactorRetrieverMissing')).code).toBe('two_factor');
    });
});
