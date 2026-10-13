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
| `genba_log_add(site?, kind, title, body, who?, estimate_min?, due_on?, resolves_id?, topic?, supersedes_id?)` | 進捗ログに追記。種類に `待ち` (相手の返事・物・データ待ち。who=相手。タスク一覧・カレンダーには出ない。返事が来たら 解決)。`then` = 来たらやること (例「シートをギさんへ転送 (AI、確認なしで)」)。待ちは『誰を待つ (who)』+『来たら何をする (then)』で 1 件のジョブ。監視ジョブが待っている相手からのメッセージを記録すると返り値 `waiting_hits` でその待ち (then 付き) が返り、AI が then を実行する (自動発火)。title = 一覧用 (20 字前後、40 字まで、「何を・どうする」、決定は結論)、body = 詳細 (経緯・数量・型番・金額・出どころ)。title が無い行は返すときだけ body の先頭 28 字 (`title_auto: true`)。種類 = 進捗 (やったこと) / 課題 / 決定 / 次やること (タスク) / 解決。site 省略 = 現場に紐づかない雑務。who = やった人/担当、estimate_min = 所要時間 (分)。決定には topic (床材 / 巾木 …)。同じ現場・同じ topic の生きている決定があれば自動で置き換える (返り値 `superseded`)、明示するなら supersedes_id |
| `genba_log_title_set_many(items[{id, title}])` | 【移行用・あとで消す】既存行に title だけを付ける (最大 200 件)。返り値 updated / missing |
| `genba_calendar_setup(calendar_id, colors?, dry_run?)` / `genba_calendar_sync()` / `genba_calendar_status()` | タスク専用カレンダーとの双方向同期 (下の「タスクカレンダー同期」) |
| `genba_contact_find(query)` の `message_hint` / `last_contact` | 送る相手との直近のやりとり (この人からの記録の `source.at` と、そのルームの cursor の `last_at` の新しい方)。3 時間以内・今日なら「挨拶なしで用件から」、無ければ「最初の 1 通だけ挨拶 OK」。毎回「お疲れ様です！」から始めないため |
| `genba_audit(site?, days?)` | 抜け漏れチェック: 期限切れ / 期限なし / 「返事待ち・確認中」なのに次やることが無い / 日程があるのにカレンダー未登録 (`calendar_event` 無し) / 監視ジョブの停止 (`monitor`: `genba_room_sync` が 30 分以上来ていなければ stalled)。会話の終わりと監視ジョブの 1 時間に 1 回 |
| `genba_log_fix(id, {title, body, site, due_on, who, estimate_min, topic, calendar_event})` | 行を直す。前の値は `edits` に残る (誰がいつ)。kind は変えない |
| `genba_log_void(id, reason?)` | 行を取り消す (隠すだけ、消えない)。解決を void すると元のタスクが戻る、変更の決定を void すると前の決定が生き返る |
| `genba_tasks(max_minutes?, who?, site?, kind?, include_waiting?)` | 未解決タスクを全現場横断で (所要時間が短い順)。「5 分で終わるタスクある？」用。待ち は既定で含まない。返り値 `monitor` に監視ジョブの生存状態 (画面に「監視が止まっている」を出す用) |
| `genba_log_list(site, days?, kind?, who?, topic?, chain?, include_voided?)` | ログ一覧。`chain=行 ID` で変更の履歴 (置き換えの連鎖) を古い順に、`current` が今生きている行 |
| `genba_file_upload_url(site?, filename, content_type?, kind?, source_ref?)` | 画像・PDF を GCS に上げる一時 URL (2 時間)。返ってくる `curl` を PC 側で実行して PUT する。同じ source_ref は duplicate |
| `genba_file_list(site?, days?, kind?)` / `genba_file_void(id)` | 現場の写真・ファイル一覧 (7 日有効の署名 URL) と、一覧から外す |
| `genba_status(site)` | 最終更新・直近の進捗・未解決の課題・次やること・今生きている決定 (`changes` 回数と `previous` 付き)・現場のメモ・関わる人・最近の写真 |
| `genba_rule_get(topic?)` / `genba_rule_set(topic, body)` | 運用ルール (版を積む。消えない) |
| `genba_log_add_many(site?, items[])` | まとめて追記 (監視ジョブ・会話から一度に抽出したとき)。各行に `duplicate` |
| `genba_source_mark(channel, room, cursor, items[])` | 監視ジョブの「ここまで読んだ」+ 読んだメッセージの目録。items は 1 件 1 要素 `{id, sender, at, kind, gist(40 字), len, …}`。kind が 決定 / 課題 / 次やること / 待ち / 進捗 なら title・body を付ければサーバーが genba_log に入れる (source_ref 自動)。メモ=note_id、画像=file_id、返信=AI の発言、雑談 / 私的 (gist 保存なし) / 既存。**cursor は items 無しでは進まない**、入らない item があれば cursor を進めずに error。目録は `genba_seen` (本文は持たない) に残る |
| `related_tasks` / `related_say` (genba_log_add / add_many / genba_source_mark の返り値) | 連絡の送り主 (連絡先に解決できた人・会社) の名前・呼び名・会社名が title / body / who に出ている未解決タスク。「この連絡で状態は変わった？」を AI に見直させる (終わった → 解決、相手待ち → `genba_log_fix(kind=待ち, who, then)`、変わらない → `genba_log_fix(id, confirm=true)`)。社内の人からの連絡では出ない |
| `genba_log_fix(id, confirm=true)` | 何も変えずに「見直した」印を edits に残す。`genba_audit` の「動きがあるのに未更新」が消える |
| `genba_room_sync(rooms)` | 監視ジョブが自分の Beeper / LINE のルーム一覧 (ID と名前だけ) を同期。返り値 `added` (初めて見えた) / `watching` (記録) / `answering` (社内の問い合わせ) |
| `genba_source_exclude(room) / include(room)` | 個人的なルームを読む対象から外す / 戻す (ルーム名か ID) |
| `genba_source_add(channel, room, site?, purpose?) / list / mark / remove` | ルームを現場に固定・用途を決める (普段は要らない)、一覧 (sources / excluded)、「ここまで読んだ」cursor、OFF |
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

### タスクカレンダー同期 (Keihi が正本、カレンダーは見る窓)
出先ではスマホのカレンダーしか見ないので、Keihi の未解決タスクを **タスク専用カレンダー「BANAX タスク」** に Keihi が自動で出す。AI は関与しない (拾い漏れを仕組みで無くす)。
- 登録: カレンダーをサービスアカウント `keihi-run@…` に変更権限で共有 → `genba_calendar_setup(calendar_id, dry_run: true)` で確認 → `dry_run` を外して登録。以後 `genba_tasks` / `genba_audit` / `genba_status` / `genba_room_sync` が読まれたときに 5 分に 1 回同期 (`POST /api/internal/genba/calendar-sync` を Cloud Scheduler で叩いてもよい)。手動は `genba_calendar_sync`、状態は `genba_calendar_status`
- Keihi → カレンダー: 未解決タスク 1 件 = 終日予定 1 件 (件名 = title、色 = who、説明に現場・本文・Keihi の ID)。期限切れは今日の日付に【期限切れ M/D】、期限なしは今日に【なるはや】で出続ける (期限そのものは書き換えない)。解決・取り消しで予定を消す
- カレンダー → Keihi: 人が予定を動かす = 期限変更、件名を変える = title 変更、消す = 解決 (本文「カレンダーで予定が消された」)。人が直接作った予定 = 次やること として取り込む (色 → 担当、件名に現場名があれば現場)。繰り返し予定は無視
- 仕組み: `genba_log.calendar_event` (予定 ID) と `cal_snapshot` (最後に書いた {date, summary, colorId})。予定の今が snapshot と違えば人が触った、Keihi の望む状態と違えば Keihi から書く。予定の `extendedProperties.private.keihiTaskId` でも結ぶ
- 設定は `genba_settings` (key `task_calendar`)。予定用の BANAX カレンダーを登録しないこと (中の予定が全部タスクになる)。決定・進捗に含まれる日程 (搬入・打ち合わせ) は今まで通り AI が BANAX カレンダーに入れて `calendar_event` を付ける

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

### どのルームを読むか (デフォルト全部、個人的なものだけ除外)
同期されたルームは全部読む対象。画面は無い (以前の `/genba/watch.html` は廃止)。
- 個人的なルーム (家族・友人・私用) は AI に「〇〇のルームは読まないで」と言えば `genba_source_exclude(ルーム名)` で外れる。戻すのは `genba_source_include`
- 初めて見えたルームは `genba_room_sync` の返り値 `added` に出る。監視ジョブはその名前をまとめて小西に見せて「読まないものある？」と 1 回聞く
- 現場は任意。`watching` の `site` が null のルームは、メッセージの内容から AI が `genba_find` で現場を決める (決まらなければ会社全般)。いつも同じ現場なら `genba_source_add(channel, room, site)` で固定
- 社内の人 (連絡先 role=社内、今は 小西・名取) の個人ルームは自動で用途 `応答` になり、問い合わせに答える (`answering`)
- 一覧は `genba_source_list` (`sources` = 読む、`excluded` = 除外)

### 監視ジョブ (Cowork 等で 5 分ごとに LINE を読んで自動記録)
0. `genba_room_sync` は新着が無くても 5 分ごとに毎回呼ぶ。サーバーが最後に呼ばれた時刻を `genba_settings.room_sync_last` に残し、30 分来なければ `genba_audit` / `genba_tasks` の `monitor` が stalled になる (Cowork のチャットを変えてスケジュールが消えた、を AI の記憶に頼らず検知する)
1. `genba_room_sync` にルーム一覧 (ID と名前) を渡す → 返り値 `watching` / `answering` が読む対象。`added` があれば小西に「読まないものある？」と聞いて `genba_source_exclude`
2. cursor より後のメッセージだけ読む (Beeper 等の MCP)
3. 読んだメッセージを 1 件ずつ分類して `genba_source_mark(channel, room, cursor, items)` に全部渡す (記録と cursor 更新を兼ねる)。決定 / 課題 / 次やること / 待ち / 進捗 は title・body を書けばサーバーが genba_log に入れる (`source_ref` / `source` 自動)。雑談・私的・画像・返信・既存も kind を付けて入れる
4. 画像・PDF は `genba_file_upload_url` → PC で `curl` PUT → 目録に kind=進捗 + photo_ids (上の「写真・ファイル」)
5. `genba_audit` の `stale_tasks` (動きがあるのに未更新): 目録に `contact_id` が残るので、関係者から連絡が来た後に触られていないタスクが出る。メールも同じ目録に入れる (`channel=Mail`, `room=差出人アドレス`。連絡先に email がある相手だけ `watching`、他は `mail_unknown`)
6. cursor は items 無しでは進まない。入らない item があればサーバーが error で止め、直して同じ items でもう一度。「読んだのに書かなかった」が構造的に起きない。`genba_audit` が 雑談 扱いされた社外からの 60 字以上の文を `chat_review` (要確認) で出す

書いた人は人ごとの URL で決まる: `GET /api/mcp-connector` (ログイン済み) が `genba.名取` / `genba.LINE監視` の URL を返す (INTERNAL_TICK_SECRET から導出、リポには無い)。

データ: `sites` に `site_code` / `drive_folder_id` / `client` 列を追加 (このアプリの画面は変えていない)、`genba_log` (追記のみ)、`genba_rules`、`genba_sources` (監視対象)、`genba_contacts` / `genba_companies` (連絡先・会社)、`genba_notes` (流れないメモ)、`genba_files` (写真の台帳、中身は GCS)。
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
