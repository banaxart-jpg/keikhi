# 現場メモ（/genba-memo/）

現場 × 日付 ごとに 1 枚のメモを書く社内専用アプリ (小西・名取限定)。
**各自のメモは自分にだけ見える**。シンプルなメモアプリ感覚で使う。

## 使い方
- ランチャーから `[edit_note] 現場メモ` をタップ
- 上段の**現場タブ**で現場を切替 (順は最後に開いた順 = MRU)
- 下段の**日付タブ**で日を切替: 「今日」が常に先頭、過去の自分のメモがある日が後ろに並ぶ
- テキストエリアに書くと 800ms debounce で自動保存 (右上に「未保存→保存中→保存済み」)
- 新しい日になると「今日」タブはまっさら start
- 現場が未登録なら `/genba/` (現場アプリ) で先に登録

## データ
Firestore コレクション (sub-collection で uid 隔離):
- パス: `genba_memos/<uid>/memos/<site>__<YYYY-MM-DD>`
- フィールド: `site`, `date`, `content`, `updatedAt`

ルール: 社内 3 アカウント (`info@banax.tokyo` / `konishi0221@gmail.com` / `banaxart@gmail.com`)
限定 read/write、かつ自分の `{uid}` 配下にのみアクセス可。

## ファイル構成
- `index.html` — UI + ロジック (Vue 3 esm-browser、ビルド不要)
- `README.md` — これ

## 残課題 / 今後やりたいこと
- [ ] 画像添付
- [ ] 検索 (過去メモ全文)
- [ ] 月またぎの大量メモになったら日付ピッカー追加
