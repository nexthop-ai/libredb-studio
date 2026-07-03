-- migrate:up

-- New service: no data to preserve. Drop the legacy single-table storage and
-- create the OIDC schema (app_user + db_connection). Idempotent via IF EXISTS /
-- IF NOT EXISTS so a re-run is a no-op.

DROP TABLE IF EXISTS user_storage;

-- Per-user data blob (all StorageData collections except connections). `id` is
-- the surrogate key; `email` is a unique natural key stored lowercase; `data`
-- is JSONB for atomic partial updates.
CREATE TABLE IF NOT EXISTS app_user (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  role       TEXT NOT NULL DEFAULT 'user',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Shared, group-scoped DB connections, keyed by connection id.
CREATE TABLE IF NOT EXISTS db_connection (
  id         TEXT PRIMARY KEY,
  user_group TEXT,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down

DROP TABLE IF EXISTS db_connection;
DROP TABLE IF EXISTS app_user;

CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, collection)
);
