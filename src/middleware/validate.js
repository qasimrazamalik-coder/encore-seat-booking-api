const { badRequest } = require('../errors');

/**
 * Validates req[part] against a zod schema and replaces it with the parsed
 * (coerced, defaulted) value. Usage: validate({ body: schema, query: schema })
 */
const validate = (schemas) => (req, _res, next) => {
  for (const [part, schema] of Object.entries(schemas)) {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ field: i.path.join('.') || part, message: i.message }));
      return next(badRequest('VALIDATION_FAILED', 'Some fields need fixing.', details));
    }
    // Express 5 makes req.query read-only, so parsed values live on req.valid.
    req.valid = req.valid || {};
    req.valid[part] = result.data;
  }
  next();
};

module.exports = { validate };
