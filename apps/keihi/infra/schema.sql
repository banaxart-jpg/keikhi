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

-- ──────────────────────────────────────────
-- kaigi : 3者AI協働検討の会話永続化
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kaigi_sessions (
  id                    BIGSERIAL PRIMARY KEY,
  user_email            TEXT NOT NULL,
  topic                 TEXT NOT NULL,
  speakers              JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'auto' | 'completed' | 'failed'
  auto_rounds_remaining INTEGER NOT NULL DEFAULT 0,        -- B: Cloud Tasks 自動進行で残ラウンド数
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kaigi_messages (
  id            BIGSERIAL PRIMARY KEY,
  session_id    BIGINT NOT NULL REFERENCES kaigi_sessions(id) ON DELETE CASCADE,
  speaker       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  content       TEXT NOT NULL,
  model_used    TEXT,
  round_num     INTEGER NOT NULL,
  seq           INTEGER NOT NULL,        -- セッション内 通し番号 (0 始まり)
  is_conclusion BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kaigi_messages_session_idx ON kaigi_messages (session_id, seq);
CREATE INDEX IF NOT EXISTS kaigi_sessions_user_idx    ON kaigi_sessions (user_email, updated_at DESC);

-- 延長フロー（結論→不満→議題編集→もう3ラウンド）対応
ALTER TABLE kaigi_sessions ADD COLUMN IF NOT EXISTS extension_count INT NOT NULL DEFAULT 0;
ALTER TABLE kaigi_messages ADD COLUMN IF NOT EXISTS is_system_note  BOOLEAN NOT NULL DEFAULT false;

-- 長いお題（人生略歴等）対応。AI に渡す短い要約版を別途保存し、本文はメッセージ履歴の system note として保持して圧縮対象に。
ALTER TABLE kaigi_sessions ADD COLUMN IF NOT EXISTS topic_summary TEXT;

-- 結論後のユーザー <-> アシスタントAI (Gemini Flash) チャット用フラグ
-- 議論本体には影響させず、別レーンとして扱う
ALTER TABLE kaigi_messages ADD COLUMN IF NOT EXISTS is_chat BOOLEAN NOT NULL DEFAULT false;
