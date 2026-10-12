# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through GitHub instead: **Security → Report a vulnerability** on this repository. You will get a reply within a few days, and a fix or a mitigation plan once the report is confirmed.

Useful things to include: what an attacker could do, the steps or request that show it, and the commit you tested.

## Supported versions

Only the latest commit on `main` is maintained.

## Running it safely

This project ships with **development defaults** so it starts with no setup. Before exposing it anywhere:

- Set `JWT_SECRET` (and any other secret listed in `.env.example`) to a long random value. The server refuses to start in production with the development defaults.
- Never commit a `.env` file; it is ignored by git on purpose.
- The demo accounts created by `npm run setup` all use the password `password123`. They are for local use only; do not run the seed script against a real database.
- Put the app behind HTTPS.

## What is already in place

- Passwords hashed with bcrypt; JWT sessions with an expiry
- Request bodies, parameters and query strings validated with zod
- Parameterised SQL everywhere (no queries built from user input)
- Security headers and a strict Content Security Policy via helmet
- Rate limiting on sign-in and registration
- Database constraints that enforce the business rules even if application code has a bug
- Dependabot updates and `npm audit` in CI
