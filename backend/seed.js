require('dotenv').config();
const db = require('./src/config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const USER_ID = 999999999; // Dedicated mock user ID so your real data is safe

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

async function seed() {
    try {
        console.log('Seeding massive mock data...');

        // 1. Ensure user exists
        const [users] = await db.query('SELECT user_id FROM users WHERE user_id = ?', [USER_ID]);
        if (users.length === 0) {
            const pinHash = await bcrypt.hash('1234', 10);
            await db.query(
                'INSERT INTO users (user_id, username, pin_hash) VALUES (?, ?, ?)',
                [USER_ID, 'MockUser', pinHash]
            );
        }

        // 2. Add custom categories
        const customCategories = ['Travel', 'Pets', 'Health', 'Education', 'Gifts'];
        for (const cat of customCategories) {
            await db.query('INSERT IGNORE INTO categories (user_id, name, is_base) VALUES (?, ?, FALSE)', [USER_ID, cat]);
        }

        // Fetch all categories
        const [categories] = await db.query('SELECT category_id, name FROM categories WHERE user_id IS NULL OR user_id = ?', [USER_ID]);
        const catMap = {};
        categories.forEach(c => catMap[c.name] = c.category_id);

        // 3. Add Budgets
        const budgetConfig = {
            'Food': { limit: 2500, carry: true },
            'Transport': { limit: 800, carry: false },
            'Housing': { limit: 4000, carry: false },
            'Entertainment': { limit: 1000, carry: true },
            'Shopping': { limit: 1200, carry: true },
            'Utilities': { limit: 600, carry: true },
            'Health': { limit: 500, carry: true },
            'Pets': { limit: 400, carry: false }
        };

        for (const [name, config] of Object.entries(budgetConfig)) {
            if (catMap[name]) {
                await db.query(
                    'INSERT IGNORE INTO budgets (user_id, category_id, monthly_limit, carry_over) VALUES (?, ?, ?, ?)',
                    [USER_ID, catMap[name], config.limit, config.carry]
                );
            }
        }

        // 4. Generate 6 Months of Expenses
        console.log('Generating 6 months of expenses...');
        const descriptions = {
            'Food': ['Groceries', 'Coffee Shop', 'Restaurant', 'Supermarket', 'Pizza Delivery', 'Bakery', 'Fast Food'],
            'Transport': ['Gas Station', 'Bus Ticket', 'Train', 'Uber', 'Taxi', 'Parking'],
            'Housing': ['Rent', 'Home Insurance', 'Maintenance', 'Furniture'],
            'Entertainment': ['Movie Tickets', 'Concert', 'Video Games', 'Bowling', 'Museum'],
            'Shopping': ['Clothes', 'Electronics', 'Shoes', 'Amazon', 'Bookstore'],
            'Utilities': ['Electricity', 'Water Bill', 'Internet', 'Phone Bill'],
            'Health': ['Pharmacy', 'Doctor Visit', 'Dentist', 'Gym Membership'],
            'Pets': ['Pet Food', 'Vet', 'Toys'],
            'Travel': ['Flight', 'Hotel', 'Tour', 'Car Rental'],
            'Gifts': ['Birthday Present', 'Wedding Gift', 'Flowers'],
            'Education': ['Course', 'Books', 'Stationery']
        };

        const today = new Date();
        for (let i = 0; i < 180; i++) { // 180 days
            const numExpensesToday = getRandomInt(0, 4); // 0 to 4 expenses per day
            const expenseDate = new Date(today);
            expenseDate.setDate(today.getDate() - i);
            const dateStr = expenseDate.toISOString().slice(0, 19).replace('T', ' ');

            for (let j = 0; j < numExpensesToday; j++) {
                const catName = getRandomElement(Object.keys(descriptions));
                const desc = getRandomElement(descriptions[catName]);
                // Random amounts depending on category
                let amount = getRandomInt(15, 300);
                if (catName === 'Housing') amount = getRandomInt(500, 4000);
                if (catName === 'Travel') amount = getRandomInt(200, 1500);

                await db.query(
                    'INSERT INTO expenses (user_id, amount, currency, description, category_id, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [USER_ID, amount, 'ILS', desc, catMap[catName], dateStr, getRandomElement(['bot', 'web', 'apple_pay', 'manual'])]
                );
            }
        }

        // 5. Generate Income for last 6 months
        console.log('Generating income...');
        for (let i = 0; i < 6; i++) {
            const mDate = new Date(today);
            mDate.setMonth(today.getMonth() - i);
            const monthStr = mDate.toISOString().slice(0, 7);
            
            // Fixed Salary
            await db.query('INSERT INTO income (user_id, source, amount, type, month) VALUES (?, ?, ?, ?, ?)', [USER_ID, 'Tech Corp Salary', 12500, 'fixed', monthStr]);
            
            // Variable Incomes (1-3 per month)
            const numVar = getRandomInt(1, 3);
            for (let j = 0; j < numVar; j++) {
                const varSource = getRandomElement(['Freelance Web Dev', 'Dividends', 'Cashback', 'Sold Old Laptop', 'Consulting']);
                const varAmount = getRandomInt(300, 2500);
                await db.query('INSERT INTO income (user_id, source, amount, type, month) VALUES (?, ?, ?, ?, ?)', [USER_ID, varSource, varAmount, 'variable', monthStr]);
            }
        }

        // 6. Add Subscriptions
        console.log('Generating subscriptions...');
        const subs = [
            { name: 'Netflix', amount: 54.90, cat: 'Entertainment', day: 10 },
            { name: 'Spotify', amount: 19.90, cat: 'Entertainment', day: 5 },
            { name: 'Gym', amount: 250.00, cat: 'Health', day: 1 },
            { name: 'AWS Cloud', amount: 80.00, cat: 'Utilities', day: 15 },
            { name: 'ChatGPT Plus', amount: 75.00, cat: 'Utilities', day: 22 },
            { name: 'Mobile Plan', amount: 39.90, cat: 'Utilities', day: 8 },
        ];

        for (const s of subs) {
            await db.query(
                'INSERT INTO subscriptions (user_id, name, amount, category_id, day_of_month) VALUES (?, ?, ?, ?, ?)',
                [USER_ID, s.name, s.amount, catMap[s.cat], s.day]
            );
        }

        // 7. Add Savings Goals
        console.log('Generating savings goals...');
        const goals = [
            { name: 'New Car', target: 50000, saved: 15000, monthly: 1000 },
            { name: 'Emergency Fund', target: 30000, saved: 30000, monthly: 0 }, // Completed
            { name: 'Vacation to Japan', target: 12000, saved: 4500, monthly: 500 },
            { name: 'New Laptop', target: 8000, saved: 1200, monthly: 300 }
        ];

        for (const g of goals) {
            await db.query(
                'INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, monthly_allocation) VALUES (?, ?, ?, ?, ?)',
                [USER_ID, g.name, g.target, g.saved, g.monthly]
            );
        }

        // Generate a valid login token for the mock user
        const token = jwt.sign(
            { user_id: USER_ID, username: 'MockUser' },
            process.env.JWT_SECRET,
            { expiresIn: '365d' }
        );

        console.log('\n=============================================');
        console.log('✅ Massive Mock data seeded successfully!');
        console.log('\nTo log in as the Mock User, open your browser Console (F12) and run:');
        console.log(`\nlocalStorage.setItem('sf_token', '${token}'); window.location.href='/';\n`);
        console.log('To return to your real account later, just click Log Out in the app!');
        console.log('=============================================\n');
        
        process.exit(0);
    } catch (err) {
        console.error('Error seeding data:', err);
        process.exit(1);
    }
}

seed();
