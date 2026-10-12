const crypto = require('crypto');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { pool, query } = require('../src/db');
const { signToken } = require('../src/middleware/auth');

const app = createApp();
const api = () => request(app);

const GOOD_CARD = '4242 4242 4242 4242';
const DECLINED_CARD = '4000 0000 0000 0002';

let seq = 0;
const HASH = bcrypt.hashSync('password123', 4);

async function reset() {
  await query('TRUNCATE audit_log, idempotency_keys, tickets, orders, seats, holds, tiers, events, users RESTART IDENTITY CASCADE');
}

async function makeUser(role = 'customer') {
  seq += 1;
  const { rows: [u] } = await query(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
    [`${role} ${seq}`, `${role}${seq}@test.local`, HASH, role]);
  return { ...u, auth: { Authorization: `Bearer ${signToken(u)}` } };
}

/** Creates and publishes an event. Default layout: row A (4 seats, $50), row B (4 seats, $30). */
async function makeEvent(organizer, overrides = {}) {
  const body = {
    title: `Show ${++seq}`, venue: 'Test Hall',
    startsAt: new Date(Date.now() + 10 * 86400000).toISOString(),
    maxPerOrder: 6, holdMinutes: 8,
    tiers: [
      { name: 'Front', priceCents: 5000, rows: ['A'], seatsPerRow: 4 },
      { name: 'Back', priceCents: 3000, rows: ['B'], seatsPerRow: 4 },
    ],
    ...overrides,
  };
  const created = await api().post('/api/events').set(organizer.auth).send(body);
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  if (overrides.publish !== false) await api().post(`/api/events/${created.body.id}/publish`).set(organizer.auth);
  const detail = await api().get(`/api/events/${created.body.id}`).set(organizer.auth);
  // seat lookup by label, e.g. seat('A1')
  const byLabel = Object.fromEntries(detail.body.seats.map((s) => [`${s.row}${s.number}`, s.id]));
  return { ...detail.body, seat: (label) => byLabel[label] };
}

const hold = (user, eventId, seatIds) => api().post('/api/holds').set(user.auth).send({ eventId, seatIds });

const pay = (user, holdId, { key = crypto.randomUUID(), card = GOOD_CARD } = {}) =>
  api().post('/api/orders').set(user.auth).set('Idempotency-Key', key).send({ holdId, cardNumber: card });

/** Hold and pay in one go; returns the order. */
async function buy(user, event, labels) {
  const h = await hold(user, event.id, labels.map(event.seat));
  if (h.status !== 201) throw new Error(JSON.stringify(h.body));
  const o = await pay(user, h.body.id);
  if (o.status !== 201) throw new Error(JSON.stringify(o.body));
  return o.body;
}

const close = () => pool.end();

module.exports = { api, reset, makeUser, makeEvent, hold, pay, buy, query, close, GOOD_CARD, DECLINED_CARD };
