# 録音メモ（/rec/）

録音すると、AI（Gemini）が**文字起こし＋要約**して、要点・決定事項・やること付きのメモにするアプリ。打ち合わせ・現場メモ・思いつきの記録に。

## 使い方
- ランチャーから [録音メモ] をタップ
- 🎙️ **録音する** → 話す → **停止して要約**
- AIが「要点／決定事項／やること／文字起こし全文」に整理 → タイトルを直して **保存**
- 一覧からタップで見返し・タイトル編集・削除

## 仕組み・注意
- 録音は端末のマイク（MediaRecorder）。**音声そのものは保存せず**、AI要約したテキストだけ保存（Firestoreではなく keihi-api / Cloud SQL に、全員共有）
- 文字起こし＆要約は `POST /api/rec/summarize`（Gemini 2.5 flash に音声を inlineData で渡す）
- **目安10分以内**。長すぎると要約できないことあり（インライン上限）
- 初回はブラウザが**マイク許可**を聞く → 許可が必要
- iPhone は Safari（https）で動作

## データ / API
- テーブル `rec_memos`（title / summary / transcript / duration）
- `POST /api/rec/summarize`（要約）、`GET/POST/PUT/DELETE /api/rec`（メモCRUD）

## ファイル構成
- `index.html` — 録音UI + 一覧 + 詳細（1ファイル完結）
- サーバー側は `apps/keihi/server/index.js` の `/api/rec*`

## 残課題 / 今後やりたいこと
- [ ] 長時間録音の分割アップロード（Gemini File API）
- [ ] 話者分け・現場タグ・タスクへ送る連携
- [ ] 音声ファイルのアップロード（録音済みファイルから要約）
