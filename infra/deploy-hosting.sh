#!/usr/bin/env bash
# infra/deploy-hosting.sh
#
# Firebase Hosting への **手動** デプロイの唯一の正規ルート。
# 直接 `firebase deploy --only hosting` を打つと、ローカル clone が古い時に
# 過去状態を本番に上書きしてしまうので、必ずこのラッパー経由で。
#
# やってること:
#   1. git fetch & main を origin/main に揃える（強制 pull）
#   2. Cloud Run URL を取得して apps/config.js に注入
#   3. firebase deploy --only hosting

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-static-epigram-496002-v8}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-keihi-api}"

cd "$(git rev-parse --show-toplevel)"

echo "▶ git fetch origin main..."
git fetch origin main --quiet

LOCAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$LOCAL_BRANCH" != "main" ]; then
  echo "❌ main ブランチにいません（現在: $LOCAL_BRANCH）"
  echo "   解決: git checkout main"
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  # 未 push の commit があるなら止める（誤って巻き戻すと困る）
  if git merge-base --is-ancestor "$REMOTE" "$LOCAL"; then
    echo "❌ ローカル main に未 push の commit があります"
    echo "   解決: git push origin main"
    exit 1
  fi
  # それ以外は ff-only で追従
  echo "▶ ローカル main が古いので origin/main に追従..."
  git pull --ff-only origin main
fi

echo "▶ Cloud Run URL 取得..."
RUN_URL=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" --project="$PROJECT_ID" \
  --format='value(status.url)')
if [ -z "$RUN_URL" ]; then
  echo "❌ Cloud Run の URL が取得できません"
  exit 1
fi
echo "  API_BASE = $RUN_URL"
echo "window.API_BASE='$RUN_URL';" > apps/config.js

echo "▶ firebase deploy --only hosting..."
firebase deploy --only hosting \
  --project="$PROJECT_ID" \
  --config=firebase.json \
  --non-interactive

echo "✅ Hosting deploy 完了: https://keihi-496002.web.app"
