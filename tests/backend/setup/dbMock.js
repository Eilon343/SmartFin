// Replaces backend/src/config/db in all tests via moduleNameMapper.
// Each test file gets a fresh instance due to jest clearMocks: true.
const conn = {
    query: jest.fn(),
    beginTransaction: jest.fn().mockResolvedValue(),
    commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(),
    release: jest.fn(),
};

const db = {
    query: jest.fn(),
    getConnection: jest.fn().mockResolvedValue(conn),
    _conn: conn, // exposed so tests can mock conn.query separately if needed
};
module.exports = db;
