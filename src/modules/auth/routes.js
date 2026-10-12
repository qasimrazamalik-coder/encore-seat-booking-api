const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query } = require('../../db');
const { validate } = require('../../middleware/validate');
const { signToken, authenticate } = require('../../middleware/auth');
const { unauthorized, notFound } = require('../../errors');
const config = require('../../config');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: () => config.env === 'test',
  handler: (_req, res) => res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again in 15 minutes.' } }),
});

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

// Self-registration always creates customers. Organizer accounts are seeded or promoted.
router.post('/register', limiter, validate({ body: z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Use at least 8 characters.').max(72),
}) }), async (req, res) => {
  const { name, email, password } = req.valid.body;
  const { rows: [u] } = await query(
    'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *', [name, email, await bcrypt.hash(password, 10)]);
  res.status(201).json({ token: signToken(u), user: publicUser(u) });
});

router.post('/login', limiter, validate({ body: z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) }) }),
  async (req, res) => {
    const { rows: [u] } = await query('SELECT * FROM users WHERE lower(email) = $1', [req.valid.body.email]);
    if (!u || !(await bcrypt.compare(req.valid.body.password, u.password_hash))) throw unauthorized('Email or password is incorrect.');
    res.json({ token: signToken(u), user: publicUser(u) });
  });

router.get('/me', authenticate, async (req, res) => {
  const { rows: [u] } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!u) throw notFound('Account');
  res.json(publicUser(u));
});

module.exports = { router };
