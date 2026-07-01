#!/usr/bin/env bash
# ローカル開発用ワンライナー
#   bash infra/dev-serve.sh
# → http://localhost:8080/ でアプリ一覧、apps/**/*.html を編集して F5 で即反映
# → /api/* と Firebase Auth (Google ログイン) は本番 (https://keihi-496002.web.app) にプロキシされる
# → node >= 18 必須 (built-in fetch と ESM が要る)

cd "$(dirname "$0")/.."
exec node infra/dev-serve.js
