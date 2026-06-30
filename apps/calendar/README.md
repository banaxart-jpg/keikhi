# カレンダー（/calendar/）

自分の Google カレンダーを読み取って、月表示＋その日の予定リストで見やすく表示するアプリ（読み取り専用）。

## 使い方
- ランチャーから [カレンダー] をタップ
- 初回だけ「連携する」→ Google の同意画面で読み取り許可
- 月をスワイプ感覚で `<` `>` 切替、「今日」ボタンで今月へ
- 日付をタップ → 下にその日の予定が時間順で並ぶ
- 予定の色はカレンダーごとの色をそのまま反映

## 仕組み
- Firebase の Google ログインに **`calendar.readonly` スコープ**を追加で要求し、
  OAuth access token を取得して Google Calendar API を直接叩く（管理アプリ `/admin/` と同じ方式）
- `users/me/calendarList` で表示中カレンダー一覧、各カレンダーの `events` を表示月の範囲で取得
- token は `sessionStorage` に保持。期限切れ(401)で再連携を促す

## ⚠️ 動かすのに必要な Google 側の1回設定（小西）
このアプリは前段でブラウザから連携するが、Google プロジェクト側で下記が有効でないと
access token が取れず「連携」で止まる：

1. **Google Calendar API を有効化**（GCP コンソール / 当該プロジェクト）
2. **OAuth 同意画面に `https://www.googleapis.com/auth/calendar.readonly` スコープを登録**
   - `calendar.readonly` は機密スコープ。外部公開アプリだと審査が要る場合あり
     （Workspace 内部ユーザー運用なら審査不要）

設定が無い状態で連携すると、画面に「Calendar API の有効化と同意画面へのスコープ登録が必要」と出る。

## ファイル構成
- `index.html` — UI + Google Calendar 取得ロジック（1ファイル完結）

## 残課題 / 今後やりたいこと
- [ ] 週表示 / 予定だけのリスト表示の切替
- [ ] 複数カレンダーの表示 ON/OFF トグル
- [ ] 予定タップで詳細（説明・参加者・場所地図）
- [ ] 予定の追加・編集（書き込みスコープ。要・小西の許可拡張）
