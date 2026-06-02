# 買い物 (/kaimono/)

現場ごとに買い物リストを Firestore でリアルタイム共有するミニアプリ。

## 使い方
- ランチャーから [🛒 買い物] をタップ
- 現場タブ (共通 / 西新井焼肉屋 / 宇佐美別荘 / 倉庫改装) を切り替え
- 下の入力欄にアイテム名 → `+` で追加
- 左の丸タップで購入済みチェック (取消線)
- 右の `×` で個別削除
- 「✓ 済みを削除」でその現場の済みを一括削除

別端末で開いてる人にも即時反映 (Firestore `onSnapshot` 購読)。

## ファイル構成
- `index.html` — Vue 3 (esm-browser CDN) + Firestore リアルタイム
- `icon.svg` — ランチャー / apple-touch-icon 用

## データ形状 (Firestore: `shopping_items/{docId}`)
```
{
  text: "卵",
  site: "西新井焼肉屋",
  checked: false,
  createdAt: <serverTimestamp>,
  addedBy: "konishi0221@gmail.com",
  checkedAt: <serverTimestamp | null>,
  checkedBy: "info@banax.tokyo" | null
}
```

## アクセス制御
社内 3 アカウント (`info@banax.tokyo` / `konishi0221@gmail.com` / `banaxart@gmail.com`)
のみ読み書き可。`firestore.rules` で `request.auth.token.email` でゲート。

## 残課題
- [ ] 現場を Firestore で動的に管理 (今は SITES 定数)
- [ ] 優先度 / 数量
- [ ] 「最近よく買うもの」サジェスト
