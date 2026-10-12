const { Pool, types } = require('pg');
const config = require('./config');

types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number

const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
pool.on('error', (err) => console.error('Unexpected idle client error', err));

const query = (text, params) => pool.query(text, params);

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function audit(client, actorId, action, entity, entityId, details = {}) {
  return client.query(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, entity, entityId == null ? null : String(entityId), details]);
}

module.exports = { pool, query, transaction, audit };
