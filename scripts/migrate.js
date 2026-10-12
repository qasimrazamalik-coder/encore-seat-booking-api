// Applies db/migrations/*.sql in filename order, each in its own transaction,
// and records what ran in schema_migrations so re-running is safe.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../src/config');

async function migrate(databaseUrl = config.databaseUrl, { quiet = false } = {}) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        if (!quiet) console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    if (!quiet) console.log('Database is up to date.');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { migrate };
