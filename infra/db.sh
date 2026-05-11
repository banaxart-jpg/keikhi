#!/usr/bin/env bash
# ============================================================
#  keikhi : Cloud SQL ヘルパー
#  パスワード入力なしで psql を起動する。Cloud Shell 内で動く。
#  Usage:
#    ./infra/db.sh keihi                       # 対話 psql
#    ./infra/db.sh keihi < schema.sql          # ファイルを流す
#    ./infra/db.sh keihi -c "\dt"              # 1コマンド
#    ./infra/db.sh keihi -c "SELECT * FROM records LIMIT 5"
# ============================================================
set -euo pipefail

APP="${1:-}"
if [[ -z "$APP" ]]; then
  echo "Usage: $0 <app-name> [psql args...]" >&2
  echo "Example:" >&2
  echo "  $0 keihi" >&2
  echo "  $0 keihi -c '\\dt'" >&2
  echo "  $0 keihi < apps/keihi/infra/schema.sql" >&2
  exit 1
fi
shift

REGION="${REGION:-asia-northeast1}"
DB_INSTANCE="${DB_INSTANCE:-keikhi-db}"
DB_USER="${DB_USER:-$APP}"
DB_NAME="${DB_NAME:-$APP}"
SECRET="${DB_PW_SECRET:-${APP}-db-password}"
PROJECT="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"

PROXY="$(command -v cloud-sql-proxy || true)"
if [[ -z "$PROXY" ]]; then
  echo "cloud-sql-proxy not found. Run this from Cloud Shell (it's pre-installed)" >&2
  echo "or install: https://cloud.google.com/sql/docs/postgres/connect-auth-proxy" >&2
  exit 1
fi

PORT="$((5400 + RANDOM % 200))"

"$PROXY" "$PROJECT:$REGION:$DB_INSTANCE" --port "$PORT" >/dev/null 2>&1 &
PROXY_PID=$!
cleanup() { kill "$PROXY_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Wait for proxy to accept connections (up to 5 seconds)
for _ in {1..20}; do
  if (echo >/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then break; fi
  sleep 0.25
done

PGPASSWORD="$(gcloud secrets versions access latest --secret="$SECRET")" \
  psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" "$@"
