const crypto = require('crypto');
const { pool } = require('../db');
const { AppError } = require('../errors');
const { toAppError } = require('./errors');

/**
 * Makes a POST safe to retry. The client sends an `Idempotency-Key` header
 * (any unique string, usually a UUID it generated). Then:
 *
 *  - first request with a key: runs the handler and stores the response
 *  - same key again: replays the stored response; the handler does NOT run again
 *  - same key, different body: 422, because that is a client bug
 *  - same key at the same moment: the second waits on the key's row lock,
 *    then replays the first one's answer
 *
 * The key row and the handler's writes share ONE transaction, so either both
 * commit or neither does. A savepoint lets a business error (say, a declined
 * card) be stored and replayed while rolling back any partial writes.
 * Server errors (5xx) are not stored, so the client may retry them.
 *
 * Usage: router.post('/x', idempotent(async (client, req) => ({ status: 201, body })))
 */
function idempotent(handler) {
  return async (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 100) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (a unique id per attempt to pay).');
    }
    const hash = crypto.createHash('sha256')
      .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`).digest('hex');

    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [req.user.id, key, hash]);
      // Concurrent duplicates block here until the first transaction finishes.
      const { rows: [row] } = await client.query(
        'SELECT * FROM idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE', [req.user.id, key]);

      if (row.request_hash !== hash) {
        await client.query('ROLLBACK');
        throw new AppError(422, 'IDEMPOTENCY_MISMATCH', 'That Idempotency-Key was already used for a different request.');
      }
      if (row.status_code !== null) {
        await client.query('COMMIT');
        outcome = { status: row.status_code, body: row.response, replayed: true };
      } else {
        await client.query('SAVEPOINT work');
        try {
          outcome = await handler(client, req);
        } catch (err) {
          const appErr = toAppError(err);
          if (appErr.status >= 500) throw appErr;
          await client.query('ROLLBACK TO SAVEPOINT work');
          outcome = { status: appErr.status, body: { error: { code: appErr.code, message: appErr.message, details: appErr.details } } };
        }
        await client.query('UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2',
          [req.user.id, key, outcome.status, outcome.body]);
        await client.query('COMMIT');
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (outcome.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(outcome.status).json(outcome.body);
  };
}

module.exports = { idempotent };
