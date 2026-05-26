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

-- ──────────────────────────────────────────
-- kotonoha : Claude Code で開発するための「概念・用語の語彙」を
-- 一問一答形式で身につけるミニアプリ。
-- 10問1セット、選択肢 + 自由記述 (AI 意味判定)、レベル自動調整。
-- ──────────────────────────────────────────

-- 問題プール（シード問題 + AI動的生成された問題）
CREATE TABLE IF NOT EXISTS kotonoha_questions (
  id            BIGSERIAL PRIMARY KEY,
  category      TEXT NOT NULL,                       -- ui|db|api|ai|infra|concept|project|prompt
  difficulty    INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 10),
  type          TEXT NOT NULL CHECK (type IN ('choice', 'free')),
  question      TEXT NOT NULL,
  options       JSONB,                               -- choice の場合の選択肢配列 ["A","B","C","D"]
  answer        TEXT NOT NULL,                       -- 正解（choice なら選択肢の値、free なら正解語）
  keywords      JSONB,                               -- free の場合の同義語リスト（フォールバック判定用）
  explanation   TEXT NOT NULL,                       -- 解説（用語の意味）
  claude_example TEXT,                               -- Claude Code への指示例
  image_url     TEXT,                                -- 任意。UI 部品など視覚的な問題に画像 URL を付ける
  source        TEXT DEFAULT 'seed',                 -- seed | generated
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kotonoha_q_category_idx ON kotonoha_questions (category, difficulty);

-- ユーザーごとの解答履歴
CREATE TABLE IF NOT EXISTS kotonoha_progress (
  id           BIGSERIAL PRIMARY KEY,
  user_email   TEXT NOT NULL,
  question_id  BIGINT NOT NULL REFERENCES kotonoha_questions(id) ON DELETE CASCADE,
  is_correct   BOOLEAN NOT NULL,
  user_answer  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 1,            -- 同じ問題に何回目のチャレンジか
  answered_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kotonoha_p_user_idx     ON kotonoha_progress (user_email, answered_at DESC);
CREATE INDEX IF NOT EXISTS kotonoha_p_user_q_idx   ON kotonoha_progress (user_email, question_id, answered_at DESC);

-- ユーザーごとの現在レベル + 表示設定
CREATE TABLE IF NOT EXISTS kotonoha_users (
  user_email     TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,                       -- メアド@前の部分がデフォルト
  level          INTEGER NOT NULL DEFAULT 1,
  total_correct  INTEGER NOT NULL DEFAULT 0,
  total_answers  INTEGER NOT NULL DEFAULT 0,
  visible_to_peers BOOLEAN NOT NULL DEFAULT true,     -- 他のメンバーに進捗を見せる
  last_session_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
