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
| `genba_log_add(site?, kind, body, who?, estimate_min?, due_on?, resolves_id?)` | 進捗ログに追記。種類 = 進捗 (やったこと) / 課題 / 決定 / 次やること (タスク) / 解決。site 省略 = 現場に紐づかない雑務。who = やった人/担当、estimate_min = 所要時間 (分) |
| `genba_tasks(max_minutes?, who?, site?, kind?)` | 未解決タスクを全現場横断で (所要時間が短い順)。「5 分で終わるタスクある？」用 |
| `genba_log_list(site, days?, kind?)` | ログ一覧 |
| `genba_status(site)` | 最終更新・直近の進捗・未解決の課題・次やること・最近の決定 |
| `genba_rule_get(topic?)` / `genba_rule_set(topic, body)` | 運用ルール (版を積む。消えない) |
| `genba_log_add_many(site?, items[])` | まとめて追記 (監視ジョブ・会話から一度に抽出したとき)。各行に `duplicate` |
| `genba_room_sync(rooms)` | 監視ジョブが自分の Beeper / LINE のルーム一覧 (ID と名前だけ) を同期。返り値 `watching` が読む対象 |
| `genba_source_add / list / mark / remove` | 監視 ON のルーム (自分の持ち分) と「ここまで読んだ」cursor。載っていないルームは監視ジョブが読まない |
| `genba_owner_set(email, label)` | 画面のログイン (メール) をトークンの名前 (小西 / 名取) に結びつける。小西のトークンからだけ |
| `genba_contact_find(query)` | 人を探す (名前・あだ名・会社名・ルーム名・room_id)。1 件なら `match`、複数なら `candidates` だけ (AI は人に聞く) |
| `genba_contact_upsert({name, company?, aliases?, role?, trade?, channels?, tone?, sites?, …})` | 連絡先の登録・更新。name + company で同一人物。aliases / channels / sites は足すだけ |
| `genba_contact_alias_add(contact, alias)` | 「A は B のこと」「覚えといて」→ 呼び名を足す |
| `genba_contact_list(site?, role?, trade?)` | 現場ごと・役割ごと・職種ごとの顔ぶれ |
| `genba_contact_remove(contact)` | 1 件消す (小西のトークンからだけ。掃除用) |

### 連絡先・呼び名 (`genba_contacts`)
人をあだ名や下の名前で呼ぶ (例: バカボンさん = ㈱大丁工業 菊池) ので、「誰か / どの LINE ルームに送るか / どんな言葉遣いか」を
どの AI・どのスレッド・監視ジョブからでも同じ答えで引けるように Keihi 側に持つ。
- 1 人 1 行: `name` / `company` / `aliases[]` / `role` (職人・業者・元請け・設計・客先・社内) / `trade` (職種) / `channels[]` / `tone` / `site_ids[]` / phone / email / notes
- `channels[]` = `{ channel (LINE/iMessage/Mail), room_id, room_name, kind (single/group), chat_id }`。**room_id は Beeper の変わらない ID** (`!xxxx:beeper.local`) を正本にする。数字の chatID は変わることがあるので `chat_id` (補助)
- 検索は名前・呼び名・会社名・ルーム名を全部 `normName` (全角→半角、空白・記号を落とす、末尾の「さん/様/くん/ちゃん」を落とす、ひらがな→カタカナ) に通して比較。会社名は 株式会社 / ㈱ / (株) も落とす
- 完全一致があっても「菊池 → 菊池 輝」のような前方一致は候補に残す。**候補が複数なら AI は自動で決めない** (`match` が null)
- `genba_room_sync` が同期したルーム名が contact の `room_name` と合えば `room_id` を自動で埋める (逆に room_id だけなら room_name を埋める)。返り値 `contactsLinked`
- `genba_log_add` の `source.sender` が連絡先に一意に解決できたら `source.contact_id` / `source.contact_name` を足す (sender が曖昧でも `source.room` を持つ人に絞れればそれ)
- `genba_rule_get` の一覧は topic `連絡先` を先頭に返す

### ウォッチ画面 `/genba/watch.html`
ログインした人のルームだけが並ぶ (小西 → 小西の Beeper、名取 → 名取の)。行ごとに現場の選択とトグル。
ON = 監視ジョブが読んで現場の進捗に記録、OFF = 読まない (デフォルト OFF、ホワイトリスト)。
ルームは監視ジョブの `genba_room_sync` で入ってくる (本文は送らない、ID と名前だけ)。
API: `GET /api/genba/me` / `GET /api/genba/rooms` / `PUT /api/genba/rooms/:id {enabled, siteId, label}` / `DELETE /api/genba/rooms/:id` (Firebase 認証)。

### 監視ジョブ (Cowork 等で 5 分ごとに LINE を読んで自動記録)
1. `genba_room_sync` にルーム一覧 (ID と名前) を渡す → 返り値 `watching` が読む対象 (ON/OFF は画面)
2. cursor より後のメッセージだけ読む (Beeper 等の MCP)
3. 決定・課題・次やることを抽出して `genba_log_add_many`。各 item に `source_ref = "<channel>:<room>:<message id>"` (同じメッセージは 2 回入らない) と `source = {channel, room, sender, at, quote}`
4. `genba_source_mark(channel, room, {last_id, last_at})` で cursor を進める

書いた人は人ごとの URL で決まる: `GET /api/mcp-connector` (ログイン済み) が `genba.名取` / `genba.LINE監視` の URL を返す (INTERNAL_TICK_SECRET から導出、リポには無い)。

データ: `sites` に `site_code` / `drive_folder_id` / `client` 列を追加 (このアプリの画面は変えていない)、`genba_log` (追記のみ)、`genba_rules`、`genba_sources` / `genba_owners` (監視対象)、`genba_contacts` (連絡先)。
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
