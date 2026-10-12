// Starts a real PostgreSQL server for development, with no system install.
// Data persists in ./.pgdata between runs. Leave this running in its own terminal.
// If you already have PostgreSQL (or Docker), skip this and set DATABASE_URL instead.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const EmbeddedPostgres = require('embedded-postgres').default;
const config = require('../src/config');

const url = new URL(config.databaseUrl);
const dbName = url.pathname.slice(1);
const dataDir = path.join(__dirname, '..', '.pgdata');

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: url.username || 'postgres',
    password: url.password || 'postgres',
    port: Number(url.port || 5432),
    persistent: true,
    onLog: () => {},
  });

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();

  const admin = new Client({ host: 'localhost', port: url.port, user: url.username, password: url.password, database: 'postgres' });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rows.length) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  console.log(`PostgreSQL is running on port ${url.port}, database "${dbName}". Press Ctrl+C to stop.`);
  const stop = async () => { await pg.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((err) => { console.error('Could not start PostgreSQL:', err.message); process.exit(1); });
