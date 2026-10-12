const crypto = require('crypto');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, makeEvent, hold, pay, buy, query, close, DECLINED_CARD } = require('./helpers');

let organizer;
before(async () => { await reset(); organizer = await makeUser('organizer'); });
after(close);

describe('holding seats', () => {
  test('a hold claims the seats and shows them as yours to you, taken to others', async () => {
    const e = await makeEvent(organizer);
    const [me, other] = await Promise.all([makeUser(), makeUser()]);
    const res = await hold(me, e.id, [e.seat('A1'), e.seat('A2')]);
    assert.equal(res.status, 201);
    assert.equal(res.body.totalCents, 10000);
    assert.deepEqual(res.body.seats.map((s) => s.label), ['A1', 'A2']);
    assert.ok(res.body.secondsLeft > 400 && res.body.secondsLeft <= 480);

    const mine = await api().get(`/api/events/${e.id}`).set(me.auth);
    const theirs = await api().get(`/api/events/${e.id}`).set(other.auth);
    assert.equal(mine.body.seats.find((s) => s.id === e.seat('A1')).state, 'yours');
    assert.equal(theirs.body.seats.find((s) => s.id === e.seat('A1')).state, 'taken');
    assert.equal(theirs.body.seatsLeft, 6);
  });

  test('RACE: thirty people grab the same seat at once, exactly one gets it', async () => {
    const e = await makeEvent(organizer);
    const people = await Promise.all(Array.from({ length: 30 }, () => makeUser()));
    const results = await Promise.all(people.map((p) => hold(p, e.id, [e.seat('A1')])));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'SEATS_UNAVAILABLE'));
  });

  test('RACE: overlapping requests are all-or-nothing, never a partial hold', async () => {
    const e = await makeEvent(organizer);
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const [ra, rb] = await Promise.all([
      hold(a, e.id, [e.seat('A1'), e.seat('A2'), e.seat('A3')]),
      hold(b, e.id, [e.seat('A3'), e.seat('A4'), e.seat('B1')]),
    ]);
    assert.deepEqual([ra.status, rb.status].sort(), [201, 409]);
    const loserSeats = ra.status === 201 ? [e.seat('A4'), e.seat('B1')] : [e.seat('A1'), e.seat('A2')];
    const { rows } = await query('SELECT status FROM seats WHERE id = ANY($1::bigint[])', [loserSeats]);
    assert.ok(rows.every((r) => r.status === 'available'), 'loser must not keep any seat');
  });

  test('RACE: forty shuffled overlapping requests, no deadlocks and no seat in two holds', async () => {
    const e = await makeEvent(organizer);
    const labels = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4'];
    const people = await Promise.all(Array.from({ length: 40 }, () => makeUser()));
    const results = await Promise.all(people.map((p) => {
      const pick = [...labels].sort(() => Math.random() - 0.5).slice(0, 3); // random order on purpose
      return hold(p, e.id, pick.map(e.seat));
    }));
    assert.ok(results.every((r) => r.status === 201 || r.body.error.code === 'SEATS_UNAVAILABLE'),
      `unexpected: ${JSON.stringify(results.filter((r) => ![201, 409].includes(r.status)).map((r) => r.body))}`);
    const { rows } = await query(
      `SELECT count(*)::int AS held, count(DISTINCT hold_id)::int AS holds FROM seats WHERE event_id = $1 AND status = 'held'`, [e.id]);
    const winners = results.filter((r) => r.status === 201);
    assert.equal(rows[0].holds, winners.length);
    assert.equal(rows[0].held, winners.length * 3);
  });

  test('picking again replaces your previous selection', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    await hold(me, e.id, [e.seat('A1')]);
    const second = await hold(me, e.id, [e.seat('A1'), e.seat('A2')]);
    assert.equal(second.status, 201);
    const { rows } = await query(`SELECT count(*)::int AS n FROM holds WHERE user_id = $1 AND status = 'active'`, [me.id]);
    assert.equal(rows[0].n, 1);
  });

  test('an expired hold frees its seats for the next person immediately', async () => {
    const e = await makeEvent(organizer);
    const [slow, fast] = await Promise.all([makeUser(), makeUser()]);
    const h = await hold(slow, e.id, [e.seat('B1')]);
    await query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [h.body.id]);
    assert.equal((await hold(fast, e.id, [e.seat('B1')])).status, 201);
    const late = await pay(slow, h.body.id);
    assert.equal(late.status, 410);
    assert.equal(late.body.error.code, 'HOLD_EXPIRED');
  });

  test('the sweeper releases seats from expired holds', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const h = await hold(me, e.id, [e.seat('B2')]);
    await query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [h.body.id]);
    const sweep = await api().post('/api/admin/sweep-holds').set(organizer.auth);
    assert.ok(sweep.body.expired >= 1);
    const { rows: [s] } = await query('SELECT status, hold_id FROM seats WHERE id = $1', [e.seat('B2')]);
    assert.deepEqual(s, { status: 'available', hold_id: null });
  });

  test('per-person limit counts tickets already bought', async () => {
    const e = await makeEvent(organizer, { maxPerOrder: 3 });
    const me = await makeUser();
    assert.equal((await hold(me, e.id, ['A1', 'A2', 'A3', 'A4'].map(e.seat))).body.error.code, 'TOO_MANY_SEATS');
    await buy(me, e, ['A1', 'A2']);
    assert.equal((await hold(me, e.id, [e.seat('B1'), e.seat('B2')])).body.error.code, 'TICKET_LIMIT');
  });

  test('drafts are invisible to customers and cannot be booked', async () => {
    const e = await makeEvent(organizer, { publish: false });
    const me = await makeUser();
    assert.equal((await api().get(`/api/events/${e.id}`).set(me.auth)).status, 404);
    assert.equal((await hold(me, e.id, [e.seat('A1')])).status, 404);
  });
});

describe('checkout', () => {
  test('paying turns the hold into an order with one ticket per seat', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const order = await buy(me, e, ['A1', 'B1']);
    assert.match(order.reference, /^ENC-[A-Z2-9]{6}$/);
    assert.equal(order.totalCents, 8000);
    assert.equal(order.tickets.length, 2);
    assert.ok(order.tickets.every((t) => t.valid && /^[A-Z2-9]{10}$/.test(t.code)));
    const { rows } = await query(`SELECT status FROM seats WHERE id = ANY($1::bigint[])`, [[e.seat('A1'), e.seat('B1')]]);
    assert.ok(rows.every((r) => r.status === 'sold'));
  });

  test('the same Idempotency-Key replays the first answer and never charges twice', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const h = await hold(me, e.id, [e.seat('A1')]);
    const key = crypto.randomUUID();
    const first = await pay(me, h.body.id, { key });
    const again = await pay(me, h.body.id, { key });
    assert.equal(first.status, 201);
    assert.equal(again.status, 201);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(again.body.reference, first.body.reference);
    const { rows } = await query('SELECT count(*)::int AS n FROM orders WHERE hold_id = $1', [h.body.id]);
    assert.equal(rows[0].n, 1);
  });

  test('RACE: a double-clicked pay button (same key, five at once) makes one order', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const h = await hold(me, e.id, [e.seat('A2')]);
    const key = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => pay(me, h.body.id, { key })));
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(new Set(results.map((r) => r.body.reference)).size, 1);
    assert.equal(results.filter((r) => r.headers['idempotent-replayed']).length, 4);
  });

  test('RACE: two tabs paying the same hold with different keys, one order', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const h = await hold(me, e.id, [e.seat('A3')]);
    const [a, b] = await Promise.all([pay(me, h.body.id), pay(me, h.body.id)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal((a.status === 409 ? a : b).body.error.code, 'HOLD_ALREADY_USED');
  });

  test('reusing a key for a different request is refused', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const h = await hold(me, e.id, [e.seat('A4')]);
    const key = crypto.randomUUID();
    await pay(me, h.body.id, { key });
    const other = await api().post('/api/orders').set(me.auth).set('Idempotency-Key', key)
      .send({ holdId: h.body.id, cardNumber: '5555 5555 5555 4444' });
    assert.equal(other.status, 422);
    assert.equal(other.body.error.code, 'IDEMPOTENCY_MISMATCH');
  });

  test('a declined card leaves the seats held; a new attempt with a good card works', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const h = await hold(me, e.id, [e.seat('B3')]);
    const key = crypto.randomUUID();
    const declined = await pay(me, h.body.id, { key, card: DECLINED_CARD });
    assert.equal(declined.status, 402);
    assert.equal(declined.body.error.code, 'PAYMENT_DECLINED');
    const replay = await pay(me, h.body.id, { key, card: DECLINED_CARD });
    assert.equal(replay.status, 402); // the decline is replayed, not re-attempted
    const { rows: [s] } = await query('SELECT status FROM seats WHERE id = $1', [e.seat('B3')]);
    assert.equal(s.status, 'held');
    assert.equal((await pay(me, h.body.id)).status, 201);
  });

  test('checkout needs an Idempotency-Key and a valid card number', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const h = await hold(me, e.id, [e.seat('B4')]);
    const noKey = await api().post('/api/orders').set(me.auth).send({ holdId: h.body.id, cardNumber: '4242424242424242' });
    assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal((await pay(me, h.body.id, { card: '4242 4242 4242 4241' })).body.error.code, 'CARD_INVALID');
  });

  test("you cannot pay for someone else's hold", async () => {
    const e = await makeEvent(organizer);
    const [me, thief] = await Promise.all([makeUser(), makeUser()]);
    const h = await hold(me, e.id, [e.seat('A1')]);
    assert.equal((await pay(thief, h.body.id)).status, 404);
  });

  test('the database itself refuses a second valid ticket for a seat', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const order = await buy(me, e, ['A1']);
    const { rows: [o] } = await query('SELECT id FROM orders WHERE reference = $1', [order.reference]);
    await assert.rejects(
      query(`INSERT INTO tickets (order_id, seat_id, code, price_cents) VALUES ($1, $2, 'FORGEDCODE', 1)`, [o.id, e.seat('A1')]),
      /tickets_one_valid_per_seat/);
  });
});

describe('after the sale', () => {
  test('refunds void the tickets and put the seats back on sale', async () => {
    const e = await makeEvent(organizer);
    const [me, next] = await Promise.all([makeUser(), makeUser()]);
    const order = await buy(me, e, ['A1']);
    const refund = await api().post(`/api/orders/${order.reference}/refund`).set(me.auth);
    assert.equal(refund.body.status, 'refunded');
    assert.equal(refund.body.tickets[0].valid, false);
    assert.equal((await hold(next, e.id, [e.seat('A1')])).status, 201);
    assert.equal((await api().post(`/api/orders/${order.reference}/refund`).set(me.auth)).body.error.code, 'ALREADY_REFUNDED');
  });

  test('refunds close 24 hours before the show', async () => {
    const e = await makeEvent(organizer, { startsAt: new Date(Date.now() + 5 * 3600000).toISOString() });
    const me = await makeUser();
    const order = await buy(me, e, ['A1']);
    const res = await api().post(`/api/orders/${order.reference}/refund`).set(me.auth);
    assert.equal(res.body.error.code, 'TOO_LATE_TO_REFUND');
  });

  test('door check-in: once only, and refunded tickets are void', async () => {
    const e = await makeEvent(organizer);
    const me = await makeUser();
    const order = await buy(me, e, ['B1', 'B2']);
    const [t1, t2] = order.tickets;
    const scan = (code) => api().post(`/api/events/${e.id}/check-in`).set(organizer.auth).send({ code });
    const ok = await scan(t1.code.toLowerCase());
    assert.equal(ok.status, 200);
    assert.equal(ok.body.seat, 'B1');
    const twice = await scan(t1.code);
    assert.equal(twice.body.error.code, 'ALREADY_CHECKED_IN');
    assert.equal((await api().post(`/api/orders/${order.reference}/refund`).set(me.auth)).body.error.code, 'ALREADY_USED');

    const other = await buy(me, e, ['A4']);
    await api().post(`/api/orders/${other.reference}/refund`).set(me.auth);
    assert.equal((await scan(other.tickets[0].code)).body.error.code, 'TICKET_VOID');
    assert.equal((await api().post(`/api/events/${e.id}/check-in`).set(me.auth).send({ code: t2.code })).status, 403);
  });

  test('cancelling an event refunds every order and drops every hold', async () => {
    const e = await makeEvent(organizer);
    const [a, b, c] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    await buy(a, e, ['A1']);
    await buy(b, e, ['A2', 'A3']);
    const h = await hold(c, e.id, [e.seat('B1')]);
    const res = await api().post(`/api/events/${e.id}/cancel`).set(organizer.auth);
    assert.equal(res.body.ordersRefunded, 2);
    const { rows } = await query(`SELECT status, count(*)::int AS n FROM orders WHERE event_id = $1 GROUP BY status`, [e.id]);
    assert.deepEqual(rows, [{ status: 'refunded', n: 2 }]);
    assert.equal((await pay(c, h.body.id)).body.error.code, 'EVENT_CANCELLED');
    assert.equal((await hold(c, e.id, [e.seat('B2')])).body.error.code, 'EVENT_CANCELLED');
  });

  test('the sales report adds up', async () => {
    const e = await makeEvent(organizer);
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    await buy(a, e, ['A1', 'A2']);
    const refunded = await buy(b, e, ['B1']);
    await api().post(`/api/orders/${refunded.reference}/refund`).set(b.auth);
    await hold(b, e.id, [e.seat('B2')]);
    const r = await api().get(`/api/events/${e.id}/report`).set(organizer.auth);
    assert.equal(r.body.orders, 1);
    assert.equal(r.body.revenueCents, 10000);
    assert.equal(r.body.refunds, 1);
    const front = r.body.tiers.find((t) => t.name === 'Front');
    const back = r.body.tiers.find((t) => t.name === 'Back');
    assert.deepEqual([front.sold, front.held, Number(front.sellThrough)], [2, 0, 50]);
    assert.deepEqual([back.sold, back.held], [0, 1]);
    const customer = await makeUser();
    assert.equal((await api().get(`/api/events/${e.id}/report`).set(customer.auth)).status, 403);
  });
});
