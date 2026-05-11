# denki-zumen — 電気図面作成アプリ

未着手 (placeholder)。

## 想定スタック

経費管理アプリと同じ構成を流用する想定：

| レイヤ        | サービス                          |
|--------------|-----------------------------------|
| Frontend     | 単一HTML / SPA (どちらでも)        |
| API          | Cloud Run (Node.js)               |
| AI           | Gemini API (図面の指示理解 / OCR) |
| DB           | Cloud SQL (PostgreSQL, 共有 `keikhi-db` 内の `denki_zumen` DB) |
| 画像 / SVG   | Cloud Storage                     |
| CI/CD        | Cloud Build (`apps/denki-zumen/**` の push でトリガ) |

## 次にやること

1. 何を入出力するかを決める（仕様：例 = 部屋の寸法とコンセント位置を入れて単線結線図を出す、等）
2. `apps/denki-zumen/server/` を用意し、`Dockerfile` と最小の Express を置く
3. `apps/denki-zumen/cloudbuild.yaml` を `apps/keihi/cloudbuild.yaml` から複製して `_APP=denki-zumen` に書き換え
4. `app.yaml` の `HAS_DB`, `HAS_BUCKET` を `"true"` に
5. `infra/bootstrap.sh` を再実行 → リソースとトリガが自動生成される
