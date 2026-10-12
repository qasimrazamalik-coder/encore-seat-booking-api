const express = require('express');
const { z } = require('zod');
const { query, transaction } = require('../../db');
const { validate } = require('../../middleware/validate');
const { notFound } = require('../../errors');
const svc = require('./service');

const router = express.Router();
const uuid = z.string().uuid();

router.post('/', validate({ body: z.object({
  eventId: z.number().int().positive(),
  seatIds: z.array(z.number().int().positive()).min(1, 'Pick at least one seat.').max(20),
}) }), async (req, res) => {
  const hold = await transaction((c) => svc.createHold(c, req.user, req.valid.body.eventId, req.valid.body.seatIds));
  res.status(201).json(hold);
});

router.get('/:id', validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  const h = await svc.holdView({ query }, req.valid.params.id);
  const { rows: [owner] } = await query('SELECT user_id FROM holds WHERE id = $1', [req.valid.params.id]);
  if (!h || owner.user_id !== req.user.id) throw notFound('Hold');
  res.json(h);
});

router.delete('/:id', validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  await transaction((c) => svc.releaseHold(c, req.user, req.valid.params.id));
  res.status(204).end();
});

module.exports = { router };
