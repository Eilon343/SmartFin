// Minimal Express app for supertest — mirrors index.js without app.listen or startQueueProcessor.
const express = require('express');

const app = express();
app.use(express.json());
app.use('/api', require('../../../backend/src/routes/expenseRoutes'));
app.use('/webhook', require('../../../backend/src/routes/webhookRoutes'));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

module.exports = app;
