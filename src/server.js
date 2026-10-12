const config = require('./config');
const { createApp } = require('./app');
const { pool, transaction } = require('./db');
const { sweepExpiredHolds } = require('./modules/holds/service');

const server = createApp().listen(config.port, () => {
  console.log(`Encore running at http://localhost:${config.port}  (API docs: /api/docs)`);
});

// Background job: expired holds release their seats.
const timer = setInterval(() => {
  transaction(sweepExpiredHolds)
    .then((n) => n && console.log(`Released seats from ${n} expired hold(s)`))
    .catch(console.error);
}, config.sweepSeconds * 1000);

function shutdown() {
  clearInterval(timer);
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
