-- Encore: event seat booking with no double-booking.
--
-- The booking flow is: pick seats -> HOLD them for a few minutes -> CHECKOUT
-- (pay) -> ORDER with one TICKET per seat. Correctness is defended twice:
-- row locks in the application, and constraints in the schema that make a
-- double sale impossible even if the application had a bug.
-- gen_random_uuid() is built into PostgreSQL 13+, so no extensions are needed.

CREATE TYPE user_role    AS ENUM ('customer', 'organizer');
CREATE TYPE event_status AS ENUM ('draft', 'on_sale', 'cancelled');
CREATE TYPE seat_status  AS ENUM ('available', 'held', 'sold');
CREATE TYPE hold_status  AS ENUM ('active', 'converted', 'released', 'expired');
CREATE TYPE order_status AS ENUM ('paid', 'refunded');

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  role          user_role   NOT NULL DEFAULT 'customer',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE events (
  id             BIGSERIAL PRIMARY KEY,
  organizer_id   BIGINT       NOT NULL REFERENCES users(id),
  title          TEXT         NOT NULL,
  description    TEXT         NOT NULL DEFAULT '',
  venue          TEXT         NOT NULL,
  starts_at      TIMESTAMPTZ  NOT NULL,
  status         event_status NOT NULL DEFAULT 'draft',
  max_per_order  INT          NOT NULL DEFAULT 6 CHECK (max_per_order BETWEEN 1 AND 20),
  hold_minutes   INT          NOT NULL DEFAULT 8 CHECK (hold_minutes BETWEEN 1 AND 60),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Price tiers per event (e.g. Stalls, Circle). Seats point at a tier.
CREATE TABLE tiers (
  id          BIGSERIAL PRIMARY KEY,
  event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,
  price_cents INT    NOT NULL CHECK (price_cents >= 0),
  UNIQUE (event_id, name)
);

CREATE TABLE holds (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   BIGINT      NOT NULL REFERENCES events(id),
  user_id    BIGINT      NOT NULL REFERENCES users(id),
  status     hold_status NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX holds_active_expiry_idx ON holds (expires_at) WHERE status = 'active';
CREATE INDEX holds_user_event_idx    ON holds (user_id, event_id) WHERE status = 'active';

CREATE TABLE seats (
  id         BIGSERIAL PRIMARY KEY,
  event_id   BIGINT      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tier_id    BIGINT      NOT NULL REFERENCES tiers(id),
  row_label  TEXT        NOT NULL,
  number     INT         NOT NULL,
  status     seat_status NOT NULL DEFAULT 'available',
  hold_id    UUID        REFERENCES holds(id),
  UNIQUE (event_id, row_label, number),
  -- A held seat always names its hold; a free one never does.
  CHECK ((status = 'held') = (hold_id IS NOT NULL))
);
CREATE INDEX seats_event_idx ON seats (event_id, row_label, number);
CREATE INDEX seats_hold_idx  ON seats (hold_id) WHERE hold_id IS NOT NULL;

CREATE TABLE orders (
  id          BIGSERIAL PRIMARY KEY,
  reference   TEXT         NOT NULL UNIQUE,     -- what the customer quotes, e.g. ENC-7F3K2Q
  user_id     BIGINT       NOT NULL REFERENCES users(id),
  event_id    BIGINT       NOT NULL REFERENCES events(id),
  hold_id     UUID         NOT NULL UNIQUE REFERENCES holds(id),  -- one order per hold, ever
  total_cents INT          NOT NULL CHECK (total_cents >= 0),
  status      order_status NOT NULL DEFAULT 'paid',
  payment_ref TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  refunded_at TIMESTAMPTZ
);
CREATE INDEX orders_user_idx  ON orders (user_id, created_at DESC);
CREATE INDEX orders_event_idx ON orders (event_id);

CREATE TABLE tickets (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT      NOT NULL REFERENCES orders(id),
  seat_id       BIGINT      NOT NULL REFERENCES seats(id),
  code          TEXT        NOT NULL UNIQUE,     -- printed on the ticket, scanned at the door
  price_cents   INT         NOT NULL,
  valid         BOOLEAN     NOT NULL DEFAULT true,
  checked_in_at TIMESTAMPTZ
);
-- The last line of defence: one valid ticket per seat, enforced by the database.
CREATE UNIQUE INDEX tickets_one_valid_per_seat ON tickets (seat_id) WHERE valid;

-- Idempotency keys make "pay" safe to retry: same key, same answer, one charge.
CREATE TABLE idempotency_keys (
  user_id      BIGINT      NOT NULL REFERENCES users(id),
  key          TEXT        NOT NULL,
  request_hash TEXT        NOT NULL,
  status_code  INT,
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE audit_log (
  id        BIGSERIAL PRIMARY KEY,
  actor_id  BIGINT REFERENCES users(id),
  action    TEXT        NOT NULL,
  entity    TEXT        NOT NULL,
  entity_id TEXT,
  details   JSONB       NOT NULL DEFAULT '{}',
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
