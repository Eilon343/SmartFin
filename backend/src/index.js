require('dotenv').config(); // backend/.env first (local DB overrides)
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: false }); // root .env fills gaps (GEMINI, TELEGRAM, JWT)
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
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

// Trust nginx proxy so rate limit uses real client IP (not 172.x.x.x container IP)
app.set('trust proxy', 1);

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
    skip: (req) => req.path.startsWith('/auth'),
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again later.' },
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many webhook requests.' },
});

app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);
app.use('/webhook', webhookLimiter);

app.use('/api', expenseRoutes);
app.use('/webhook', webhookRoutes);

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
});

app.listen(PORT, () => {
    console.log(`SmartFin API listening on port ${PORT}`);
    startQueueProcessor();
});