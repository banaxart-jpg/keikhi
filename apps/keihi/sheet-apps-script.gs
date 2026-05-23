/**
 * 経費アプリ → Google スプレッドシート 連携用 Apps Script
 *
 * ─── 設定手順（初回1回だけ） ───
 *  1. Google ドライブで「新規 → Google スプレッドシート」でファイルを1つ作る
 *  2. メニュー「拡張機能 → Apps Script」を開く
 *  3. 開いた Apps Script のエディタの function myFunction() {…} を全部消して、
 *     このファイル (sheet-apps-script.gs) の中身を丸ごとコピペ
 *  4. 右上の「保存」(💾) を押す
 *  5. 右上の「デプロイ」→「新しいデプロイ」をクリック
 *  6. 歯車アイコン → 「ウェブアプリ」を選択
 *       - 説明:         なんでもOK
 *       - 実行ユーザー: 自分
 *       - アクセス権:   全員（リンクを知っている全員）
 *  7. 「デプロイ」→ 出てきた「ウェブアプリの URL」をコピー
 *  8. 経費アプリの「経費記録」画面 → 「スプレッドシート連携」に URL を貼り付け
 *
 * ─── コード差し替え時 ───
 *  - 上記 3〜4 と同じ手順でコードを貼り直し
 *  - 右上「デプロイ」→「デプロイを管理」→ 鉛筆マーク（編集）→
 *    「バージョン」を「新しいバージョン」にして「デプロイ」
 *  - URL は変わらないのでアプリ側設定は触らなくて OK
 *
 * ─── 仕様 ───
 *  - 経費登録1件ごとに 1 行追加される
 *  - 購入日の「年月」(例: 2026-05) でタブが自動で分かれる (新しい月が左)
 *  - 列: 購入日 / 購入者 / 現場 / 店舗 / 金額 / 費目 / 工種 / 支払方法 / メモ / 写真
 *  - 「写真」セルをクリックすると経費アプリが開き、ログイン後にレシート画像表示
 *  - 折り返しオフ + 行高さ22pxで200件規模でもガタガタしない
 */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ym = String(data.date || "").slice(0, 7) || "unknown";
    let sheet = ss.getSheetByName(ym);
    if (!sheet) {
      sheet = ss.insertSheet(ym, 0);
      sheet.appendRow(["購入日", "購入者", "現場", "店舗", "金額", "費目", "工種", "支払方法", "メモ", "写真"]);
      sheet.setFrozenRows(1);
      sheet.setColumnWidth(1, 90);   // 購入日
      sheet.setColumnWidth(2, 70);   // 購入者
      sheet.setColumnWidth(3, 130);  // 現場
      sheet.setColumnWidth(4, 170);  // 店舗
      sheet.setColumnWidth(5, 100);  // 金額
      sheet.setColumnWidth(6, 100);  // 費目
      sheet.setColumnWidth(7, 80);   // 工種
      sheet.setColumnWidth(8, 80);   // 支払方法
      sheet.setColumnWidth(9, 220);  // メモ
      sheet.setColumnWidth(10, 60);  // 写真 (リンク)
      sheet.getRange("E:E").setNumberFormat("¥#,##0");
      sheet.getRange(1, 1, sheet.getMaxRows(), 10).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
      sheet.setRowHeights(2, sheet.getMaxRows() - 1, 22);
    }
    const row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, 1, 9).setValues([[
      data.date || "",
      data.buyer || "",
      data.site || "",
      data.store || "",
      Number(data.total) || 0,
      data.category || "",
      data.workType || "",
      data.payment || "",
      data.memo || "",
    ]]);
    if (data.viewUrl) {
      const safeUrl = String(data.viewUrl).replace(/"/g, '""');
      sheet.getRange(row, 10).setFormula('=HYPERLINK("' + safeUrl + '","🧾")');
    }
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput("expense sheet endpoint");
}
