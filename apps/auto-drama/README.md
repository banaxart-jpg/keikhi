# ドラマ置き場（/auto-drama/）

Claude のチャット (claude.ai) から MCP でドラマ/アニメ/漫画を作り、
完成したショート動画をここに並べる「置き場」アプリ。
制作の対話・キャラ設定・画像確認は全部 Claude チャット側でやる。アプリは見るだけ。

## 構成 (v2: MCP 方式)

```
Claude チャット (claude.ai カスタムコネクタ)
   │  MCP (Streamable HTTP)
   ▼
keihi-api の /api/drama/mcp/<token>
   │  キャラ登録 / 画像生成 (Gemini ≈¥6) / 動画生成 (Seedance ≈¥19/秒)
   ▼
Cloud SQL (drama_projects / drama_characters / drama_videos) + GCS (動画・画像)
   ▲
   │  GET /api/drama/gallery (read-only)
/auto-drama/ ← このアプリ。完成動画のギャラリー
```

## claude.ai への接続 (初回だけ)

1. claude.ai → 設定 → コネクタ → カスタムコネクタを追加
2. URL: `https://keihi-api-734350696397.asia-northeast1.run.app/api/drama/mcp/kx9m2drama7vqt4wp8zh`
   (認証なし。トークンは URL に埋め込み。Cloud Run の env `DRAMA_MCP_TOKEN` で差し替え可)
3. チャットで「新しいアニメのプロジェクト作って」等と言えば動く

## MCP ツール一覧

| ツール | 何をする |
|---|---|
| `drama_list_projects` / `drama_create_project` / `drama_update_project` / `drama_get_project` | プロジェクト CRUD (絵柄 styleGuide・世界観 worldSetting・メモ) |
| `drama_upsert_character` | キャラ登録 (identityTokens で同一人物性を担保) |
| `drama_generate_image` | 静止画生成 ≈¥6。saveAs で作画基準/キャラ参照に登録。チャットに縮小プレビューを返す |
| `drama_generate_video` | 9:16 動画生成 (Seedance、8秒≈¥150)。非同期 |
| `drama_check_videos` | 生成進捗の確認 + 完了時 GCS 保存 |
| `drama_delete_video` | ギャラリーから削除 |
| `drama_get_costs` | API 費用の集計 (drama_api_usage) |

## 使い方 (アプリ側)

- ランチャーから [ドラマ置き場] をタップ
- プロジェクト別に完成動画が並ぶ。タップで全画面再生
- 生成中の動画は「生成中」カードで出て、開いている間は 30 秒ごとに自動更新
  (ギャラリー API がサーバー側で Seedance をポーリングするので、開くだけで進捗が進む)

## ファイル構成

- `index.html` — ギャラリー UI (vanilla、置き場のみ)
- `legacy.html` — 旧・アプリ内チャット方式の制作アプリ (v1)。青空文庫 import 等はこちらに残っている
- サーバー側: `apps/keihi/server/index.js` の「auto-drama MCP」セクション
  - `drama-lib/mcp.js` — MCP (Streamable HTTP) プロトコルの最小実装 (SDK 非依存・stateless)
  - 動画テーブル: `drama_videos` (完成動画は GCS `drama/videos/` にミラー、署名 URL は期限前に自動貼り直し)
  - v1 の `/api/drama/*` ルート・テーブルはそのまま残してある (legacy.html 用)

## 残課題 / 今後やりたいこと

- [ ] カット連結・BGM・ナレーション付きの「1話まるごと書き出し」
- [ ] チャットからの画像添付を MCP 経由で参照に登録する導線 (今は URL 渡しのみ)
- [ ] ギャラリーの並べ替え・話数まとめ表示
