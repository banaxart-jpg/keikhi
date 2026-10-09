# 現場（/genba/）

現場 (site) の登録・編集・削除を一元管理するアプリ。
住所とキーボックス情報 (暗証番号 / 設置場所など) を 現場ごとにメモできる。

他ミニアプリ (経費 / 経費2 / 請求書 / 手配リスト / タスク) は
このマスタの現場名を **読み取り専用** で参照する。
**新規追加・削除はこのアプリ独占。**

## 使い方
- ランチャーから `[domain] 現場` をタップ
- 一覧から現場をタップ → 住所・キーボックスを展開表示
- 展開後に `編集` または `削除`
- 右上 `+ 追加` で新規作成
- 他アプリ (例: 経費) の「現場アプリで追加」リンクから来た場合、保存後に元アプリに戻る (`?return=/keihi/&newSite=true`)

## AI から使う (MCP `genba_*`)

現場チャット (1 現場 1 チャット) から AI が案件・進捗・ルールを扱う口。サーバー側は `apps/keihi/server/genba-lib/index.js`。
統合コネクタ (`/api/mcp/<token>`) に入っている。人ごとの URL は `/api/genba/mcp/<token>` (`GENBA_MCP_TOKENS="token:名前,…"` で書いた人が決まる)。

| ツール | 何をする |
|---|---|
| `genba_find(query)` | 案件 ID・名前・名前の一部で現場を探す (表記ゆれ吸収) |
| `genba_register(name, code?, drive_folder_url?, client?)` | 現場に案件 ID / Drive の案件フォルダ / 客先を紐付け (無ければ作る) |
| `genba_folder(site, kind)` | 写真 / 図面 / 見積 / 資料 / 参考 を上げる Drive フォルダの URL (無ければ案件フォルダ下に `03_写真` 等を作る) |
| `genba_log_add(site, kind, body, due_on?, resolves_id?)` | 進捗ログに追記。種類 = 進捗 / 課題 / 決定 / 次やること / 解決 |
| `genba_log_list(site, days?, kind?)` | ログ一覧 |
| `genba_status(site)` | 最終更新・直近の進捗・未解決の課題・次やること・最近の決定 |
| `genba_rule_get(topic?)` / `genba_rule_set(topic, body)` | 運用ルール (版を積む。消えない) |

データ: `sites` に `site_code` / `drive_folder_id` / `client` 列を追加 (このアプリの画面は変えていない)、`genba_log` (追記のみ)、`genba_rules`。
写真そのものは Drive の案件フォルダに人が直接上げる。Keihi は URL を返すだけ。

## ファイル構成
- `index.html` — UI + ロジック (vanilla HTML/JS、Firebase Auth + /api/sites を直叩き)
- `README.md` — これ

## データモデル
Cloud SQL `sites` テーブル (apps/keihi/server/index.js の ensureSchema で管理):

| カラム | 型 | 内容 |
|---|---|---|
| id | BIGSERIAL PK | 内部 ID |
| name | TEXT UNIQUE | 現場名 (他アプリが参照するキー) |
| address | TEXT | 住所 |
| key_box | TEXT | キーボックス情報 |
| created_at | TIMESTAMPTZ | 作成日時 |

## API
- `GET /api/sites` — 全件取得 (社外含む全 auth ユーザに開放)
- `POST /api/sites` — 新規 / UPSERT (社内限定)
- `PUT /api/sites/:id` — 編集 (社内限定)
- `DELETE /api/sites/:id` — 削除 (社内限定)

## 残課題 / 今後やりたいこと
- [ ] 現場ごとの集計サマリ (売上 / 経費 / タスク件数 等) を見せたら便利
- [ ] 検索 (現場が増えてきたら)
- [ ] アーカイブ (論理削除)
