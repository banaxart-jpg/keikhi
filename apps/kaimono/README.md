# 手配リスト (/kaimono/)

現場ごとに「用意しておいてほしい工具・材料」を Firestore でリアルタイム共有するミニアプリ。

> URL は歴史的経緯で `/kaimono/` のまま (旧称: 買い物)。
> Firestore コレクションも `shopping_items` のまま (リネームなし)。

## 使い方
- ランチャーから [📦 手配リスト] をタップ
- 現場タブを切り替え (アクティブな現場ほど左)
- 右下の `+` FAB タップで入力モーダル展開
  - 品名 / 数 / 単位 / 材料 or 工具 タグ
- 左の丸タップで「手配済」チェック (取消線)
- 右の `×` で個別削除 (confirm あり)
- 「✓ 済みを削除」でその現場の済みを一括削除

別端末で開いてる人にも即時反映 (Firestore `onSnapshot` 購読)。

## アクセス
**Google サインインしてれば誰でも** 入れる (techstudy と同じ扱い)。
社外メアドでも OK。

## ファイル構成
- `index.html` — Vue 3 (esm-browser CDN) + Firestore リアルタイム
- `icon.svg` — ランチャー / apple-touch-icon 用

## データ形状 (Firestore: `shopping_items/{docId}`)
```
{
  name: "65スタッド2500",
  qty: 13,                // number | null
  unit: "本",             // string | null
  category: "材料",       // "材料" | "工具" | null
  site: "駒込",
  checked: false,
  createdAt: <serverTimestamp>,
  addedBy: "konishi0221@gmail.com",
  checkedAt: <serverTimestamp | null>,
  checkedBy: "info@banax.tokyo" | null,
  seedTag?: "komagome_v1"   // seed 投入時のみ
}
```

旧 docs に `text` フィールドしか無い場合は `displayName(item) = name || text` で互換表示。

## 現場リスト
`/api/sites` (= keihi2 と同じ Cloud SQL `sites` テーブル) から取得。
- GET は社外 auth ユーザーにも開放 (server middleware に bypass あり)
- POST/DELETE は社内 3 アカウント限定 (keihi2 経由でメンテ)

## 残課題
- [ ] 数量・単位の編集 UI (今は削除→再追加)
- [ ] 「最近よく頼まれるもの」サジェスト
- [ ] 完了したものを期限付きで自動アーカイブ
