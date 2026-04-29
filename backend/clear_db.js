require('dotenv').config();
const db = require('./src/config/db');

const USER_ID = 999999999; // Using a dedicated mock user ID so real data is never touched

async function clearDb() {
    try {
        console.log('Clearing all data for user', USER_ID);

        // Delete in correct order to avoid foreign key constraints
        await db.query('DELETE FROM expenses WHERE user_id = ?', [USER_ID]);
        await db.query('DELETE FROM budgets WHERE user_id = ?', [USER_ID]);
        await db.query('DELETE FROM subscriptions WHERE user_id = ?', [USER_ID]);
        await db.query('DELETE FROM income WHERE user_id = ?', [USER_ID]);
        await db.query('DELETE FROM savings_goals WHERE user_id = ?', [USER_ID]);
        
        // Don't delete base categories, only user-specific ones
        await db.query('DELETE FROM categories WHERE user_id = ? AND is_base = FALSE', [USER_ID]);
        
        // Finally, delete the mock user
        await db.query('DELETE FROM users WHERE user_id = ?', [USER_ID]);
        
        console.log('Successfully reverted mock data!');
        process.exit(0);
    } catch (err) {
        console.error('Error clearing data:', err);
        process.exit(1);
    }
}

clearDb();
