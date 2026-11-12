const fs = require('fs');
const path = require('path');

/**
 * Schema rules that only fail on a real database, long after the tests pass.
 *
 * alert_log shipped with `user_id INT` against `users.user_id BIGINT`, and MySQL rejected
 * the foreign key at deploy time:
 *
 *   ERROR 3780: Referencing column 'user_id' and referenced column 'user_id' in foreign
 *   key constraint 'alert_log_ibfk_1' are incompatible.
 *
 * Nothing in the suite could catch it, because every test runs against a mock. These read
 * the SQL as text instead, which is enough for a whole class of mistakes.
 */

const DB_DIR = path.join(__dirname, '../../db');
const migrations = fs.readdirSync(DB_DIR).filter((f) => f.startsWith('migrate_') && f.endsWith('.sql'));

describe('migrations that point at users(user_id)', () => {
    it.each(migrations)('%s declares the referencing column as BIGINT', (file) => {
        const sql = fs.readFileSync(path.join(DB_DIR, file), 'utf8');
        if (!/REFERENCES\s+users\s*\(\s*user_id\s*\)/i.test(sql)) return;

        // Every declaration of a user_id column in a file that references users(user_id).
        const declarations = [...sql.matchAll(/^\s*user_id\s+(\w+)/gim)].map((m) => m[1].toUpperCase());
        expect(declarations.length).toBeGreaterThan(0);
        for (const type of declarations) {
            expect(type).toBe('BIGINT');
        }
    });
});

describe('every migration', () => {
    it.each(migrations)('%s is safe to run twice', (file) => {
        const sql = fs.readFileSync(path.join(DB_DIR, file), 'utf8');
        // The deploy applies every migrate_*.sql on every deploy, so a CREATE TABLE that is
        // not guarded fails the whole run the second time round.
        const creates = [...sql.matchAll(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/gi)];
        for (const [, guard] of creates) {
            expect(guard).toBeDefined();
        }
    });
});
