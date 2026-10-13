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
| `genba_log_add(site?, kind, title, body, who?, estimate_min?, due_on?, resolves_id?, topic?, supersedes_id?)` | 進捗ログに追記。title = 一覧用 (20 字前後、40 字まで、「何を・どうする」、決定は結論)、body = 詳細 (経緯・数量・型番・金額・出どころ)。title が無い行は返すときだけ body の先頭 28 字 (`title_auto: true`)。種類 = 進捗 (やったこと) / 課題 / 決定 / 次やること (タスク) / 解決。site 省略 = 現場に紐づかない雑務。who = やった人/担当、estimate_min = 所要時間 (分)。決定には topic (床材 / 巾木 …)。同じ現場・同じ topic の生きている決定があれば自動で置き換える (返り値 `superseded`)、明示するなら supersedes_id |
| `genba_log_title_set_many(items[{id, title}])` | 【移行用・あとで消す】既存行に title だけを付ける (最大 200 件)。返り値 updated / missing |
| `genba_audit(site?, days?)` | 抜け漏れチェック: 期限切れ / 期限なし / 「返事待ち・確認中」なのに次やることが無い / 日程があるのにカレンダー未登録 (`calendar_event` 無し)。会話の終わりと監視ジョブの 1 時間に 1 回 |
| `genba_log_fix(id, {title, body, site, due_on, who, estimate_min, topic, calendar_event})` | 行を直す。前の値は `edits` に残る (誰がいつ)。kind は変えない |
| `genba_log_void(id, reason?)` | 行を取り消す (隠すだけ、消えない)。解決を void すると元のタスクが戻る、変更の決定を void すると前の決定が生き返る |
| `genba_tasks(max_minutes?, who?, site?, kind?)` | 未解決タスクを全現場横断で (所要時間が短い順)。「5 分で終わるタスクある？」用 |
| `genba_log_list(site, days?, kind?, who?, topic?, chain?, include_voided?)` | ログ一覧。`chain=行 ID` で変更の履歴 (置き換えの連鎖) を古い順に、`current` が今生きている行 |
| `genba_file_upload_url(site?, filename, content_type?, kind?, source_ref?)` | 画像・PDF を GCS に上げる一時 URL (2 時間)。返ってくる `curl` を PC 側で実行して PUT する。同じ source_ref は duplicate |
| `genba_file_list(site?, days?, kind?)` / `genba_file_void(id)` | 現場の写真・ファイル一覧 (7 日有効の署名 URL) と、一覧から外す |
| `genba_status(site)` | 最終更新・直近の進捗・未解決の課題・次やること・今生きている決定 (`changes` 回数と `previous` 付き)・現場のメモ・関わる人・最近の写真 |
| `genba_rule_get(topic?)` / `genba_rule_set(topic, body)` | 運用ルール (版を積む。消えない) |
| `genba_log_add_many(site?, items[])` | まとめて追記 (監視ジョブ・会話から一度に抽出したとき)。各行に `duplicate` |
| `genba_room_sync(rooms)` | 監視ジョブが自分の Beeper / LINE のルーム一覧 (ID と名前だけ) を同期。返り値 `watching` が読む対象 |
| `genba_source_add(channel, room, site?, purpose?) / list / mark / remove` | 監視 ON のルーム (自分の持ち分) と「ここまで読んだ」cursor。purpose=記録 (site 必須) / 応答 (site 不要)。載っていないルームは監視ジョブが読まない |
| `genba_owner_set(email, label)` | 画面のログイン (メール) をトークンの名前 (小西 / 名取) に結びつける。小西のトークンからだけ |
| `genba_contact_find(query)` | 人を探す (名前・あだ名・会社名・ルーム名・room_id)。1 件なら `match`、複数なら `candidates` だけ (AI は人に聞く) |
| `genba_contact_upsert({name, company?, aliases?, role?, trade?, channels?, tone?, sites?, …})` | 連絡先の登録・更新。name + company で同一人物。aliases / channels / sites は足すだけ |
| `genba_contact_alias_add(contact, alias)` | 「A は B のこと」「覚えといて」→ 呼び名を足す |
| `genba_contact_list(site?, role?, trade?)` | 現場ごと・役割ごと・職種ごとの顔ぶれ |
| `genba_contact_remove(contact)` | 1 件消す (小西のトークンからだけ。掃除用) |
| `genba_company_find(query)` / `genba_company_upsert({name, aliases?, role?, trades?, …})` / `genba_company_list(role?, trade?)` / `genba_company_remove` | 会社 (連絡先の `company` の本体)。価格感・得意工事は会社に付ける。返り値に所属の連絡先とメモ |
| `genba_note_add(subject_type, subject?, kind?, body, valid_from?, valid_until?)` | 流れない情報を 人 / 会社 / 現場 / 社内 にぶら下げる (性質 / 予定 / 評価 / ルール / メモ)。期限付き |
| `genba_note_list(subject_type?, subject?, kind?, on?, include_expired?)` / `genba_note_retire(id)` | メモの一覧 (日付時点の有効分) と引退 (消さない) |

### 連絡先・呼び名 (`genba_contacts`)
人をあだ名や下の名前で呼ぶ (例: バカボンさん = ㈱大丁工業 菊池) ので、「誰か / どの LINE ルームに送るか / どんな言葉遣いか」を
どの AI・どのスレッド・監視ジョブからでも同じ答えで引けるように Keihi 側に持つ。
- 1 人 1 行: `name` / `company` / `aliases[]` / `role` (職人・業者・元請け・設計・客先・社内) / `trade` (職種) / `channels[]` / `tone` / `site_ids[]` / phone / email / notes
- `channels[]` = `{ channel (LINE/iMessage/Mail), room_id, room_name, kind (single/group), chat_id }`。**room_id は Beeper の変わらない ID** (`!xxxx:beeper.local`) を正本にする。数字の chatID は変わることがあるので `chat_id` (補助)
- 検索は名前・呼び名・会社名・ルーム名を全部 `normName` (全角→半角、空白・記号を落とす、末尾の「さん/様/くん/ちゃん」を落とす、ひらがな→カタカナ) に通して比較。会社名は 株式会社 / ㈱ / (株) も落とす
- 完全一致があっても「菊池 → 菊池 輝」のような前方一致は候補に残す。**候補が複数なら AI は自動で決めない** (`match` が null)
- `genba_room_sync` が同期したルーム名が contact の `room_name` と合えば `room_id` を自動で埋める (逆に room_id だけなら room_name を埋める)。どの連絡先にも結ばれていないルームで、名前が 1 人の連絡先の名前・呼び名と完全一致すれば、その人の個人ルームとして足す。返り値 `contactsLinked`
- `genba_log_add` の `source.sender` が連絡先に一意に解決できたら `source.contact_id` / `source.contact_name` を足す (sender が曖昧でも `source.room` を持つ人に絞れればそれ)
- `genba_rule_get` の一覧は topic `連絡先` を先頭に返す

### 抜け漏れを機械的に拾う (followups / genba_audit)
AI が「次やることを立てる」「カレンダーに入れる」を忘れるのを、記憶ではなくサーバーの返り値で止める。
- `genba_log_add` / `add_many` の返り値に `followups[]`: 本文に「返事待ち・確認中・依頼・送付」があれば「次やることを立てる」、「搬入 / 打ち合わせ / 現調 / 作業 … + 日付」があれば「カレンダーに登録して `genba_log_fix(calendar_event)`」、決定に topic が無い / タスクに due_on が無い、を返す。`add_many` で同じ呼び出しに 次やること が入っていれば返事待ちの注意は出ない。現場に期限切れがあれば `site_overdue` も付く
- `calendar_event` 列: カレンダーに入れたら event ID (か `done`) を行に残す。これが無い「日程あり」の行を `genba_audit` が拾う (Keihi はカレンダー自体には触らない)
- `genba_audit`: 期限切れ / 期限なし (作成 3 日超) / 返事待ちでタスク無し (〇〇さん・〇〇待ち の手がかりを含む未解決タスクが 2 日以内に無い) / 日程あり未登録 を返す。`summary` と `how_to_fix` 付き。監視ジョブが 1 時間に 1 回回し、会話の終わりにも 1 回

### 決定の変更・訂正・取り消し
- 決定には `topic` (何についてか)。決定が変わったら同じ現場・同じ topic で新しい決定を足すだけで、前の決定に `supersedes_id` で紐付く (自動)。`genba_status` には生きている決定だけ出て、`changes` (何回変わったか) と `previous` (直前の内容) が付く。履歴は `genba_log_list(chain=ID)`
- タスクの言い換えも `supersedes_id` で (元のタスクは tasks から消える)
- 追記のみは崩さない。直すときは `genba_log_fix` (前の値を `edits` に残す)、入れるべきでなかった行は `genba_log_void` (`voided_at` で隠す、物理削除しない)。「生きている行」= void されていない・解決されていない・置き換えられていない

### 写真・ファイル (`genba_files` + GCS)
LINE (Beeper) に来た画像を監視ジョブ (PC の Cowork) が保存する流れ。ファイルの中身を AI の会話に通さない。
1. `genba_file_upload_url(現場, ファイル名, content_type, source_ref)` → 署名トークン付きの一時 URL (2 時間) と `curl` 一式が返る
2. PC 側でその `curl -X PUT --data-binary @file` を実行 → `PUT /api/genba/upload/:token` (認証なし、トークンは INTERNAL_TICK_SECRET で HMAC 署名、中身に現場・ファイル名・source_ref・書いた人・期限) → GCS `gs://<RECEIPTS_BUCKET>/genba/<site_id|company>/<yyyymm>/<ts>_<rand>_<name>` に保存、`genba_files` に 1 行、署名 URL (7 日) を返す
3. `genba_log_add(kind=進捗, body="写真 n 枚: 内容", photo_ids=[file id])` で現場のログに結ぶ
- 同じ source_ref は 2 回入らない (同じトークンで 2 回 PUT しても GCS に 2 回置かない)。`genba_file_list` / `genba_status.recent_files` で見る。URL は呼ぶたびに署名し直す

### 会社とメモ (`genba_companies` / `genba_notes`): 流れるもの・流れないもの
- **出来事** (〇日に決まった・やった) は `genba_log` に流す。**今もそうであること** (性質・予定・評価・決まり) は対象にぶら下げる `genba_notes`。log に混ぜると埋まるので分ける
- `genba_companies`: 連絡先の `company` 文字列から自動で起きる (`company_id` で結ぶ、表記は最初の登録のまま)。「金額高め」「防水が得意」は個人ではなく会社に付ける
- `genba_notes`: `subject_type` (contact / company / site / general=社内) + `subject_id` + `kind` (性質 / 予定 / 評価 / ルール / メモ) + `body` + `valid_from` / `valid_until` + `source_ref` (監視ジョブの重複防止) + `retired_at` (消さずに引退)
- 返り値への埋め込み: `genba_contact_find` → 本人の `notes` + `company_detail` (会社の notes 込み) + 1 件確定のときは `recent_log` (その人が出どころのログ直近 5 件)。`genba_company_find` → `notes` + `contacts`。`genba_status` → 現場の `notes` + 関わる `contacts`。`genba_rule_get` (一覧) → `general_notes` (社内の決まり)
- 期限: 「来月から忙しい」は `valid_from`、「〜まで休み」は `valid_until`。find / status には今日時点で有効なものだけ出る。`genba_note_list(人, 予定, on=来月)` で「来月手が空いてる人」を探せる
- `genba_rules` は AI の動き方 (版を積む)、`genba_notes` の kind=ルール は会社の決まり (締め日・入り時間など)。役割が違う
- **センシティブな情報は入れない** (家庭・健康・金銭・人間関係のトラブル・ハラスメント・噂)。全員と全 AI が読める場所なので。必要なら行動の制約だけ (「〇〇電気の現場は小西が同席」) を書き、理由は書かない。メモの内容を本人への文面に引用しない。小西だけが読めるメモ (visibility) は必要になったら足す

### ウォッチ画面 `/genba/watch.html`
ログインした人のルームだけが並ぶ (小西 → 小西の Beeper、名取 → 名取の)。行ごとに用途・現場の選択とトグル。
ON = 監視ジョブが読む、OFF = 読まない (デフォルト OFF、ホワイトリスト)。用途は 2 つ:
- **記録** (既定): 現場に紐付けて、決定・課題・次やることを進捗ログに自動記録する。現場を選ばないと ON にできない
- **応答**: 社内の人 (連絡先で role=社内、今は 小西・名取) からの LINE に AI が自動で返す。現場は不要。社内の人の個人ルームは初回の同期で自動的に 応答 ON になる (`autoAnswering`。OFF にすれば戻らない)。分からないことは「確認して返します」と返して小西に回す。`genba_room_sync` の返り値では `answering` に分かれて出る (`contact` 付き)。答える範囲・出さないものは運用ルール `応答` と instructions の「■ 応答」
ルームは監視ジョブの `genba_room_sync` で入ってくる (本文は送らない、ID と名前だけ)。
API: `GET /api/genba/me` / `GET /api/genba/rooms` / `PUT /api/genba/rooms/:id {enabled, siteId, label}` / `DELETE /api/genba/rooms/:id` (Firebase 認証)。

### 監視ジョブ (Cowork 等で 5 分ごとに LINE を読んで自動記録)
1. `genba_room_sync` にルーム一覧 (ID と名前) を渡す → 返り値 `watching` が読む対象 (ON/OFF は画面)
2. cursor より後のメッセージだけ読む (Beeper 等の MCP)
3. 決定・課題・次やることを抽出して `genba_log_add_many`。各 item に `source_ref = "<channel>:<room>:<message id>"` (同じメッセージは 2 回入らない) と `source = {channel, room, sender, at, quote}`
4. 画像・PDF は `genba_file_upload_url` → PC で `curl` PUT → `genba_log_add(photo_ids)` (上の「写真・ファイル」)
5. `genba_source_mark(channel, room, {last_id, last_at})` で cursor を進める

書いた人は人ごとの URL で決まる: `GET /api/mcp-connector` (ログイン済み) が `genba.名取` / `genba.LINE監視` の URL を返す (INTERNAL_TICK_SECRET から導出、リポには無い)。

データ: `sites` に `site_code` / `drive_folder_id` / `client` 列を追加 (このアプリの画面は変えていない)、`genba_log` (追記のみ)、`genba_rules`、`genba_sources` / `genba_owners` (監視対象)、`genba_contacts` / `genba_companies` (連絡先・会社)、`genba_notes` (流れないメモ)、`genba_files` (写真の台帳、中身は GCS)。
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
