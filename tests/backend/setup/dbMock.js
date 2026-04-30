// Replaces backend/src/config/db in all tests via moduleNameMapper.
// Each test file gets a fresh instance due to jest clearMocks: true.
const db = {
    query: jest.fn(),
};
module.exports = db;
