#!/usr/bin/env bash
# ============================================================
#  keikhi : Cloud Shell 即プレビュー（デプロイ不要）
#
#  本番(Firebase Hosting + Cloud Run)と「同じコード・同じ構成」を
#  Cloud Shell の1プロセスで起動する。Web プレビュー(8080)を開けば
#  スマホからその場で確認でき、デプロイ待ちがゼロになる。
#
#  使い方（Cloud Shell）:
#    bash infra/dev.sh keihi
#  → 上部メニュー「ウェブでプレビュー」→ ポート 8080 を開く
#  → コードを直したら Ctrl+C → もう一度実行（数秒で再起動）
#
#  本番との同一性:
#   - API: 同一オリジン /api/**（本番の Hosting rewrite と同じ経路）
#   - 認証: 本物の Firebase ID トークン検証（本番と同一コード）
#   - DB:   本番と同じ Cloud SQL に cloud-sql-proxy 経由で接続
#   - Gemini/バケット: 本番と同じ Secret / バケットを使用
# ============================================================
set -euo pipefail

APP="${1:-keihi}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="${ROOT_DIR}/apps/${APP}/server"
[[ -d "$SERVER_DIR" ]] || { echo "no such app: apps/${APP}/server" >&2; exit 1; }

REGION="${REGION:-asia-northeast1}"
DB_INSTANCE="${DB_INSTANCE:-keikhi-db}"
PROJECT="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

# app.yaml から値を読む（簡易パース）
APP_YAML="${ROOT_DIR}/apps/${APP}/app.yaml"
get() { grep -E "^$1:" "$APP_YAML" 2>/dev/null | sed -E "s/^$1:[[:space:]]*\"?([^\"#]*)\"?.*/\1/" | xargs; }
DB_USER_V="$(get DB_USER)"; DB_USER_V="${DB_USER_V:-$APP}"
DB_NAME_V="$(get DB_NAME)"; DB_NAME_V="${DB_NAME_V:-$APP}"
DB_SECRET="$(get DB_PW_SECRET)"; DB_SECRET="${DB_SECRET:-${APP}-db-password}"
HOSTING_SITE="$(grep -E '"site"' "${ROOT_DIR}/apps/${APP}/firebase.json" | sed -E 's/.*"site":[[:space:]]*"([^"]+)".*/\1/')"

echo "▶ project=${PROJECT}  app=${APP}  hosting=${HOSTING_SITE}"

PROXY="$(command -v cloud-sql-proxy || true)"
[[ -n "$PROXY" ]] || { echo "cloud-sql-proxy が無い（Cloud Shell で実行してください）" >&2; exit 1; }

DB_LOCAL_PORT="$((5400 + RANDOM % 200))"
"$PROXY" "${PROJECT}:${REGION}:${DB_INSTANCE}" --port "$DB_LOCAL_PORT" >/dev/null 2>&1 &
PROXY_PID=$!
TMP_INIT="$(mktemp)"
cleanup() { kill "$PROXY_PID" 2>/dev/null || true; rm -f "$TMP_INIT"; }
trap cleanup EXIT INT TERM

for _ in {1..20}; do (echo >"/dev/tcp/127.0.0.1/${DB_LOCAL_PORT}") 2>/dev/null && break; sleep 0.25; done

# 本番 Hosting が配る Firebase 設定（公開値）をそのまま流用 → ローカルでも本物ログイン
echo "▶ fetching Firebase config from https://${HOSTING_SITE}.web.app"
curl -fsS "https://${HOSTING_SITE}.web.app/__/firebase/init.json" -o "$TMP_INIT" \
  || { echo "init.json 取得失敗（本番Hostingが未デプロイ？）" >&2; exit 1; }

echo "▶ loading secrets from Secret Manager"
GEMINI_KEY="$(gcloud secrets versions access latest --secret=gemini-api-key)"
DB_PW="$(gcloud secrets versions access latest --secret="$DB_SECRET")"

if [[ ! -d "${SERVER_DIR}/node_modules" ]]; then
  echo "▶ npm install (初回のみ)"
  (cd "$SERVER_DIR" && npm install --no-audit --no-fund --silent)
fi

cat <<EOF

  ─────────────────────────────────────────────
   起動します。Cloud Shell 上部の
     「ウェブでプレビュー」→「ポート 8080 でプレビュー」
   を開くとスマホで確認できます（デプロイ不要・即反映）。
   コード修正後は Ctrl+C → 再実行（数秒）。
  ─────────────────────────────────────────────

EOF

cd "$SERVER_DIR"
DEV=1 \
PORT=8080 \
FIREBASE_INIT_JSON="$TMP_INIT" \
FIREBASE_PROJECT_ID="$PROJECT" \
ALLOWED_EMAILS="" \
GEMINI_API_KEY="$GEMINI_KEY" \
DB_HOST=127.0.0.1 \
DB_PORT="$DB_LOCAL_PORT" \
DB_USER="$DB_USER_V" \
DB_NAME="$DB_NAME_V" \
DB_PASSWORD="$DB_PW" \
RECEIPTS_BUCKET="${PROJECT}-${APP}-receipts" \
exec node index.js
