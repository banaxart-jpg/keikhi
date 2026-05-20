# AIコスト計算 (`/cost/`)

各ミニアプリの累積 AI 利用コスト（概算）を表示するダッシュボード。

## 何ができる

- アプリごとにタブ切替（現状は `💴 経費` 1個）
- 累積コスト・読取回数・1件平均・今月のコスト
- 月別推移（直近6ヶ月）
- 1件あたりトークン内訳（モデル・入力/出力 tokens × 単価）

## 使い方

- ランチャーから 🧮 タブ
- 上部タブでアプリ切替
- 右上「⟳ 更新」で最新データ取得

## ファイル構成

- `index.html` — 1ファイル完結（HTML + CSS + JS）
- バックエンドなし（既存の `keihi-api` の `/api/records` を ID トークン認証で叩く）

## 新しいAIアプリのタブを追加する

`index.html` 内の `APPS` 配列に1ブロック追加：

```js
{
  id: "myapp",
  label: "📋 マイアプリ",
  fetchPath: "/api/myapp",      // 件数を返すエンドポイント
  perCallJpy: 0.5,              // 1回あたりの概算コスト（円）
  perCallBreakdown: {
    model: "gemini-2.5-flash",
    inputTokens: 1500,
    outputTokens: 500,
    inPriceUsdPerM: 0.30,
    outPriceUsdPerM: 2.50,
  },
  unitName: "件",
  dateField: "createdAt",
},
```

タブが自動で増える。

## 注意

- これは概算値。実際の課金は GCP Billing で確認
- 末尾の Billing リンクから直接 GCP の課金レポートに飛べる
