// `npm test`: boots a throwaway PostgreSQL, migrates it, runs the suite with
// node's built-in test runner, then tears everything down.
// Set TEST_DATABASE_URL to use an existing server instead.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { migrate } = require('./migrate');

async function withEmbedded(fn) {
  const EmbeddedPostgres = require('embedded-postgres').default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-test-'));
  const port = 15000 + Math.floor(Math.random() * 1000);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  try {
    return await fn(`postgres://postgres:postgres@localhost:${port}`);
  } finally {
    await pg.stop();
  }
}

async function run(serverUrl) {
  const dbName = 'encore_test';
  const admin = new Client({ connectionString: `${serverUrl}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const databaseUrl = `${serverUrl}/${dbName}`;
  await migrate(databaseUrl, { quiet: true });

  const testDir = path.join(__dirname, '..', 'tests');
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).map((f) => path.join(testDir, f));
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, JWT_SECRET: 'test-secret' },
  });
  return result.status ?? 1;
}

(async () => {
  const external = process.env.TEST_DATABASE_URL;
  const code = external ? await run(external.replace(/\/[^/]*$/, '')) : await withEmbedded(run);
  process.exit(code);
})().catch((err) => { console.error(err); process.exit(1); });
