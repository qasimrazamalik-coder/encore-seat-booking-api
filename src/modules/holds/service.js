const { audit } = require('../../db');
const { AppError, notFound, conflict, badRequest } = require('../../errors');

/**
 * Seat holds: the heart of "no double-booking".
 *
 * Claiming seats is ALL OR NOTHING. The requested seat rows are locked with
 * SELECT ... FOR UPDATE in ascending id order. Locking in one global order is
 * what prevents deadlocks: if A wants seats 1,2,3 and B wants 3,2,1, both try
 * seat 1 first, so one simply waits for the other instead of each holding a
 * seat the other needs.
 *
 * Expiry is handled two ways. A seat whose hold has expired is treated as free
 * the moment anyone asks for it (lazy expiry), so customers never wait for the
 * sweeper. The sweeper (sweepExpiredHolds) then tidies up in the background.
 */

const HOLD_VIEW = `
  SELECT h.id, h.event_id AS "eventId", h.status, h.expires_at AS "expiresAt",
         greatest(0, extract(epoch FROM h.expires_at - now()))::int AS "secondsLeft",
         coalesce(json_agg(json_build_object('id', s.id, 'label', s.row_label || s.number, 'tier', t.name, 'priceCents', t.price_cents)
                           ORDER BY s.row_label, s.number) FILTER (WHERE s.id IS NOT NULL), '[]') AS seats,
         coalesce(sum(t.price_cents), 0)::int AS "totalCents"
    FROM holds h
    LEFT JOIN seats s ON s.hold_id = h.id
    LEFT JOIN tiers t ON t.id = s.tier_id`;

async function holdView(db, holdId) {
  const { rows: [h] } = await db.query(`${HOLD_VIEW} WHERE h.id = $1 GROUP BY h.id`, [holdId]);
  return h;
}

/** Lock an event and check it is selling. FOR SHARE: many can book at once, but nobody can cancel it mid-booking. */
async function lockEventForSale(client, eventId) {
  const { rows: [e] } = await client.query('SELECT * FROM events WHERE id = $1 FOR SHARE', [eventId]);
  if (!e) throw notFound('Event');
  if (e.status === 'cancelled') throw conflict('EVENT_CANCELLED', 'This event has been cancelled.');
  if (e.status !== 'on_sale') throw notFound('Event');
  if (new Date(e.starts_at) <= new Date()) throw conflict('SALES_CLOSED', 'This event has already started.');
  return e;
}

async function releaseSeatsOf(client, holdId) {
  await client.query(`UPDATE seats SET status = 'available', hold_id = NULL WHERE hold_id = $1`, [holdId]);
}

async function createHold(client, user, eventId, seatIds) {
  const event = await lockEventForSale(client, eventId);
  const ids = [...new Set(seatIds)].sort((a, b) => a - b);
  if (ids.length > event.max_per_order) {
    throw badRequest('TOO_MANY_SEATS', `You can hold up to ${event.max_per_order} seats at a time for this event.`);
  }

  // Tickets already bought count towards the same per-customer limit.
  const { rows: [owned] } = await client.query(
    `SELECT count(*) AS n FROM tickets tk JOIN orders o ON o.id = tk.order_id
      WHERE o.user_id = $1 AND o.event_id = $2 AND tk.valid`, [user.id, eventId]);
  if (owned.n + ids.length > event.max_per_order) {
    throw conflict('TICKET_LIMIT', `You already have ${owned.n} ticket${owned.n === 1 ? '' : 's'}; the limit is ${event.max_per_order} per person.`);
  }

  // One active hold per person per event: picking again replaces the old selection.
  const { rows: previous } = await client.query(
    `SELECT id FROM holds WHERE user_id = $1 AND event_id = $2 AND status = 'active' FOR UPDATE`, [user.id, eventId]);

  // Step 1: lock every requested seat, in id order, ON ITS OWN.
  //
  // Why not join holds here? Under READ COMMITTED, if this statement has to
  // wait for another transaction's lock, PostgreSQL re-reads the seat row
  // after the wait but evaluates the join against the snapshot taken BEFORE
  // waiting. A hold the other transaction just created is invisible in that
  // snapshot, so the seat would look held by nothing, i.e. free. That exact
  // bug double-booked seats in our race tests (see README, "the snapshot trap").
  const { rows: seats } = await client.query(
    `SELECT id, status, hold_id FROM seats
      WHERE event_id = $1 AND id = ANY($2::bigint[])
      ORDER BY id
      FOR UPDATE`, [eventId, ids]);
  if (seats.length !== ids.length) throw notFound('One or more of those seats');

  // Step 2: a new statement takes a fresh snapshot, now that we own the locks,
  // so it sees every hold committed by whoever held them before us.
  const holdIds = [...new Set(seats.map((s) => s.hold_id).filter(Boolean))];
  const { rows: holds } = holdIds.length
    ? await client.query('SELECT id, expires_at FROM holds WHERE id = ANY($1::uuid[])', [holdIds])
    : { rows: [] };
  const expiry = new Map(holds.map((h) => [h.id, h.expires_at]));
  for (const s of seats) s.expires_at = s.hold_id ? expiry.get(s.hold_id) : null;

  const previousIds = new Set(previous.map((p) => p.id));
  const taken = seats.filter((s) =>
    s.status === 'sold'
    || (s.status === 'held' && new Date(s.expires_at) > new Date() && !previousIds.has(s.hold_id)));
  if (taken.length) {
    throw new AppError(409, 'SEATS_UNAVAILABLE', 'Someone else got some of those seats first. Pick again.',
      { seatIds: taken.map((s) => s.id) });
  }

  for (const p of previous) {
    await releaseSeatsOf(client, p.id);
    await client.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [p.id]);
  }
  // Seats still pointing at someone's expired hold are simply re-pointed below
  // (lazy expiry). We deliberately do not touch that old hold row here: the
  // sweeper locks holds before seats, and doing the reverse would risk a deadlock.
  // A checkout of the stale hold is refused anyway because it has expired.

  const { rows: [hold] } = await client.query(
    `INSERT INTO holds (event_id, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id`, [eventId, user.id, event.hold_minutes]);
  await client.query(`UPDATE seats SET status = 'held', hold_id = $2 WHERE id = ANY($1::bigint[])`, [ids, hold.id]);
  await audit(client, user.id, 'hold.create', 'hold', hold.id, { eventId, seatIds: ids });
  return holdView(client, hold.id);
}

async function releaseHold(client, user, holdId) {
  const { rows: [h] } = await client.query('SELECT * FROM holds WHERE id = $1 FOR UPDATE', [holdId]);
  if (!h || h.user_id !== user.id) throw notFound('Hold');
  if (h.status !== 'active') throw conflict('HOLD_NOT_ACTIVE', `This hold is already ${h.status}.`);
  await releaseSeatsOf(client, h.id);
  await client.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [h.id]);
  await audit(client, user.id, 'hold.release', 'hold', h.id);
}

/**
 * Background tidy-up. SKIP LOCKED means it never waits on a hold that a
 * checkout is busy converting; that one is simply picked up next time.
 */
async function sweepExpiredHolds(client) {
  const { rows } = await client.query(
    `UPDATE holds SET status = 'expired'
      WHERE id IN (SELECT id FROM holds WHERE status = 'active' AND expires_at < now() FOR UPDATE SKIP LOCKED)
      RETURNING id`);
  if (rows.length) {
    await client.query(`UPDATE seats SET status = 'available', hold_id = NULL WHERE hold_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
  }
  return rows.length;
}

module.exports = { createHold, releaseHold, sweepExpiredHolds, holdView, releaseSeatsOf };
