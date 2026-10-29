# スプレッドシート（/sheet/）

Google スプレッドシート風の表計算。データはこの端末のブラウザ (localStorage) に保存される。

## 使い方
- ランチャーから [スプレッドシート] をタップ
- セルをタップで選択、もう一度タップ (PC はダブルクリック / そのまま入力) で編集
- `=` から始めると数式。数式入力中にセルをタップすると参照 (A1 など) が入る
- 選択範囲の右下の ■ をドラッグでオートフィル (数式の参照もずれる、1,2 と並べると連番)
- 長押し (PC は右クリック) でメニュー：コピー / 貼り付け / 行・列の挿入削除 / 並べ替え
- スマホは長押ししたまま指を動かすと範囲選択
- 下のタブでシート追加・名前変更・削除。右上のフォルダからファイル切替・CSV 読込/保存
- 範囲を選ぶと右下に合計 / 平均 / カウント (タップで切替)

## 使える関数
SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTBLANK, PRODUCT, IF, IFS, IFERROR, AND, OR, NOT,
ROUND, ROUNDUP, ROUNDDOWN, INT, ABS, MOD, SQRT, POWER, PI, RAND, RANDBETWEEN,
SUMIF, SUMIFS, COUNTIF, COUNTIFS, AVERAGEIF, VLOOKUP, HLOOKUP, INDEX, MATCH,
CONCAT, CONCATENATE, TEXTJOIN, LEN, LEFT, RIGHT, MID, UPPER, LOWER, TRIM, SUBSTITUTE,
TODAY, NOW, ISBLANK, ISNUMBER, ISTEXT, ISERROR, VALUE, N

別シート参照は `シート2!A1` の形。

## ファイル構成
- `index.html` — UI + 数式エンジン + 保存 (1ファイル完結、サーバーなし)

## 残課題 / 今後やりたいこと
- [ ] 端末をまたいで同期 (今は端末ごとの保存。Firestore に載せれば共有もできる)
- [ ] 罫線・セル結合
- [ ] 日付型 (今は文字列扱い)
- [ ] グラフ
