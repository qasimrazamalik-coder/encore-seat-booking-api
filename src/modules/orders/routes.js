const express = require('express');
const { z } = require('zod');
const { query, transaction } = require('../../db');
const { validate } = require('../../middleware/validate');
const { idempotent } = require('../../middleware/idempotency');
const { notFound } = require('../../errors');
const svc = require('./service');

const router = express.Router();

// Pay for a hold. Requires an Idempotency-Key header; see middleware/idempotency.js.
router.post('/', validate({ body: z.object({
  holdId: z.string().uuid(),
  cardNumber: z.string().trim().min(12).max(23),
}) }), idempotent(async (client, req) => ({
  status: 201,
  body: await svc.checkout(client, req.user, req.valid.body.holdId, req.valid.body),
})));

router.get('/', async (req, res) => {
  const { rows } = await query(
    `${svc.ORDER_VIEW} WHERE o.user_id = $1 GROUP BY o.id, e.id ORDER BY e.starts_at, o.created_at DESC`, [req.user.id]);
  res.json(rows);
});

router.get('/:reference', validate({ params: z.object({ reference: z.string().trim().toUpperCase() }) }), async (req, res) => {
  const { rows: [o] } = await query(
    `SELECT o.user_id, e.organizer_id FROM orders o JOIN events e ON e.id = o.event_id WHERE o.reference = $1`, [req.valid.params.reference]);
  if (!o || (o.user_id !== req.user.id && o.organizer_id !== req.user.id)) throw notFound('Order');
  res.json(await svc.orderView({ query }, req.valid.params.reference));
});

router.post('/:reference/refund', validate({ params: z.object({ reference: z.string().trim().toUpperCase() }) }), async (req, res) => {
  res.json(await transaction((c) => svc.refundOrder(c, req.user, req.valid.params.reference)));
});

module.exports = { router };
