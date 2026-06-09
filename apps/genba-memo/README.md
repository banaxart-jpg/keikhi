# 現場メモ（/genba-memo/）

現場 × 日付 ごとに 1 枚のメモを書く社内専用アプリ (小西・名取限定)。
名取と小西の 2 人で realtime 同期しながら同じ現場のメモを共同編集できる。

## 使い方
- ランチャーから `[edit_note] 現場メモ` をタップ
- 上部の現場タブで現場切替 (順は最後に開いた順 = MRU)
- 真ん中の日付ナビ `< 今日 (M/D) >` で日付移動
- テキストエリアに書くと 800ms debounce で自動保存 (右上に「未保存→保存中→保存済み」表示)
- 新しい日になったら自動的に**まっさらな新規メモ**から始まる
- 「過去のメモ」を展開すると同現場の過去 60 件が新しい順で出る、タップで切替
- 現場がまだ無い場合は `/genba/` (現場アプリ) で先に登録

## データ
Firestore コレクション `genba_memos`:
- doc id = `<現場名>__<YYYY-MM-DD>` (JST)
- フィールド: `site`, `date`,
  - `natori: { content, updatedAt, updatedBy }`
  - `konishi: { content, updatedAt, updatedBy }`

著者ごとにサブツリーを持つので、同じ doc を両者が並行編集しても上書きしない (merge:true)。
画面では「名取のメモ」「小西のメモ」を 2 段で並べて表示、自分のだけ編集可・相手のは
read-only で realtime に流れてくる。

ルール: 社内 3 アカウント (`info@banax.tokyo` / `konishi0221@gmail.com` / `banaxart@gmail.com`) 限定 read/write。
メアド → 著者キー: `info@banax.tokyo` と `banaxart@gmail.com` は両方 `natori`、
`konishi0221@gmail.com` は `konishi`。

## ファイル構成
- `index.html` — UI + ロジック (Vue 3 esm-browser、ビルド不要)
- `README.md` — これ

## 残課題 / 今後やりたいこと
- [ ] 画像添付 (建材写真とか直接貼れたら便利)
- [ ] 検索 (過去メモ全文検索)
- [ ] テンプレ (繰り返し書く項目をひな型で挿入)
