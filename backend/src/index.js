require('dotenv').config(); // backend/.env first (local DB overrides)
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: false }); // root .env fills gaps (GEMINI, TELEGRAM, JWT)
const express = require('express');
const cors = require('cors');
const expenseRoutes = require('./routes/expenseRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const { startQueueProcessor } = require('./controllers/webhookController');

if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is not set');
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:8080';

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.use('/api', expenseRoutes);
app.use('/webhook', webhookRoutes);

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
});

app.listen(PORT, () => {
    console.log(`SmartFin API listening on port ${PORT}`);
    startQueueProcessor();
});