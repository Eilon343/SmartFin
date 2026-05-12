const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const expenseController = require('../controllers/expenseController');
const authController = require('../controllers/authController');
const incomeController = require('../controllers/incomeController');
const savingsController = require('../controllers/savingsController');
const insightsController = require('../controllers/insightsController');

router.post('/auth/login', authController.login);
router.post('/auth/google', authController.googleLogin);

router.get('/expenses', auth, expenseController.getAllExpenses);
router.post('/expenses', auth, expenseController.addExpense);
router.put('/expenses/:id', auth, expenseController.updateExpense);
router.get('/expenses/summary', auth, expenseController.getSummary);
router.delete('/expenses/:id', auth, expenseController.deleteExpense);
router.get('/categories', auth, expenseController.getCategories);
router.post('/categories', auth, expenseController.addCategory);
router.get('/budgets', auth, expenseController.getBudgets);
router.post('/budgets', auth, expenseController.upsertBudget);
router.get('/subscriptions', auth, expenseController.getSubscriptions);
router.post('/subscriptions', auth, expenseController.addSubscription);
router.put('/subscriptions/:id', auth, expenseController.updateSubscription);
router.put('/subscriptions/:id/pause', auth, expenseController.togglePauseSubscription);
router.delete('/subscriptions/:id', auth, expenseController.deleteSubscription);
router.get('/pnl', auth, expenseController.getPnL);
router.get('/insights', auth, insightsController.getInsights);

router.get('/income', auth, incomeController.getIncome);
router.post('/income', auth, incomeController.addIncome);
router.get('/income/summary', auth, incomeController.getIncomeSummary);
router.put('/income/:id', auth, incomeController.updateIncome);
router.delete('/income/:id', auth, incomeController.deleteIncome);

router.get('/savings', auth, savingsController.getSavingsGoals);
router.post('/savings', auth, savingsController.addSavingsGoal);
router.put('/savings/:id', auth, savingsController.updateSavingsGoal);
router.post('/savings/:id/deposit', auth, savingsController.depositToGoal);
router.get('/savings/:id/history', auth, savingsController.getGoalHistory);
router.delete('/savings/:id', auth, savingsController.deleteGoal);

module.exports = router;
