/**
 * 経費アプリ → Google スプレッドシート 連携用 Apps Script
 *
 * ─── 設定手順（初回1回だけ） ───
 *  1. Google ドライブで「新規 → Google スプレッドシート」でファイルを1つ作る
 *  2. メニュー「拡張機能 → Apps Script」を開く
 *  3. 開いた Apps Script のエディタにある  function myFunction() {…}  を全部消して、
 *     このファイル (sheet-apps-script.gs) の中身を丸ごとコピペ
 *  4. 右上の「保存」(💾) を押す
 *  5. 右上の「デプロイ」→「新しいデプロイ」をクリック
 *  6. 歯車アイコン → 「ウェブアプリ」を選択
 *       - 説明:         なんでもOK（例: 経費アプリ連携）
 *       - 実行ユーザー: 自分
 *       - アクセス権:   全員（リンクを知っている全員）
 *  7. 「デプロイ」→ 出てきた「ウェブアプリの URL」をコピー
 *       （ https://script.google.com/macros/s/XXXX…/exec の形）
 *  8. 経費アプリの「経費記録」画面 → 「スプレッドシート連携」を開いて、
 *     その URL を貼り付けて「保存」→「テスト送信」で動作確認
 *
 * ─── 仕様 ───
 *  - 経費登録1件ごとに 1 行追加される
 *  - 購入日の「年月」(例: 2026-05) でタブ（シート）が自動で分かれる
 *  - 新しい月のタブは先頭（左）に追加される
 *  - 列: 購入日 / 購入者 / 現場 / 店舗 / 金額 / 費目 / 工種 / 支払方法 / メモ
 */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ym = String(data.date || "").slice(0, 7) || "unknown"; // "2026-05"
    let sheet = ss.getSheetByName(ym);
    if (!sheet) {
      // 新しい月のタブは一番左に作る（最新月が左に並ぶ）
      sheet = ss.insertSheet(ym, 0);
      sheet.appendRow([
        "購入日", "購入者", "現場", "店舗", "金額",
        "費目", "工種", "支払方法", "メモ",
      ]);
      sheet.setFrozenRows(1);
      // 金額列を ¥ 区切り表示
      sheet.getRange("E:E").setNumberFormat("¥#,##0");
      // 列幅をそれっぽく
      sheet.setColumnWidths(1, 9, 100);
      sheet.setColumnWidth(3, 140); // 現場
      sheet.setColumnWidth(4, 160); // 店舗
      sheet.setColumnWidth(9, 200); // メモ
    }
    sheet.appendRow([
      data.date || "",
      data.buyer || "",
      data.site || "",
      data.store || "",
      Number(data.total) || 0,
      data.category || "",
      data.workType || "",
      data.payment || "",
      data.memo || "",
    ]);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 動作確認用: Apps Script エディタで「doGet」を選んで実行→デプロイ後にこの URL を
// ブラウザで開くと "expense sheet endpoint" と表示される。
function doGet() {
  return ContentService.createTextOutput("expense sheet endpoint");
}
