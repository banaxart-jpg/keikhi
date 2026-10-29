# スプレッドシート（/sheet/）

Google スプレッドシート風の表計算。データはサーバー (Cloud SQL) に保存されて社内で共有。
AI (Claude) も統合コネクタの `sheet_*` ツールで同じファイルを読み書きできる。画面を開いたままでも、AI が書いた内容は数秒で出てくる。

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

## AI から使う (MCP)
claude.ai に登録済みの統合コネクタ (`/api/mcp/<token>`) にそのまま載っている。追加の登録は要らない。

| ツール | やること |
|---|---|
| `sheet_list` | ファイル一覧 (シート名・使っている範囲つき) |
| `sheet_read` | 値を読む (数式は計算結果 + 式そのもの) |
| `sheet_write` | 左上を決めて 2 次元配列で書く (`=` で始まれば数式) |
| `sheet_append_rows` | 表の一番下に行を足す |
| `sheet_clear` / `sheet_format` | 消す / 太字・色・¥ 表示・列幅 |
| `sheet_rows_cols` | 行・列の挿入削除 (数式の参照もずれる) |
| `sheet_tab` | シートの追加・名前変更・削除 |
| `sheet_create` / `sheet_rename` | ファイルを作る / 名前を変える |

ファイルの削除は AI からはできない (画面から人がやる)。

## ファイル構成
- `index.html` — UI (グリッド・編集・コピペ・オートフィル)、サーバーとの同期
- `apps/keihi/server/sheet-lib/engine.js` — 数式エンジン。サーバーと画面で同じファイル (画面は keihi-api の `/sheet-engine.js` から読む)
- `apps/keihi/server/sheet-lib/index.js` — 保存 (テーブル `sheet_books`、起動時に自動作成) と MCP ツール

保存は「最後にサーバーと揃った状態との差分」だけを送る。だから人と AI が同時に別のセルを触っても消し合わない。

## 残課題 / 今後やりたいこと
- [ ] 罫線・セル結合
- [ ] 日付型 (今は文字列扱い)
- [ ] グラフ
