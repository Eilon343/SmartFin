const jwt = require('jsonwebtoken');

const TEST_USER = { user_id: 42, username: 'testuser' };
const SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-jest';

function makeToken(user = TEST_USER) {
    return jwt.sign(user, SECRET, { expiresIn: '1h' });
}

function makeExpiredToken(user = TEST_USER) {
    return jwt.sign(user, SECRET, { expiresIn: '-1s' });
}

function authHeader(user) {
    return { Authorization: `Bearer ${makeToken(user)}` };
}

module.exports = { makeToken, makeExpiredToken, authHeader, TEST_USER };
