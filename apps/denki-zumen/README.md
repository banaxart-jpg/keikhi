# 電気積算（/denki-zumen/）

電気設備図面から品番・数量を AI で拾い出して発注リストを作るアプリ。Phase 1。

## 使い方
- ランチャーから [電気積算] をタップ
- 「図面を読み込む」をタップ → 写真撮影 / アルバム / PDF を選択
- Gemini Vision が品番・名称・数量・カテゴリ・メーカーを抽出、表に並ぶ
- 同じ品番が再アップロードされたら数量は自動で加算
- 各行の `i` ボタンで「これ何？」(品番からメーカー・スペック・互換品を Gemini に質問)
- 数量はその場で書き換え可、`+ 行を追加` で手入力も足せる
- 下部「コピー」で TSV、「CSV」でダウンロード

## Phase 計画

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 品番・個数抽出 + 発注リスト出力 | ✅ |
| 2 | 図面上に「ここに何個」のマーカー重ね + 品番ごとに製品画像 | 未着手 |
| 3 | 回路数の自動カウント (盤・分岐の認識) | 未着手 |
| 4 | 配線図そのものの解釈 (シンボル → ネットリスト) | 未着手 |

## ファイル構成
- `index.html` — Vue 3 + 共通モジュール (api-auth.js, bottom-sheet.js)
- バックエンドは `keihi-api` (`apps/keihi/server/index.js`) の `/api/zumen/scan` / `/api/zumen/explain` を流用

## サーバ側エンドポイント
- `POST /api/zumen/scan` — 画像 (base64) → `{ items: [{ part_no, name, maker, qty, category, symbol, note }] }`
- `POST /api/zumen/explain` — `{ partNo, name }` → `{ exists, maker, name, category, summary, spec, alt_parts, confidence }`

## 残課題 / 今後やりたいこと
- [ ] 複数ページ PDF: 全ページ走査して合算
- [ ] 図面プレビューを残して、各品番タップで該当箇所をハイライト
- [ ] メーカー製品ページから画像取得 (Google Custom Search)
- [ ] 発注書テンプレ (社内フォーマット) で書き出し
- [ ] 過去図面の履歴を Firestore 同期 (PC↔スマホ)
