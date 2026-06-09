# 現場マスタ（/genba/）

現場 (site) の登録・編集・削除を一元管理するアプリ。
住所とキーボックス情報 (暗証番号 / 設置場所など) を 現場ごとにメモできる。

他ミニアプリ (経費 / 経費2 / 請求書 / 手配リスト / タスク) は
このマスタの現場名を **読み取り専用** で参照する。
**新規追加・削除はこのアプリ独占。**

## 使い方
- ランチャーから `[domain] 現場マスタ` をタップ
- 一覧から現場をタップ → 住所・キーボックスを展開表示
- 展開後に `編集` または `削除`
- 右上 `+ 追加` で新規作成
- 他アプリ (例: 経費) の「現場マスタで追加」リンクから来た場合、保存後に元アプリに戻る (`?return=/keihi/&newSite=true`)

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
