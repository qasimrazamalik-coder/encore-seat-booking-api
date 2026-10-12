const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, close } = require('./helpers');

before(reset);
after(close);

describe('auth and roles', () => {
  test('registering always makes a customer, and login works case-insensitively', async () => {
    const reg = await api().post('/api/auth/register').send({ name: 'Mehwish', email: 'Mehwish@x.io', password: 'longenough', role: 'organizer' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.role, 'customer');
    const login = await api().post('/api/auth/login').send({ email: 'MEHWISH@x.io', password: 'longenough' });
    assert.equal(login.status, 200);
    const bad = await api().post('/api/auth/login').send({ email: 'mehwish@x.io', password: 'nope-nope' });
    assert.equal(bad.status, 401);
  });

  test('only organizers create events; browsing needs no account', async () => {
    const customer = await makeUser();
    const res = await api().post('/api/events').set(customer.auth).send({});
    assert.equal(res.status, 403);
    assert.equal((await api().get('/api/events')).status, 200);
    assert.equal((await api().post('/api/holds').send({ eventId: 1, seatIds: [1] })).status, 401);
  });

  test('event layouts are validated', async () => {
    const org = await makeUser('organizer');
    const past = await api().post('/api/events').set(org.auth).send({
      title: 'Old', venue: 'Hall', startsAt: '2001-01-01T19:00:00Z',
      tiers: [{ name: 'All', priceCents: 100, rows: ['A'], seatsPerRow: 5 }],
    });
    assert.equal(past.body.error.code, 'START_IN_PAST');
    const badRow = await api().post('/api/events').set(org.auth).send({
      title: 'Show', venue: 'Hall', startsAt: new Date(Date.now() + 86400000).toISOString(),
      tiers: [{ name: 'All', priceCents: 100, rows: ['a1'], seatsPerRow: 5 }],
    });
    assert.equal(badRow.status, 400);
    const dupRow = await api().post('/api/events').set(org.auth).send({
      title: 'Show', venue: 'Hall', startsAt: new Date(Date.now() + 86400000).toISOString(),
      tiers: [{ name: 'X', priceCents: 100, rows: ['A'], seatsPerRow: 5 }, { name: 'Y', priceCents: 50, rows: ['A'], seatsPerRow: 5 }],
    });
    assert.equal(dupRow.body.error.code, 'DUPLICATE_SEAT');
  });
});
