// Demo data: an organizer, two customers, three upcoming events with real
// seating plans, and a part-sold house so the seat map has some texture.
// Safe to re-run: it wipes and reloads.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const config = require('../src/config');
const { code } = require('../src/modules/orders/service');

const days = (n, hour = 20) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const events = [
  {
    title: 'An Evening of Qawwali', venue: 'Main Hall, City Arts Centre', startsAt: days(9),
    description: 'A three-hour programme of classic and contemporary qawwali with a full party.',
    tiers: [
      { name: 'Front stalls', priceCents: 450000, rows: ['A', 'B', 'C'], seats: 14 },
      { name: 'Stalls', priceCents: 300000, rows: ['D', 'E', 'F', 'G'], seats: 16 },
      { name: 'Rear', priceCents: 150000, rows: ['H', 'J'], seats: 18 },
    ],
    soldShare: 0.42,
  },
  {
    title: 'Short Film Night', venue: 'Studio Two', startsAt: days(4, 19),
    description: 'Eight short films by first-time directors, followed by a Q&A.',
    tiers: [{ name: 'General', priceCents: 80000, rows: ['A', 'B', 'C', 'D', 'E'], seats: 10 }],
    soldShare: 0.7,
  },
  {
    title: 'Jazz Trio at Closing Time', venue: 'The Rooftop Room', startsAt: days(21, 21),
    description: 'Standards, a few originals, and one long encore.',
    tiers: [
      { name: 'Tables', priceCents: 350000, rows: ['A', 'B'], seats: 8 },
      { name: 'Bar seats', priceCents: 200000, rows: ['C', 'D', 'E'], seats: 12 },
    ],
    soldShare: 0.15,
  },
];

(async () => {
  const db = new Client({ connectionString: config.databaseUrl });
  await db.connect();
  await db.query('BEGIN');
  await db.query('TRUNCATE audit_log, idempotency_keys, tickets, orders, seats, holds, tiers, events, users RESTART IDENTITY CASCADE');

  const hash = await bcrypt.hash('password123', 10);
  const user = async (name, email, role = 'customer') => (await db.query(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id;
  const organizer = await user('Encore Live', 'organizer@encore.test', 'organizer');
  await user('Zainab Hussain', 'zainab@encore.test');
  await user('Ali Raza', 'ali@encore.test');
  const crowd = [];
  for (let i = 1; i <= 12; i++) crowd.push(await user(`Guest ${i}`, `guest${i}@encore.test`));

  // A tiny deterministic random so the sold pattern is the same on every seed.
  let s = 42;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);

  for (const ev of events) {
    const { rows: [e] } = await db.query(
      `INSERT INTO events (organizer_id, title, description, venue, starts_at, status) VALUES ($1, $2, $3, $4, $5, 'on_sale') RETURNING id`,
      [organizer, ev.title, ev.description, ev.venue, ev.startsAt]);
    for (const t of ev.tiers) {
      const { rows: [tier] } = await db.query('INSERT INTO tiers (event_id, name, price_cents) VALUES ($1, $2, $3) RETURNING id', [e.id, t.name, t.priceCents]);
      await db.query(`INSERT INTO seats (event_id, tier_id, row_label, number)
                      SELECT $1, $2, r, n FROM unnest($3::text[]) r, generate_series(1, $4::int) n`, [e.id, tier.id, t.rows, t.seats]);
    }
    // Sell seats in small groups of neighbours, like real bookings.
    const { rows: seats } = await db.query(
      `SELECT s.id, t.price_cents FROM seats s JOIN tiers t ON t.id = s.tier_id WHERE s.event_id = $1 ORDER BY s.row_label, s.number`, [e.id]);
    let i = 0;
    while (i < seats.length) {
      const size = 1 + Math.floor(rand() * 4);
      const group = seats.slice(i, i + size);
      i += size + Math.floor(rand() * 3);
      if (rand() > ev.soldShare) continue;
      const buyer = crowd[Math.floor(rand() * crowd.length)];
      const { rows: [h] } = await db.query(
        `INSERT INTO holds (event_id, user_id, status, expires_at, created_at)
         VALUES ($1, $2, 'converted', now() - interval '2 days', now() - interval '2 days') RETURNING id`, [e.id, buyer]);
      const total = group.reduce((n, g) => n + g.price_cents, 0);
      const { rows: [o] } = await db.query(
        `INSERT INTO orders (reference, user_id, event_id, hold_id, total_cents, payment_ref, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7::int)) RETURNING id`,
        [`ENC-${code(6)}`, buyer, e.id, h.id, total, `pay_seed_${crypto.randomBytes(4).toString('hex')}`, 1 + Math.floor(rand() * 10)]);
      for (const g of group) {
        await db.query('INSERT INTO tickets (order_id, seat_id, code, price_cents) VALUES ($1, $2, $3, $4)', [o.id, g.id, code(10), g.price_cents]);
      }
      await db.query(`UPDATE seats SET status = 'sold' WHERE id = ANY($1::bigint[])`, [group.map((g) => g.id)]);
    }
  }

  // One draft, visible only to the organizer.
  await db.query(
    `INSERT INTO events (organizer_id, title, venue, starts_at) VALUES ($1, 'Poetry Open Mic (draft)', 'Studio Two', $2)`,
    [organizer, days(30, 18)]);

  await db.query('COMMIT');
  await db.end();
  console.log('Seeded. Sign in with any of these (password: password123):');
  console.log('  organizer@encore.test   organizer: door check-in and sales reports');
  console.log('  zainab@encore.test      customer');
  console.log('  ali@encore.test         customer');
  console.log('Test cards: 4242 4242 4242 4242 pays, 4000 0000 0000 0002 is declined.');
})().catch((err) => { console.error(err); process.exit(1); });
