# カレンダーアプリ 有効化手順（小西用）

`/calendar/` は Firebase の Google ログインに `calendar.readonly` スコープを追加要求して、
取得した OAuth access token で Google Calendar API を**ブラウザから直接**叩く。
仕組みは既存の `/admin/`（`cloud-platform.read-only` を同方式で使用）と同じなので、
**OAuth クライアント自体は既存のものをそのまま使える**。やることは下の 2 つだけ。

> 対象プロジェクト = Firebase / GCP プロジェクト（`/__/firebase/init.json` の `projectId`）。
> `/admin/` が動いているのと同じプロジェクト。

---

## ① Google Calendar API を有効化

**コンソール:** APIs & Services → Library →「Google Calendar API」→ **Enable**

**gcloud:**
```bash
gcloud services enable calendar-json.googleapis.com --project <PROJECT_ID>
```

---

## ② OAuth 同意画面に calendar.readonly スコープを追加

APIs & Services → **OAuth consent screen** → Edit app → **Scopes** → Add or remove scopes →
下記を手入力で追加して Update → Save：

```
https://www.googleapis.com/auth/calendar.readonly
```

---

## ⚠️ スコープの「機密」扱いについて（ここだけ判断が要る）

`calendar.readonly` は Google の **sensitive scope**。同意画面の User type で扱いが変わる：

| User type | 挙動 | 対応 |
|---|---|---|
| **Internal**（Workspace 組織内のみ） | 審査不要・警告なしで即使える | **これが一番ラク。** 組織アカウント運用ならこれ推奨 |
| **External + Testing** | テストユーザーに登録したアカウントだけ使える。審査不要だが「未確認アプリ」警告が出る | 自分のアカウントを Test users に追加すれば OK |
| **External + In production** | sensitive scope は Google の**検証（verification）が必要**になる | 検証申請が要る＝重い。社内運用なら Internal にした方が早い |

→ **Workspace 組織なら User type = Internal にしてしまうのが一番手っ取り早い**（審査も警告もなし）。
`/admin/` が今どの設定で動いてるかに合わせれば、それと同じでいける。

---

## ③ 動作確認

1. デプロイ後 `/calendar/` を開く（左上 `v.65666e5` 以降）
2. 「連携する」→ Google の同意画面に「カレンダーの予定の表示」が出る → 許可
3. 月グリッドに予定が出れば OK

うまくいかないとき：
- 連携押しても画面に「Calendar API の有効化と…スコープ登録が必要」 → ①② のどちらかが未反映
- 「未確認アプリ」警告で止まる → 同意画面が External + Testing。自分を Test users に追加 or Internal 化
- 予定が空 → そのアカウントにその月の予定が無いだけ（別の月へ送って確認）

---

## メモ（書き込み対応するなら将来）
今は読み取り専用（`calendar.readonly`）。予定の追加・編集まで対応するなら
`https://www.googleapis.com/auth/calendar.events`（書き込み）スコープの追加が要る。
書き込みは事故ると本物の予定が変わるので、対応するとき改めて相談で。
