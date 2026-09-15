// Uses the real web-push, which throws on a malformed key. The backend once crash-looped in
// production because that throw escaped at module load.
const load = (env) => {
    let mod;
    jest.isolateModules(() => {
        Object.assign(process.env, env);
        mod = require('../../backend/src/utils/push');
    });
    return mod;
};

afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
});

test('an invalid VAPID key disables push instead of crashing the server', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const push = load({ VAPID_PUBLIC_KEY: 'not-a-key', VAPID_PRIVATE_KEY: 'also-not-a-key' });
    expect(push.isPushConfigured()).toBe(false);
});

test('keys wrapped in quotes (as env_file passes them) are accepted', () => {
    const { generateVAPIDKeys } = jest.requireActual('web-push');
    const { publicKey, privateKey } = generateVAPIDKeys();
    const push = load({
        VAPID_PUBLIC_KEY: `"${publicKey}"`,
        VAPID_PRIVATE_KEY: `'${privateKey}'`,
        VAPID_SUBJECT: '"mailto:dev@example.com"',
    });
    expect(push.isPushConfigured()).toBe(true);
});
