process.env.JWT_SECRET = 'test-jwt-secret-for-jest';
// No WEBHOOK_SECRET: it authenticated the removed Apple Pay webhook and is read by
// nothing. TELEGRAM_WEBHOOK_SECRET is deliberately unset here so the default suite
// exercises the unconfigured path; the secret-token tests set it themselves.
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
process.env.TELEGRAM_CHAT_ID = '123456789';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.BANK_CREDENTIALS_KEY = '0'.repeat(64); // 32-byte hex key for bank credential crypto
