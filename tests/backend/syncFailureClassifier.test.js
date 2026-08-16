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
