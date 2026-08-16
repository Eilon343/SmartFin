const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const bankConnectionController = require('../controllers/bankConnectionController');

router.get('/bank-connections/companies', auth, bankConnectionController.listCompanies);
router.get('/bank-connections', auth, bankConnectionController.listConnections);
router.post('/bank-connections', auth, bankConnectionController.createConnection);
router.post('/bank-connections/:id/sync', auth, bankConnectionController.triggerSync);
router.delete('/bank-connections/:id', auth, bankConnectionController.deleteConnection);

module.exports = router;
