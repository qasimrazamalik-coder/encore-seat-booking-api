const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized, forbidden } = require('../errors');

function signToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, name: user.name }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

function readToken(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  const p = jwt.verify(token, config.jwtSecret);
  return { id: Number(p.sub), role: p.role, name: p.name };
}

function authenticate(req, _res, next) {
  try {
    req.user = readToken(req);
    if (!req.user) return next(unauthorized());
    next();
  } catch {
    next(unauthorized('Your session has expired. Sign in again.'));
  }
}

/** Browsing events works signed out; when signed in we show "your" held seats. */
function optionalAuth(req, _res, next) {
  try { req.user = readToken(req); } catch { req.user = null; }
  next();
}

const requireOrganizer = (req, _res, next) =>
  req.user?.role === 'organizer' ? next() : next(forbidden('Only organizers can do that.'));

module.exports = { signToken, authenticate, optionalAuth, requireOrganizer };
