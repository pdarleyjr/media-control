const express = require('express');
const router = express.Router();

// Legacy pairing endpoint disabled. Use /api/provision/pair, which enforces
// workspace context, write-tier authorization, and a minimized response shape.
router.post('/', (_req, res) => {
  res.status(410).json({ error: 'Legacy provisioning endpoint disabled. Use /api/provision/pair.' });
});

module.exports = router;
