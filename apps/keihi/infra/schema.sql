-- keikhi : Postgres schema
-- Idempotent. Re-running is safe.

CREATE TABLE IF NOT EXISTS sites (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS records (
  id         BIGSERIAL PRIMARY KEY,
  date       DATE NOT NULL,
  store      TEXT NOT NULL DEFAULT '',
  total      INTEGER NOT NULL DEFAULT 0,
  category   TEXT NOT NULL DEFAULT '',
  work_type  TEXT NOT NULL DEFAULT '',
  payment    TEXT NOT NULL DEFAULT '',
  buyer      TEXT NOT NULL DEFAULT '',
  site       TEXT NOT NULL DEFAULT '',
  memo       TEXT NOT NULL DEFAULT '',
  image_url  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS records_date_idx ON records (date DESC);
CREATE INDEX IF NOT EXISTS records_site_idx ON records (site);

INSERT INTO sites (name) VALUES
  ('西新井焼肉屋'), ('宇佐美別荘'), ('倉庫改装'), ('共通')
ON CONFLICT (name) DO NOTHING;
