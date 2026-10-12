// Central configuration from environment variables, with development defaults.
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  port: Number(process.env.PORT || 3003),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5543/encore',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  refundCutoffHours: Number(process.env.REFUND_CUTOFF_HOURS || 24),
  sweepSeconds: Number(process.env.HOLD_SWEEP_SECONDS || 30),
};

if (env === 'production' && config.jwtSecret === 'dev-only-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = config;
