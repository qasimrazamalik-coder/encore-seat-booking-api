const crypto = require('crypto');
const config = require('../../config');
const payments = require('../../payments');
const { audit } = require('../../db');
const { AppError, notFound, conflict, forbidden } = require('../../errors');
const { releaseSeatsOf } = require('../holds/service');

// Human-friendly codes: no 0/O or 1/I, so they survive being read aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');

const ORDER_VIEW = `
  SELECT o.reference, o.status, o.total_cents AS "totalCents", o.created_at AS "createdAt", o.refunded_at AS "refundedAt",
         e.id AS "eventId", e.title, e.venue, e.starts_at AS "startsAt",
         json_agg(json_build_object('code', tk.code, 'seat', s.row_label || s.number, 'tier', t.name,
                                    'priceCents', tk.price_cents, 'valid', tk.valid, 'checkedInAt', tk.checked_in_at)
                  ORDER BY s.row_label, s.number) AS tickets
    FROM orders o
    JOIN events e   ON e.id = o.event_id
    JOIN tickets tk ON tk.order_id = o.id
    JOIN seats s    ON s.id = tk.seat_id
    JOIN tiers t    ON t.id = s.tier_id`;

async function orderView(db, reference) {
  const { rows: [o] } = await db.query(`${ORDER_VIEW} WHERE o.reference = $1 GROUP BY o.id, e.id`, [reference]);
  return o;
}

/**
 * Turns an active hold into a paid order. Called inside the idempotency
 * wrapper's transaction, so a retry with the same key never gets here twice.
 * The hold row is locked first, so two different keys racing for the same
 * hold are serialised and the second sees it already converted.
 */
async function checkout(client, user, holdId, { cardNumber }) {
  // Lock order everywhere is: event, then hold, then seats. Cancelling an event
  // takes the same path, so a cancel and a checkout can wait on each other but
  // never deadlock. FOR SHARE lets many checkouts run together.
  const { rows: [ref] } = await client.query('SELECT event_id, user_id FROM holds WHERE id = $1', [holdId]);
  if (!ref || ref.user_id !== user.id) throw notFound('Hold');
  const { rows: [event] } = await client.query('SELECT status FROM events WHERE id = $1 FOR SHARE', [ref.event_id]);
  if (event.status === 'cancelled') throw conflict('EVENT_CANCELLED', 'This event has been cancelled, so it cannot be booked.');

  const { rows: [hold] } = await client.query('SELECT * FROM holds WHERE id = $1 FOR UPDATE', [holdId]);
  if (!hold || hold.user_id !== user.id) throw notFound('Hold');
  if (hold.status === 'converted') throw conflict('HOLD_ALREADY_USED', 'These seats have already been paid for.');
  if (hold.status !== 'active' || new Date(hold.expires_at) <= new Date()) {
    if (hold.status === 'active') {
      await releaseSeatsOf(client, hold.id);
      await client.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [hold.id]);
    }
    throw new AppError(410, 'HOLD_EXPIRED', 'Your seats were released because the hold ran out. Pick them again.');
  }

  const { rows: seats } = await client.query(
    `SELECT s.id, t.price_cents FROM seats s JOIN tiers t ON t.id = s.tier_id
      WHERE s.hold_id = $1 ORDER BY s.id FOR UPDATE OF s`, [hold.id]);
  if (!seats.length) throw new AppError(410, 'HOLD_EXPIRED', 'This hold no longer has any seats.');
  const total = seats.reduce((sum, s) => sum + s.price_cents, 0);

  // Throws PAYMENT_DECLINED / CARD_INVALID; the wrapper rolls back to its savepoint.
  const payment = payments.charge({ amountCents: total, cardNumber });

  const reference = `ENC-${code(6)}`;
  const { rows: [order] } = await client.query(
    `INSERT INTO orders (reference, user_id, event_id, hold_id, total_cents, payment_ref)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [reference, user.id, hold.event_id, hold.id, total, payment.ref]);
  for (const s of seats) {
    await client.query('INSERT INTO tickets (order_id, seat_id, code, price_cents) VALUES ($1, $2, $3, $4)',
      [order.id, s.id, code(10), s.price_cents]);
  }
  await client.query(`UPDATE seats SET status = 'sold', hold_id = NULL WHERE id = ANY($1::bigint[])`, [seats.map((s) => s.id)]);
  await client.query(`UPDATE holds SET status = 'converted' WHERE id = $1`, [hold.id]);
  await audit(client, user.id, 'order.paid', 'order', reference, { totalCents: total, seats: seats.length, payment: payment.ref });
  return orderView(client, reference);
}

/** Refund an order: tickets are voided and the seats go back on sale. */
async function refundOrder(client, actor, reference, { force = false } = {}) {
  const { rows: [o] } = await client.query(
    `SELECT o.*, e.starts_at, e.organizer_id FROM orders o JOIN events e ON e.id = o.event_id
      WHERE o.reference = $1 FOR UPDATE OF o`, [reference]);
  const isOrganizer = o && o.organizer_id === actor.id;
  if (!o || (o.user_id !== actor.id && !isOrganizer)) throw notFound('Order');
  if (o.status === 'refunded') throw conflict('ALREADY_REFUNDED', 'This order was already refunded.');

  const hoursLeft = (new Date(o.starts_at) - new Date()) / 3600000;
  if (!force && hoursLeft < config.refundCutoffHours) {
    throw conflict('TOO_LATE_TO_REFUND', `Refunds close ${config.refundCutoffHours} hours before the event starts.`);
  }
  const { rows: tickets } = await client.query(
    'SELECT * FROM tickets WHERE order_id = $1 ORDER BY seat_id FOR UPDATE', [o.id]);
  if (tickets.some((t) => t.checked_in_at)) throw conflict('ALREADY_USED', 'Someone has already entered with a ticket from this order.');

  const refund = payments.refund({ paymentRef: o.payment_ref, amountCents: o.total_cents });
  await client.query('UPDATE tickets SET valid = false WHERE order_id = $1', [o.id]);
  await client.query(`UPDATE seats SET status = 'available' WHERE id = ANY($1::bigint[])`, [tickets.map((t) => t.seat_id)]);
  await client.query(`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = $1`, [o.id]);
  await audit(client, actor.id, 'order.refund', 'order', reference, { refund: refund.ref, byOrganizer: isOrganizer && o.user_id !== actor.id });
  return orderView(client, reference);
}

function assertOwnerOrOrganizer(order, user, organizerId) {
  if (order.user_id !== user.id && organizerId !== user.id) throw forbidden();
}

module.exports = { checkout, refundOrder, orderView, ORDER_VIEW, assertOwnerOrOrganizer, code };
