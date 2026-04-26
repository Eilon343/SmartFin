const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const expenseController = require('../controllers/expenseController');
const authController = require('../controllers/authController');

router.post('/auth/login', authController.login);
router.post('/auth/google', authController.googleLogin);

router.get('/expenses', auth, expenseController.getAllExpenses);
router.get('/expenses/summary', auth, expenseController.getSummary);
router.get('/categories', auth, expenseController.getCategories);

module.exports = router;
