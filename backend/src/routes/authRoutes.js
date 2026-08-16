const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const authController = require('../controllers/authController');

// Paths under /api/auth are covered by authLimiter (20 requests / 15 min per IP) in
// index.js before any route runs, and apiLimiter deliberately skips them. Every credential
// and link-code endpoint therefore inherits the strict bucket for free.
router.post('/auth/signup', authController.signup);
router.post('/auth/login', authController.login);
router.post('/auth/google', authController.googleLogin);
router.post('/auth/telegram/link-code', auth, authController.createTelegramLinkCode);
router.delete('/auth/telegram/link', auth, authController.unlinkTelegram);

// NOT under /api/auth, on purpose. Settings polls this while a link code is live to notice
// the bot redeeming it, which at one call per 5s would blow the 20-per-15-min auth bucket in
// under two minutes. It presents no credential and is auth-guarded, so it is an ordinary
// read and belongs in apiLimiter's 1500-per-15-min bucket.
router.get('/me', auth, authController.getMe);
router.post('/me/onboarded', auth, authController.markOnboarded);

module.exports = router;
