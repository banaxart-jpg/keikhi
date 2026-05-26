#!/usr/bin/env bash
# ============================================================
#  kotonoha: シード問題 (apps/keihi/infra/kotonoha-seed.json) を
#  Cloud SQL の kotonoha_questions テーブルに流し込む。
#  - source='seed' の既存行を一度クリア → 再挿入 (再実行安全)
#  - source='generated' (AI生成) は触らない
#  Usage:
#    ./infra/seed-kotonoha.sh
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
JSON_FILE="$ROOT/apps/keihi/infra/kotonoha-seed.json"

if [[ ! -f "$JSON_FILE" ]]; then
  echo "seed file not found: $JSON_FILE" >&2
  exit 1
fi

JSON_DATA="$(cat "$JSON_FILE")"

"$HERE/db.sh" keihi -v "json=$JSON_DATA" <<'EOSQL'
BEGIN;

DELETE FROM kotonoha_questions WHERE source = 'seed';

INSERT INTO kotonoha_questions
  (category, difficulty, type, question, options, answer, keywords, explanation, claude_example, source)
SELECT
  category, difficulty, type, question,
  CASE WHEN type = 'choice' THEN options ELSE NULL END,
  answer,
  COALESCE(keywords, '[]'::jsonb),
  explanation,
  COALESCE(claude_example, ''),
  'seed'
FROM jsonb_to_recordset(:'json'::jsonb)
  AS x(
    category       text,
    difficulty     int,
    type           text,
    question       text,
    options        jsonb,
    answer         text,
    keywords       jsonb,
    explanation    text,
    claude_example text
  );

COMMIT;

SELECT category, count(*) AS n
  FROM kotonoha_questions
 WHERE source = 'seed'
 GROUP BY category
 ORDER BY category;
EOSQL
