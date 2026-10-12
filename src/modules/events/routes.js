const express = require('express');
const { z } = require('zod');
const { query, transaction, audit } = require('../../db');
const { validate } = require('../../middleware/validate');
const { authenticate, optionalAuth, requireOrganizer } = require('../../middleware/auth');
const { notFound, conflict, badRequest } = require('../../errors');
const { refundOrder } = require('../orders/service');
const { releaseSeatsOf } = require('../holds/service');

const router = express.Router();
const id = z.coerce.number().int().positive();

const toEvent = (e) => ({
  id: e.id, title: e.title, description: e.description, venue: e.venue, startsAt: e.starts_at,
  status: e.status, maxPerOrder: e.max_per_order, holdMinutes: e.hold_minutes,
  seatsTotal: e.seats_total, seatsLeft: e.seats_left, fromCents: e.from_cents,
});

// A seat counts as left if it is free, or held by a hold that has already run out.
const AVAILABILITY = `
  (SELECT count(*)::int FROM seats s WHERE s.event_id = e.id) AS seats_total,
  (SELECT count(*)::int FROM seats s LEFT JOIN holds h ON h.id = s.hold_id
    WHERE s.event_id = e.id AND (s.status = 'available' OR (s.status = 'held' AND h.expires_at < now()))) AS seats_left,
  (SELECT min(price_cents) FROM tiers t WHERE t.event_id = e.id) AS from_cents`;

// Public listing: upcoming events on sale. Organizers also see their own drafts.
router.get('/', optionalAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, ${AVAILABILITY} FROM events e
      WHERE e.starts_at > now() AND (e.status = 'on_sale' OR e.organizer_id = $1)
      ORDER BY e.starts_at`, [req.user?.id ?? null]);
  res.json(rows.map(toEvent));
});

/**
 * One event with its seat map. Each seat reports one of:
 * available, taken (sold or held by someone else), or yours (in your active hold).
 * Who holds a seat is never revealed.
 */
router.get('/:id', optionalAuth, validate({ params: z.object({ id }) }), async (req, res) => {
  const { rows: [e] } = await query(`SELECT e.*, ${AVAILABILITY} FROM events e WHERE e.id = $1`, [req.valid.params.id]);
  if (!e || (e.status === 'draft' && e.organizer_id !== req.user?.id)) throw notFound('Event');
  const { rows: seats } = await query(
    `SELECT s.id, s.row_label AS row, s.number, t.name AS tier, t.price_cents AS "priceCents",
            CASE WHEN s.status = 'sold' THEN 'taken'
                 WHEN s.status = 'held' AND h.expires_at > now() AND h.user_id = $2 THEN 'yours'
                 WHEN s.status = 'held' AND h.expires_at > now() THEN 'taken'
                 ELSE 'available' END AS state
       FROM seats s JOIN tiers t ON t.id = s.tier_id LEFT JOIN holds h ON h.id = s.hold_id
      WHERE s.event_id = $1 ORDER BY s.row_label, s.number`, [e.id, req.user?.id ?? null]);
  const { rows: tiers } = await query('SELECT name, price_cents AS "priceCents" FROM tiers WHERE event_id = $1 ORDER BY price_cents DESC', [e.id]);
  const { rows: [myHold] } = req.user ? await query(
    `SELECT id, expires_at AS "expiresAt" FROM holds WHERE user_id = $1 AND event_id = $2 AND status = 'active' AND expires_at > now()`,
    [req.user.id, e.id]) : { rows: [] };
  res.json({ ...toEvent(e), tiers, seats, myHold: myHold ?? null });
});

const createSchema = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).default(''),
  venue: z.string().trim().min(2).max(120),
  startsAt: z.string().datetime({ offset: true }),
  maxPerOrder: z.number().int().min(1).max(20).default(6),
  holdMinutes: z.number().int().min(1).max(60).default(8),
  // The seating plan: each tier owns some rows, all rows in a tier have the same width.
  tiers: z.array(z.object({
    name: z.string().trim().min(1).max(40),
    priceCents: z.number().int().min(0).max(1000000),
    rows: z.array(z.string().trim().regex(/^[A-Z]{1,2}$/, 'Rows are labelled A to ZZ.')).min(1).max(30),
    seatsPerRow: z.number().int().min(1).max(60),
  })).min(1).max(6),
});

router.post('/', authenticate, requireOrganizer, validate({ body: createSchema }), async (req, res) => {
  const b = req.valid.body;
  if (new Date(b.startsAt) <= new Date()) throw badRequest('START_IN_PAST', 'The event must start in the future.');
  const total = b.tiers.reduce((n, t) => n + t.rows.length * t.seatsPerRow, 0);
  if (total > 5000) throw badRequest('TOO_MANY_SEATS', 'A layout can have at most 5000 seats.');

  const eventId = await transaction(async (c) => {
    const { rows: [e] } = await c.query(
      `INSERT INTO events (organizer_id, title, description, venue, starts_at, max_per_order, hold_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.id, b.title, b.description, b.venue, b.startsAt, b.maxPerOrder, b.holdMinutes]);
    for (const t of b.tiers) {
      const { rows: [tier] } = await c.query(
        'INSERT INTO tiers (event_id, name, price_cents) VALUES ($1, $2, $3) RETURNING id', [e.id, t.name, t.priceCents]);
      // One statement per tier generates every seat: rows x numbers.
      await c.query(
        `INSERT INTO seats (event_id, tier_id, row_label, number)
         SELECT $1, $2, r, n FROM unnest($3::text[]) r, generate_series(1, $4::int) n`,
        [e.id, tier.id, t.rows, t.seatsPerRow]);
    }
    await audit(c, req.user.id, 'event.create', 'event', e.id, { seats: total });
    return e.id;
  });
  const { rows: [e] } = await query(`SELECT e.*, ${AVAILABILITY} FROM events e WHERE e.id = $1`, [eventId]);
  res.status(201).json(toEvent(e));
});

async function ownEvent(c, eventId, userId, { lock = false } = {}) {
  const { rows: [e] } = await c.query(`SELECT * FROM events WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [eventId]);
  if (!e || e.organizer_id !== userId) throw notFound('Event');
  return e;
}

router.post('/:id/publish', authenticate, requireOrganizer, validate({ params: z.object({ id }) }), async (req, res) => {
  await transaction(async (c) => {
    const e = await ownEvent(c, req.valid.params.id, req.user.id, { lock: true });
    if (e.status !== 'draft') throw conflict('NOT_DRAFT', `Only drafts can be published; this one is ${e.status}.`);
    await c.query(`UPDATE events SET status = 'on_sale' WHERE id = $1`, [e.id]);
    await audit(c, req.user.id, 'event.publish', 'event', e.id);
  });
  res.json({ id: req.valid.params.id, status: 'on_sale' });
});

/**
 * Cancelling refunds every paid order and drops every hold, in one
 * transaction. FOR UPDATE on the event waits for in-flight bookings (which
 * hold FOR SHARE) to finish, and blocks new ones from starting.
 */
router.post('/:id/cancel', authenticate, requireOrganizer, validate({ params: z.object({ id }) }), async (req, res) => {
  const refunded = await transaction(async (c) => {
    const e = await ownEvent(c, req.valid.params.id, req.user.id, { lock: true });
    if (e.status === 'cancelled') throw conflict('ALREADY_CANCELLED', 'This event is already cancelled.');
    await c.query(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [e.id]);
    const { rows: holds } = await c.query(`SELECT id FROM holds WHERE event_id = $1 AND status = 'active' FOR UPDATE`, [e.id]);
    for (const h of holds) {
      await releaseSeatsOf(c, h.id);
      await c.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [h.id]);
    }
    const { rows: orders } = await c.query(`SELECT reference FROM orders WHERE event_id = $1 AND status = 'paid'`, [e.id]);
    for (const o of orders) await refundOrder(c, req.user, o.reference, { force: true });
    await audit(c, req.user.id, 'event.cancel', 'event', e.id, { refunded: orders.length });
    return orders.length;
  });
  res.json({ id: req.valid.params.id, status: 'cancelled', ordersRefunded: refunded });
});

// Door scanning. A ticket gets in once; a refunded ticket never does.
router.post('/:id/check-in', authenticate, requireOrganizer,
  validate({ params: z.object({ id }), body: z.object({ code: z.string().trim().toUpperCase().min(6).max(20) }) }),
  async (req, res) => {
    const result = await transaction(async (c) => {
      await ownEvent(c, req.valid.params.id, req.user.id);
      const { rows: [t] } = await c.query(
        `SELECT tk.*, s.row_label || s.number AS seat, u.name AS holder
           FROM tickets tk JOIN orders o ON o.id = tk.order_id JOIN seats s ON s.id = tk.seat_id JOIN users u ON u.id = o.user_id
          WHERE tk.code = $1 AND o.event_id = $2 FOR UPDATE OF tk`, [req.valid.body.code, req.valid.params.id]);
      if (!t) throw notFound('Ticket for this event');
      if (!t.valid) throw conflict('TICKET_VOID', 'This ticket was refunded and is no longer valid.');
      if (t.checked_in_at) throw conflict('ALREADY_CHECKED_IN', 'This ticket was already used to enter.', { at: t.checked_in_at, seat: t.seat });
      await c.query('UPDATE tickets SET checked_in_at = now() WHERE id = $1', [t.id]);
      return { seat: t.seat, holder: t.holder, code: t.code };
    });
    res.json(result);
  });

// Sales report for the organizer.
router.get('/:id/report', authenticate, requireOrganizer, validate({ params: z.object({ id }) }), async (req, res) => {
  const e = await ownEvent({ query }, req.valid.params.id, req.user.id);
  const [tiers, totals, daily] = await Promise.all([
    query(`SELECT t.name, t.price_cents AS "priceCents", count(s.id)::int AS seats,
                  count(s.id) FILTER (WHERE s.status = 'sold')::int AS sold,
                  count(s.id) FILTER (WHERE s.status = 'held' AND h.expires_at > now())::int AS held,
                  round(100.0 * count(s.id) FILTER (WHERE s.status = 'sold') / nullif(count(s.id), 0), 1) AS "sellThrough"
             FROM tiers t JOIN seats s ON s.tier_id = t.id LEFT JOIN holds h ON h.id = s.hold_id
            WHERE t.event_id = $1 GROUP BY t.id ORDER BY t.price_cents DESC`, [e.id]),
    query(`SELECT count(*) FILTER (WHERE o.status = 'paid')::int AS orders,
                  coalesce(sum(o.total_cents) FILTER (WHERE o.status = 'paid'), 0)::int AS "revenueCents",
                  count(*) FILTER (WHERE o.status = 'refunded')::int AS refunds,
                  (SELECT count(*) FROM tickets tk JOIN orders o2 ON o2.id = tk.order_id
                    WHERE o2.event_id = $1 AND tk.checked_in_at IS NOT NULL)::int AS "checkedIn"
             FROM orders o WHERE o.event_id = $1`, [e.id]),
    query(`SELECT created_at::date AS day, count(*)::int AS orders, sum(total_cents)::int AS "revenueCents"
             FROM orders WHERE event_id = $1 AND status = 'paid' GROUP BY 1 ORDER BY 1`, [e.id]),
  ]);
  res.json({ event: { id: e.id, title: e.title, status: e.status }, tiers: tiers.rows, ...totals.rows[0], daily: daily.rows });
});

module.exports = { router };
