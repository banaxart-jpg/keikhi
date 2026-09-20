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
   │  キャラ登録 / 画像生成 (Gemini ≈¥6) / 動画生成 (Seedance 2.0、720p 8 秒 fast ≈¥88)
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
| `drama_upsert_character` | キャラ登録 (appearance + identityTokens は毎回の生成プロンプトにサーバーが自動注入) |
| `drama_generate_image` | 静止画生成 ≈¥6。scene / composition / lighting / mustInclude / mustAvoid の slot をサーバーが styleGuide + キャラ設定と合成 (finalPrompt を返す)。review / autoFix で Gemini 審査 + 自動修正。width で保存サイズ可変 (下書き 600 / 本番 1200)。saveAs で作画基準/キャラ参照に登録。1024px プレビューを返す |
| `drama_edit_image` | 既存画像の部分修正 ≈¥6。baseImageUrl + instruction。キャラ・絵柄・構図を保って指示だけ反映 (細部直しは generate より安定) |
| `drama_generate_video` | 動画生成 (Seedance 2.0 系、非同期)。aspectRatio / resolution / durationSec / model (fast・mini・2.0) / draft / 参照画像 9 枚・動画 3 本・音声 3 本 / returnLastFrame。参照 URL はサーバーが GCS に置き直してから渡す。コストは出力仕様から実計算、完成時に実測トークンで確定 |
| `drama_check_videos` | 生成進捗の確認 + 完了時 GCS 保存。videoUrl (署名 30 日) / fileUrl (期限なし) / width・height・fps / tokens・costYen / lastFrameUrl |
| `drama_delete_video` | ギャラリーから削除 |
| `drama_get_costs` | API 費用の集計 (drama_api_usage) |

## 動画生成 (Seedance 2.0) の仕様

リクエストの項目名は ModelArk のドキュメントに合わせている
([Create a video generation task](https://docs.byteplus.com/en/docs/ModelArk/1520757) /
[Seedance 2.0 series tutorial](https://docs.byteplus.com/en/docs/ModelArk/2291680))。実装は `server/drama-lib/videoGen.js`。

| 引数 | 既定 | 上限・注意 |
|---|---|---|
| `aspectRatio` | 9:16 | 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9 / adaptive |
| `resolution` | 720p | fast・mini は 480p / 720p のみ。1080p / 4k は model `2.0` |
| `durationSec` | 8 | 4〜15 (整数秒) |
| `model` | fast | `fast` / `mini` / `2.0` の別名か正式 ID (fast = dreamina-seedance-2-0-fast-260128、mini = dreamina-seedance-2-0-mini-260615) |
| `draft` | false | true で 480p + mini を既定に (下書き用) |
| `referenceImageUrls` | — | 最大 9 枚 (キャラ参照と合算)。jpeg/png/webp/bmp/tiff/gif、30MB 未満 |
| `referenceVideoUrls` | — | 最大 3 本、各 2〜15 秒・合計 15 秒以内。mp4/mov、200MB 以内 |
| `referenceAudioUrls` | — | 最大 3 本、各 2〜15 秒・合計 15 秒以内。wav/mp3、15MB 以内。音声だけは不可 |
| `generateAudio` | false (参照音声あり → true) | Seedance の `generate_audio` |
| `returnLastFrame` | false | `return_last_frame`。完成後 `lastFrameUrl` / `lastFrameFileUrl` |

- プロンプトからは入力順に「image 1」「video 1」「audio 1」で参照を指す (Seedance の流儀。`[Image 1]` の角括弧も可)
- **参照 URL はサーバーが一度ダウンロードして `drama/refs/` に置き直し、署名付き直リンクを Seedance に渡す。**
  Adobe の短縮 URL (at.adobe.com) をそのまま渡すと Seedance 側で "resource download failed" になっていたため。
  data: URL / 生 base64 も同じ経路。失敗時は「どの URL が HTTP 何で」落ちたかをエラーに含める
- 実写の人物の顔が写った参照は Seedance 2.0 系が拒否する (ドキュメント明記)
- seed / camera_fixed / frames は 1.x 系専用なので送らない

### コスト
`tokens = 幅 × 高さ × 24fps × 秒 / 1024`、`円 = tokens / 1000 × モデル単価 (USD/1K) × 為替`。
単価・為替・比率ごとの画素数は `server/drama-video-pricing.json` (fast 0.0033 / mini 0.0021 USD/1K、155 円)。
作成時は見積り (`tokensEstimated` / `costYenEstimated`)、完成時に取得 API の `usage.completion_tokens` で確定して
`drama_videos.tokens / cost_yen` と `drama_api_usage` (video_id で紐付け) を上書きする。

| 例 | tokens | 円 |
|---|---|---|
| 720p 9:16 8 秒 fast | 172,800 | ≈ 88 |
| 480p 16:9 4 秒 fast | 40,176 | ≈ 21 |
| 480p 16:9 4 秒 mini | 40,176 | ≈ 13 |

### URL
- `videoUrl`: GCS の署名 URL (v2、30 日)。残り 1 日を切ると check / gallery 呼び出し時に貼り直す
- `fileUrl`: `https://<keihi-api>/api/drama/videos/<id>/file` — 期限なし。呼ぶたびに署名し直して 302 (認証なし、ギャラリーと同じ扱い)
- `lastFrameUrl` / `lastFrameFileUrl`: 同様 (returnLastFrame 指定時)

### 画像精度のハンドシェイク (v1.1)

```
Claude: scene / composition / lighting / mustInclude / mustAvoid + characterNames
   │
   ▼ サーバーが合成
finalPrompt = シーン + 構図 + 光 + 登場人物 (appearance / identityTokens) + 絵柄 (styleGuide) + 必ず入れる / 入れない
参照画像   = 追加 URL → キャラ参照 (1人なら2枚) → 作画基準 (残り枠)   ※役割を Gemini に明示
   │
   ▼ Gemini 2.5 flash image (≈¥6)
review: true なら flash で審査 → {ok, problems, fixInstruction}
autoFix: 1〜2 なら NG のとき編集モードで自動修正 (+¥6/回)
   │
   ▼ 結果: 1024px プレビュー + imageUrl + finalPrompt + review + refImages
細部直し → drama_edit_image(baseImageUrl, instruction)   ← 作り直しより絵柄が保たれる
```

- 作画基準 (`saveAs: 'style_ref'`) は `{url, gcsUrl}` で保存し、読む側で署名を貼り直す (以前は署名 URL 文字列だけで 7 日で切れていた)
- `width` は保存サイズ。Gemini の出力は長辺 ~1024px 固定なので 1200 は lanczos の拡大 (縮小はトークン・転送量が減る)

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
- [ ] 本番用の高解像度: 2K 出力対応モデルへの切替 (今は 1024 からの拡大)
- [ ] ギャラリーの並べ替え・話数まとめ表示
