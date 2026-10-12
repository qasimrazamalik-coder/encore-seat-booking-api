// Domain errors carry an HTTP status and a stable machine-readable code.
// The frontend and tests rely on `code`, never on the message text.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, msg, details) => new AppError(400, code, msg, details);
const unauthorized = (msg = 'Sign in to continue.') => new AppError(401, 'UNAUTHENTICATED', msg);
const forbidden = (msg = 'You do not have permission to do that.') => new AppError(403, 'FORBIDDEN', msg);
const notFound = (what) => new AppError(404, 'NOT_FOUND', `${what} not found.`);
const conflict = (code, msg, details) => new AppError(409, code, msg, details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
