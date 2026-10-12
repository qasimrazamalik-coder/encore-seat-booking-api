const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yaml');
const { query, transaction } = require('./db');
const { authenticate, requireOrganizer } = require('./middleware/auth');
const { errorHandler, notFoundRoute } = require('./middleware/errors');
const { sweepExpiredHolds } = require('./modules/holds/service');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
      },
    },
  }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (_req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api/auth', require('./modules/auth/routes').router);
  app.use('/api/events', require('./modules/events/routes').router);
  app.use('/api/holds', authenticate, require('./modules/holds/routes').router);
  app.use('/api/orders', authenticate, require('./modules/orders/routes').router);
  // Lets an organizer (or a test) run the hold sweeper on demand.
  app.post('/api/admin/sweep-holds', authenticate, requireOrganizer, async (_req, res) => {
    res.json({ expired: await transaction(sweepExpiredHolds) });
  });

  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.yaml'), 'utf8'));
  app.get('/api/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Encore API' }));

  app.use('/api', notFoundRoute);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
