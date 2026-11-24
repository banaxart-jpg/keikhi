// 経費 (/keihi/) の MCP ツールと、画面 (REST) と共通の保存処理。
//
// 方針: 新しい登録の仕組みを作らず、画面 (index.html → /api/records・/api/scan) が通る処理をそのまま通す。
//   - DB: records に同じ INSERT / UPDATE / DELETE (insertRecord / updateRecordRow / deleteRecordRow。index.js の REST も同じ関数を呼ぶ)
//   - 写真: GCS の <今日>/<uuid>.jpg (画面が /api/scan で置く場所と同じ。長辺 1200px・JPEG 品質 70 に縮小も画面と同じ)
//   - シート: index.js の appendRecordToSheet (月別タブ + 取引シート。写真セルは 🧾 → アプリの view=ID)
//   - 選択肢 (費目・工種・支払方法・購入者) は画面の <select> / ボタンと同じ
// OCR はサーバーでしない。画像を読むのは AI で、日付・現場・店舗・金額・費目…を埋めて渡す (Gemini を通さない)。
import crypto from "node:crypto";
import sharp from "sharp";

// ───────── 画面と同じ選択肢 (apps/keihi/index.html の fCat / fWork / .pay-btn / .buyer-btn) ─────────
export const CATEGORIES = ["材料費", "接待交際費", "ガソリン代", "駐車場代", "工具・備品", "外注費", "その他"];
export const WORK_TYPES = ["水道", "電気", "木工", "塗装", "左官", "内装", "外構", "解体", "設備", "その他"];
export const PAYMENTS = ["現金", "カード", "電子マネー", "振込"];
export const BUYERS = ["小西", "名取"];
// 画面の既定 (showConfirm: AI が拾えなかったとき)
export const DEFAULTS = { workType: "その他", payment: "現金" };

const MAX_BATCH = 30;                      // 1 回で登録できる枚数
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;  // 1 枚の入力の上限 (縮小前)
const MAX_EDGE = 1200, JPEG_QUALITY = 70;  // 画面の resizeImage(file, 1200) / toDataURL("image/jpeg", 0.7) と同じ
const TOKEN_TTL_MS = 6 * 3600 * 1000;      // 写真の置き場 URL の有効期間
const SIGN_MIN = 10;                       // 写真の閲覧 URL の有効分 (画面の /api/records/:id/image と同じ)

// ───────── 表記ゆれ (画面は選ぶだけだが、AI は言葉で渡すので、よくある言い方は寄せる) ─────────
const squash = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　・]/g, "").toLowerCase();
const CATEGORY_ALIAS = new Map([
  ["材料", "材料費"], ["材料費", "材料費"], ["資材", "材料費"], ["消耗品", "材料費"], ["消耗品費", "材料費"],
  ["交際費", "接待交際費"], ["接待", "接待交際費"], ["接待交際費", "接待交際費"], ["会食", "接待交際費"],
  ["ガソリン", "ガソリン代"], ["ガソリン代", "ガソリン代"], ["燃料", "ガソリン代"], ["燃料費", "ガソリン代"], ["給油", "ガソリン代"],
  ["駐車場", "駐車場代"], ["駐車場代", "駐車場代"], ["パーキング", "駐車場代"], ["駐車料金", "駐車場代"],
  ["工具", "工具・備品"], ["備品", "工具・備品"], ["工具備品", "工具・備品"], ["工具・備品", "工具・備品"],
  ["外注", "外注費"], ["外注費", "外注費"], ["その他", "その他"], ["雑費", "その他"],
]);
const WORKTYPE_ALIAS = new Map(WORK_TYPES.flatMap((w) => [[squash(w), w], [squash(w + "工事"), w]]));
const PAYMENT_ALIAS = new Map([
  ["現金", "現金"], ["現金払い", "現金"], ["キャッシュ", "現金"], ["cash", "現金"],
  ["カード", "カード"], ["クレジット", "カード"], ["クレジットカード", "カード"], ["クレカ", "カード"], ["カード払い", "カード"], ["credit", "カード"],
  ["電子マネー", "電子マネー"], ["paypay", "電子マネー"], ["suica", "電子マネー"], ["pasmo", "電子マネー"], ["ic", "電子マネー"], ["交通系ic", "電子マネー"], ["id", "電子マネー"], ["quicpay", "電子マネー"], ["d払い", "電子マネー"], ["楽天pay", "電子マネー"], ["メルペイ", "電子マネー"], ["qr", "電子マネー"], ["qr決済", "電子マネー"],
  ["振込", "振込"], ["銀行振込", "振込"], ["振り込み", "振込"], ["振込み", "振込"],
]);
const pick = (map, v, list, label) => {
  const k = squash(v);
  const hit = map.get(k) || list.find((x) => squash(x) === k);
  if (!hit) throw new Error(`${label}は ${list.join(" / ")} のどれか (指定: ${v})`);
  return hit;
};
const normCategory = (v) => pick(CATEGORY_ALIAS, v, CATEGORIES, "費目");
const normWorkType = (v) => pick(WORKTYPE_ALIAS, v, WORK_TYPES, "工種");
const normPayment = (v) => pick(PAYMENT_ALIAS, v, PAYMENTS, "支払方法");
const normBuyer = (v) => { const s = String(v ?? "").trim(); if (!BUYERS.includes(s)) throw new Error(`購入者は ${BUYERS.join(" / ")} (指定: ${v})`); return s; };

// 日付: 2026-11-01 / 2026/11/1 / 2026.11.1 / 2026年11月1日 → YYYY-MM-DD (実在する日だけ)
export function parseDate(v) {
  const s = String(v ?? "").normalize("NFKC").trim();
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) throw new Error(`日付は YYYY-MM-DD (指定: ${v || "空"})。年が無い日付は、年を補って渡す`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`実在しない日付: ${v}`);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function parseTotal(v) {
  const n = typeof v === "number" ? v : Number(String(v ?? "").normalize("NFKC").replace(/[¥￥,\s円]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`金額は 1 円以上の数値 (指定: ${v ?? "空"})`);
  if (!Number.isInteger(n)) throw new Error(`金額は整数の円 (指定: ${v})`);
  if (n > 2147483647) throw new Error(`金額が大きすぎる (指定: ${v})`);
  return n;
}
const normStore = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s\-_・.,、。()（）「」『』]/g, "");

// 画像の先頭バイトから HEIC を見分ける (iPhone の写真)。sharp の既製バイナリは HEIC を読めない
const isHeic = (b) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)/.test(b.toString("latin1", 8, 12));
const isPdf = (b) => b.length > 4 && b.toString("latin1", 0, 4) === "%PDF";

const b64u = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// ───────── 手順書 (統合コネクタ・人ごとの URL の instructions に載る) ─────────
export const EXPENSE_INSTRUCTIONS = [
  "■ 経費 (keihi_*): 経費アプリ (/keihi/) でできることを全部チャットでやる。チャットに領収書の画像が貼られたら、keihi_receipt_add で登録まで終わらせる (画面を開かせない)",
  "- 流れ: ① 画像を読んで 日付・現場・店舗・金額 (税込の支払額)・費目・工種・支払方法・メモ を決める (OCR はサーバーでしない。AI が読む) ② 迷うときは keihi_receipt_hints(stores=[店名…]) で同じ店の過去の登録を見て、費目・工種・現場・支払方法を過去に合わせる ③ keihi_receipt_add(receipts=[…]) に、貼られた枚数ぶんまとめて 1 回で渡す ④ 返り値の id・view_url・シートのタブを短く報告する",
  "- 写真の渡し方 (領収書 1 枚 = 1 件につき 1 枚): 外に出られる環境なら keihi_receipt_upload_url(count=枚数) で URL をもらい、返ってきた curl で画像を PUT して photo_ref を receipts に入れる。外に出られない環境なら photo_base64 (1 枚数 MB まで。サーバーが縮小する) で直接渡す。写真なしでも登録はできるが、証憑なので付ける",
  "- 現場は表記ゆれを吸収する (「入谷」「共通」「会社」も可)。候補が複数・見つからないときはエラーで返るので、keihi_sites で一覧を見て人に聞く。購入者は呼び出したトークンの持ち主で自動で入る (自分で書かない)",
  "- 同じ日付・店舗・金額が既にあれば、入れずに duplicate: true と既存の id が返る (同じ領収書を 2 回貼られても 1 件)。別の買い物なら force=true",
  "- 修正は keihi_receipt_update、削除は keihi_receipt_delete (人に確認してから confirm=true)。一覧・検索は keihi_receipt_list、集計は keihi_receipt_summary、写真は keihi_receipt_photo、CSV は keihi_receipt_export_csv、シートへの書き出し直しは keihi_receipt_sheet_sync",
  "- 現場の追加・編集は経費アプリでなく現場アプリ側 (genba_register)。keihi_sites は経費で選べる現場の一覧",
];

const CHOICES_TEXT = `費目は ${CATEGORIES.join(" / ")}、工種は ${WORK_TYPES.join(" / ")}、支払方法は ${PAYMENTS.join(" / ")}`;
const GUIDE_TEXT = [
  "費目の選び方: 材料費 = 工事に使う材料・消耗品 (ホームセンター・建材店・ネジ・塗料・テープなど)。工具・備品 = 工具・道具・事務用品・備品。ガソリン代 = 給油。駐車場代 = コインパーキング等。外注費 = 職人・業者への支払い。接待交際費 = 取引先・職人との飲食・手土産・贈答。その他 = どれにも当たらないもの (例: お茶代・雑費)",
  "工種の選び方: その買い物が何の工事に使われたか (水道・電気・木工・塗装・左官・内装・外構・解体・設備)。ガソリン代・駐車場代・飲み物など工事の種類が決まらないもの、分からないものは「その他」",
  "支払方法はレシートの支払欄から: 現金 (CASH・現金) / カード (クレジット・VISA・JCB・AMEX など) / 電子マネー (PayPay・Suica・iD・QUICPay・d払い・楽天Pay・メルペイ) / 振込。読めなければ現金 (画面の既定)",
  "どれを選ぶか迷ったら、同じ店の過去の登録に合わせる (keihi_receipt_hints)",
].join("。 ");

export function createExpense({
  getPool, getStorage, bucket, publicUrl = "", secret = "", appUrl = "https://keihi-496002.web.app",
  findSites, appendRecordToSheet = null, syncSheets = null, today = null,
}) {
  const todayStr = () => (today ? today() : new Date().toISOString().slice(0, 10));
  const viewUrl = (id) => `${appUrl}/keihi/?view=${id}`;
  const pool = () => { const p = getPool(); if (!p) throw new Error("DB not configured"); return p; };
  const store = () => { const s = getStorage && getStorage(); if (!s || !bucket) throw new Error("Storage not configured"); return s; };

  // ───────── 画面と共通の保存処理 (index.js の /api/records* が同じ関数を呼ぶ) ─────────
  const LIST_SQL = `SELECT id, date::text AS date, store, total, category,
              work_type AS "workType", payment, buyer, site, memo,
              image_url AS "imageUrl", drive_url AS "driveUrl", created_at AS "createdAt"
         FROM records`;
  async function listAll() {
    const { rows } = await pool().query(`${LIST_SQL}\n        ORDER BY date DESC, id DESC LIMIT 1000`);
    return rows;
  }
  async function insertRecord(r) {
    const { rows } = await pool().query(
      `INSERT INTO records (date, store, total, category, work_type, payment, buyer, site, memo, image_url, drive_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, created_at`,
      [r.date, r.store, r.total, r.category, r.workType, r.payment, r.buyer, r.site, r.memo || "", r.imageUrl || null, r.driveUrl || null]);
    return rows[0];
  }
  async function updateRecordRow(id, r) {
    const { rowCount } = await pool().query(
      `UPDATE records SET
         date=$1, store=$2, total=$3, category=$4, work_type=$5,
         payment=$6, buyer=$7, site=$8, memo=$9,
         drive_url=COALESCE($10, drive_url)
       WHERE id=$11`,
      [r.date, r.store, r.total, r.category, r.workType, r.payment, r.buyer, r.site, r.memo || "", r.driveUrl || null, id]);
    return rowCount;
  }
  async function deleteRecordRow(id) {
    await pool().query("DELETE FROM records WHERE id = $1", [id]);
  }
  async function getImageGsUrl(id) {
    const { rows } = await pool().query("SELECT image_url FROM records WHERE id=$1", [id]);
    return rows[0]?.image_url || null;
  }
  // gs:// → 一時的な https (画面の /api/records/:id/image と同じ。10 分)
  async function signedReadUrl(gs) {
    const [, , b, ...rest] = String(gs).split("/");
    const [url] = await store().bucket(b).file(rest.join("/")).getSignedUrl({ action: "read", expires: Date.now() + SIGN_MIN * 60 * 1000 });
    return url;
  }
  // /api/scan が写真を置く場所と同じ形: gs://<bucket>/<今日>/<uuid>.<jpg|pdf>。失敗は呼び出し側が決める
  async function putReceiptObject(buf, mimeType) {
    const ext = mimeType === "application/pdf" ? "pdf" : "jpg";
    const key = `${todayStr()}/${crypto.randomUUID()}.${ext}`;
    await store().bucket(bucket).file(key).save(buf, { contentType: mimeType, resumable: false });
    return { imageUrl: `gs://${bucket}/${key}`, key };
  }

  // ───────── 写真 ─────────
  async function shrinkImage(input) {
    if (!input.length) throw new Error("写真の中身が空");
    if (input.length > MAX_IMAGE_BYTES) throw new Error(`写真が大きすぎる (${Math.round(input.length / 1024 / 1024)}MB。${MAX_IMAGE_BYTES / 1024 / 1024}MB まで)`);
    if (isPdf(input)) throw new Error("PDF は付けられない (画像 = JPEG / PNG / HEIC / WebP だけ)");
    let buf = input;
    if (isHeic(buf)) {
      try {
        const { default: heicConvert } = await import("heic-convert");
        buf = Buffer.from(await heicConvert({ buffer: buf, format: "JPEG", quality: 0.9 }));
      } catch (e) { throw new Error(`HEIC を読めなかった: ${e.message}`); }
    }
    try {
      return await sharp(buf, { failOn: "none" }).rotate().flatten({ background: "#ffffff" })
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY }).toBuffer();
    } catch (e) { throw new Error(`画像として読めなかった: ${e.message}`); }
  }
  const sign = (s) => crypto.createHmac("sha256", secret).update(s).digest("hex").slice(0, 32);
  function mintRef(by, key) {
    if (!secret) throw new Error("アップロードの秘密鍵 (INTERNAL_TICK_SECRET) が無い");
    const body = b64u(JSON.stringify({ k: key, b: by, e: Date.now() + TOKEN_TTL_MS }));
    return `${body}.${sign(body)}`;
  }
  function readRef(ref) {
    const [body, sig] = String(ref || "").split(".");
    if (!body || !sig || !secret) return null;
    const a = Buffer.from(sign(body)), b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try { const p = JSON.parse(unb64u(body)); return p && p.k && p.e > Date.now() ? p : null; } catch { return null; }
  }
  // PUT /api/keihi/upload/:token (認証ミドルウェアの前に express.raw と一緒にマウント)。縮小して、URL を作ったときに決めた場所へ置く
  function uploadRoute() {
    return async (req, res) => {
      try {
        const t = readRef(req.params.token);
        if (!t) return res.status(403).json({ error: "token が無効か期限切れ。keihi_receipt_upload_url で作り直す" });
        const raw = Buffer.isBuffer(req.body) ? req.body : null;
        if (!raw || !raw.length) return res.status(400).json({ error: "本文が空。--data-binary @file で送る" });
        const out = await shrinkImage(raw);
        await store().bucket(bucket).file(t.k).save(out, { contentType: "image/jpeg", resumable: false });
        res.json({ ok: true, photo_ref: req.params.token, bytes_in: raw.length, bytes_stored: out.length, note: "photo_ref を keihi_receipt_add の receipts[].photo_ref に入れる" });
      } catch (e) {
        console.error("[keihi] upload", e);
        res.status(e.message && /読めなかった|空|大きすぎる|PDF/.test(e.message) ? 400 : 500).json({ error: e.message });
      }
    };
  }

  // ───────── 現場 (genba_find と同じ検索。「共通」「会社」も現場として選べる) ─────────
  async function resolveSiteName(p, q) {
    const s = String(q ?? "").trim();
    if (!s) throw new Error("site が必要 (現場名。共通・会社も可)");
    const hits = await findSites(p, s, 5);
    if (!hits.length) throw new Error(`現場が見つからない: ${s}。keihi_sites で一覧を見る (現場の追加は genba_register)`);
    if (hits.length > 1) throw new Error(`現場の候補が複数: ${hits.map((r) => r.name).join(" / ")}。現場名か案件 ID で指定する`);
    return hits[0].name;
  }

  // ───────── 出力の形 ─────────
  const recOut = (r) => ({
    id: Number(r.id), date: r.date, store: r.store, total: Number(r.total), category: r.category, work_type: r.workType, payment: r.payment,
    buyer: r.buyer, site: r.site, memo: r.memo || "", has_photo: !!r.imageUrl, view_url: viewUrl(r.id), created_at: r.createdAt,
  });
  const sheetOut = (date, st) => {
    const one = (x) => (!x ? "なし" : x.ok ? "ok" : x.skipped ? `skipped (${x.reason || "対象外"})` : `error: ${x.error || "?"}`);
    return { tab: String(date || "").slice(0, 7) || "unknown", monthly_tab: one(st?.monthly), transactions: one(st?.tx), ok: !!(st && (st.monthly?.ok || st.monthly?.skipped) && (st.tx?.ok || st.tx?.skipped)) };
  };

  // 写真の指定 (photo_ref か photo_base64) → gs:// の URL。同じ呼び出しの中で同じ写真を使い回せる (1 枚の写真に領収書が複数のとき)
  async function resolvePhoto(p, it, cache, force) {
    if (it.photo_ref) {
      if (cache.has(`ref:${it.photo_ref}`)) return cache.get(`ref:${it.photo_ref}`);
      const t = readRef(it.photo_ref);
      if (!t) throw new Error("photo_ref が無効か期限切れ。keihi_receipt_upload_url で作り直す");
      const exists = await store().bucket(bucket).file(t.k).exists().then((x) => x[0]);
      if (!exists) throw new Error("photo_ref の写真がまだ置かれていない (upload_url に画像を PUT してから渡す)");
      const gs = `gs://${bucket}/${t.k}`;
      if (!force) {
        const { rows } = await p.query(`SELECT id FROM records WHERE image_url=$1 LIMIT 1`, [gs]);
        if (rows.length) throw new Error(`この写真は登録済み (#${rows[0].id})。同じ写真を別の領収書にも使うなら force=true`);
      }
      cache.set(`ref:${it.photo_ref}`, gs);
      return gs;
    }
    if (it.photo_base64) {
      const raw = String(it.photo_base64).replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
      const hash = crypto.createHash("sha1").update(raw).digest("hex");
      if (cache.has(`b64:${hash}`)) return cache.get(`b64:${hash}`);
      const out = await shrinkImage(Buffer.from(raw, "base64"));
      const { imageUrl } = await putReceiptObject(out, "image/jpeg");
      cache.set(`b64:${hash}`, imageUrl);
      return imageUrl;
    }
    return null;
  }

  // 同じ日付・店舗・金額 (重複防止)
  async function findDuplicate(p, date, storeName, total) {
    const { rows } = await p.query(`${LIST_SQL} WHERE date=$1 AND total=$2 ORDER BY id`, [date, total]);
    const ns = normStore(storeName);
    return rows.find((r) => normStore(r.store) === ns) || null;
  }

  async function addOne(p, it, by, buyerArg, cache, force) {
    if (!it || typeof it !== "object") throw new Error("receipts の要素は { date, site, store, total, category, … }");
    const date = parseDate(it.date);
    const total = parseTotal(it.total);
    const storeName = String(it.store ?? "").trim();
    if (!storeName) throw new Error("store (店舗名) が必要");
    const site = await resolveSiteName(p, it.site);
    if (it.category == null || String(it.category).trim() === "") throw new Error(`category (費目) が必要。${CHOICES_TEXT}。迷ったら keihi_receipt_hints`);
    const category = normCategory(it.category);
    const warnings = [];
    const wtRaw = it.work_type ?? it.workType;
    const workType = wtRaw == null || String(wtRaw).trim() === "" ? (warnings.push(`work_type 未指定 → ${DEFAULTS.workType} (画面の既定)`), DEFAULTS.workType) : normWorkType(wtRaw);
    const payment = it.payment == null || String(it.payment).trim() === "" ? (warnings.push(`payment 未指定 → ${DEFAULTS.payment} (画面の既定)`), DEFAULTS.payment) : normPayment(it.payment);
    const buyerRaw = it.buyer ?? buyerArg;
    const buyer = buyerRaw ? normBuyer(buyerRaw) : (BUYERS.includes(by) ? by : (() => { throw new Error(`購入者を決められない (トークンの持ち主 ${by} は ${BUYERS.join(" / ")} ではない)。buyer を指定する`); })());
    const memo = String(it.memo ?? "").trim();

    const forceThis = force || it.force === true;
    if (!forceThis) {
      const dup = await findDuplicate(p, date, storeName, total);
      if (dup) return { ok: true, duplicate: true, id: Number(dup.id), view_url: viewUrl(dup.id), existing: recOut(dup), note: "同じ日付・店舗・金額が登録済みなので入れなかった。別の買い物なら force=true" };
    }
    const imageUrl = await resolvePhoto(p, it, cache, forceThis);
    if (!imageUrl) warnings.push("写真が付いていない (証憑なので付けるのが望ましい)");
    const rec = { date, store: storeName, total, category, workType, payment, buyer, site, memo, imageUrl, driveUrl: null };
    const saved = await insertRecord(rec);
    const id = Number(saved.id);
    let st = null;
    if (appendRecordToSheet) st = await appendRecordToSheet({ ...rec, id }).catch((e) => ({ monthly: { ok: false, error: e.message }, tx: { ok: false, error: e.message } }));
    const sheet = sheetOut(date, st);
    if (!sheet.ok) warnings.push("シートへの反映に失敗。keihi_receipt_sheet_sync(ids=[…]) でやり直せる");
    return {
      ok: true, duplicate: false, id, view_url: viewUrl(id), sheet,
      record: { id, date, store: storeName, total, category, work_type: workType, payment, buyer, site, memo, has_photo: !!imageUrl },
      warnings: warnings.length ? warnings : undefined,
    };
  }

  // ───────── 検索の条件 (list / summary / csv で共通) ─────────
  async function buildWhere(p, a) {
    const where = [], vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace("?", `$${vals.length}`)); };
    if (a.ids != null) {
      const ids = (Array.isArray(a.ids) ? a.ids : [a.ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) throw new Error("ids は記録 ID (正の整数) の配列");
      add("id = ANY(?::bigint[])", ids);
    }
    if (a.site != null && String(a.site).trim() !== "") add("site = ?", await resolveSiteName(p, a.site));
    if (a.month) {
      if (!/^\d{4}-\d{2}$/.test(String(a.month))) throw new Error("month は YYYY-MM");
      add("to_char(date, 'YYYY-MM') = ?", String(a.month));
    }
    if (a.from) add("date >= ?::date", parseDate(a.from));
    if (a.to) add("date <= ?::date", parseDate(a.to));
    if (a.category) add("category = ?", normCategory(a.category));
    const wt = a.work_type ?? a.workType;
    if (wt) add("work_type = ?", normWorkType(wt));
    if (a.payment) add("payment = ?", normPayment(a.payment));
    if (a.buyer) add("buyer = ?", normBuyer(a.buyer));
    if (a.q) { const q = `%${String(a.q).replace(/[\\%_]/g, (c) => "\\" + c)}%`; vals.push(q); where.push(`(store ILIKE $${vals.length} OR memo ILIKE $${vals.length})`); }
    if (a.min_total != null) add("total >= ?", Math.trunc(Number(a.min_total)));
    if (a.max_total != null) add("total <= ?", Math.trunc(Number(a.max_total)));
    if (a.has_photo === true) where.push("image_url IS NOT NULL");
    if (a.has_photo === false) where.push("image_url IS NULL");
    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", vals };
  }
  const filterLabel = (a) => [a.site && `現場=${a.site}`, a.month && `月=${a.month}`, a.from && `${a.from}〜`, a.to && `〜${a.to}`, a.category && `費目=${a.category}`, (a.work_type || a.workType) && `工種=${a.work_type || a.workType}`, a.payment && `支払=${a.payment}`, a.buyer && `購入者=${a.buyer}`, a.q && `検索=${a.q}`].filter(Boolean).join(" / ") || "全件";

  const FILTER_PROPS = {
    site: { type: "string", description: "現場名 (表記ゆれ・一部でも可。共通・会社も可)" },
    month: { type: "string", description: "YYYY-MM (購入日の月)" },
    from: { type: "string", description: "購入日の下限 YYYY-MM-DD" },
    to: { type: "string", description: "購入日の上限 YYYY-MM-DD" },
    category: { type: "string", enum: CATEGORIES },
    work_type: { type: "string", enum: WORK_TYPES },
    payment: { type: "string", enum: PAYMENTS },
    buyer: { type: "string", enum: BUYERS },
    q: { type: "string", description: "店舗名・メモに含まれる言葉" },
    min_total: { type: "number" }, max_total: { type: "number" },
    has_photo: { type: "boolean", description: "true = 写真ありだけ / false = 写真なしだけ" },
    ids: { type: "array", items: { type: "integer" }, description: "記録 ID で絞る" },
  };

  function tools(by = "小西") {
    const RO = { annotations: { readOnlyHint: true } };
    return [
      {
        name: "keihi_receipt_add",
        description: [
          "チャットに領収書の画像が貼られたら、これで登録する (経費アプリで 撮影 → 確認 → 登録 するのと同じ処理。DB・写真 (GCS)・経費記録スプレッドシート (月別タブ・取引シート。写真セルは 🧾 → アプリの view=ID) まで全部反映される)。",
          "OCR はサーバーでしない: 画像を読むのは AI。日付・現場・店舗・金額・費目・工種・支払方法・メモ を埋めて渡す。複数枚貼られたら receipts に全部まとめて 1 回で渡す (最大 30 件。1 件ずつ独立に処理され、1 件の失敗で他は止まらない)。購入者は呼び出したトークンの持ち主で自動で入る。",
          `項目と選択肢は画面と同じ: ${CHOICES_TEXT}、購入者は ${BUYERS.join(" / ")}。`,
          GUIDE_TEXT + "。",
          "現場 (site) は表記ゆれ・一部でも可 (「入谷」「共通」「会社」も現場)。金額 (total) は税込の支払額 (円・整数)。日付はレシートの日付 (読めなければ人に聞く。聞けなければ今日の日付で登録して memo に「日付は推定」)。店舗名 (store) はレシートに印字の名前。",
          "写真は 2 通り: ① keihi_receipt_upload_url で作った URL に curl で PUT → photo_ref を渡す ② photo_base64 で直接渡す (外の URL に出られない環境の予備。1 枚数 MB まで。サーバーが長辺 1200px の JPEG に縮小する)。1 枚の写真に領収書が複数写っているときは、同じ photo_ref / photo_base64 を各件に付ける。",
          "重複防止: 同じ日付・店舗・金額が既にあれば入れずに duplicate: true と既存の id を返す (force=true で強制)。返り値: 件ごとに id・view_url (アプリの閲覧 URL)・sheet.tab (反映された月のタブ名)・warnings。",
          "登録前に keihi_receipt_hints(stores=[…]) で同じ店の過去の登録を見て、費目・工種・現場・支払方法を過去に合わせる。",
        ].join("\n"),
        inputSchema: {
          type: "object",
          properties: {
            receipts: {
              type: "array", minItems: 1, maxItems: MAX_BATCH,
              items: {
                type: "object",
                properties: {
                  date: { type: "string", description: "購入日 YYYY-MM-DD" },
                  site: { type: "string", description: "現場名 (共通・会社も可)" },
                  store: { type: "string", description: "店舗名" },
                  total: { type: "number", description: "税込の支払額 (円)" },
                  category: { type: "string", enum: CATEGORIES, description: "費目" },
                  work_type: { type: "string", enum: WORK_TYPES, description: "工種。省略 = その他" },
                  payment: { type: "string", enum: PAYMENTS, description: "支払方法。省略 = 現金" },
                  memo: { type: "string" },
                  photo_ref: { type: "string", description: "keihi_receipt_upload_url で作った URL に PUT した写真の photo_ref" },
                  photo_base64: { type: "string", description: "写真の base64 (JPEG / PNG / HEIC / WebP。1 枚数 MB まで)" },
                  buyer: { type: "string", enum: BUYERS, description: "他の人の分を代わりに登録するときだけ。普通は書かない (トークンの持ち主)" },
                  force: { type: "boolean", description: "この 1 件だけ重複チェックを外す" },
                },
                required: ["date", "site", "store", "total", "category"],
              },
            },
            force: { type: "boolean", description: "全部の重複チェックを外す" },
          },
          required: ["receipts"],
        },
        handler: async (a) => {
          const p = pool();
          const items = Array.isArray(a.receipts) ? a.receipts : null;
          if (!items || !items.length) throw new Error("receipts が必要 ([{ date, site, store, total, category, … }])");
          if (items.length > MAX_BATCH) throw new Error(`1 回で登録できるのは ${MAX_BATCH} 件まで (指定: ${items.length})。分けて呼ぶ`);
          const cache = new Map(), results = [];
          for (let i = 0; i < items.length; i++) {
            try { results.push({ index: i, ...(await addOne(p, items[i], by, a.buyer, cache, a.force === true)) }); }
            catch (e) { results.push({ index: i, ok: false, error: e.message }); }
          }
          const added = results.filter((r) => r.ok && !r.duplicate).length, duplicates = results.filter((r) => r.duplicate).length, failed = results.filter((r) => !r.ok).length;
          return { added, duplicates, failed, results };
        },
      },
      {
        name: "keihi_receipt_upload_url",
        description: "領収書の写真を置く一時 URL を作る (写真の渡し方 ①)。チャットに領収書の画像が貼られたら、枚数ぶん count で呼び、返ってきた curl で各画像を PUT してから、photo_ref を keihi_receipt_add の receipts[].photo_ref に入れる (6 時間有効)。サーバーが長辺 1200px の JPEG に縮小して、経費アプリが写真を置くのと同じ場所 (GCS) に置く。外の URL に出られない環境なら使わず、keihi_receipt_add の photo_base64 で直接渡す。",
        inputSchema: {
          type: "object",
          properties: { count: { type: "integer", minimum: 1, maximum: MAX_BATCH, description: "写真の枚数 (既定 1)" } },
        },
        handler: async (a) => {
          store();
          const n = Math.max(1, Math.min(MAX_BATCH, Math.trunc(Number(a.count) || 1)));
          const uploads = [];
          for (let i = 1; i <= n; i++) {
            const key = `${todayStr()}/${crypto.randomUUID()}.jpg`;
            const ref = mintRef(by, key);
            const url = `${publicUrl}/api/keihi/upload/${ref}`;
            uploads.push({ n: i, photo_ref: ref, upload_url: url, curl: `curl -sS -X PUT -H "Content-Type: image/jpeg" --data-binary @"receipt${i}.jpg" "${url}"` });
          }
          return {
            method: "PUT", expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(), uploads,
            note: "各 curl の receipt<n>.jpg を実際のファイルに置き換えて実行する。成功すると { ok: true } が返る。そのあと photo_ref を keihi_receipt_add に渡す。外に出られないときは photo_base64 で直接渡す",
          };
        },
      },
      {
        name: "keihi_receipt_hints",
        description: [
          "領収書を登録する前に、同じ店の過去の登録の傾向 (費目・工種・現場・支払方法の件数) と、選択肢・現場の一覧を返す。チャットに領収書の画像が貼られたら、keihi_receipt_add で登録する前に、読み取った店名でこれを呼んで、費目・工種は過去に合わせる (同じ店でほぼ同じ費目なら、それを選ぶ)。",
          GUIDE_TEXT + "。",
          "stores 省略でも選択肢・現場・全体の傾向は返る。",
        ].join("\n"),
        inputSchema: { type: "object", properties: { stores: { type: "array", items: { type: "string" }, description: "読み取った店舗名 (最大 20)" } } },
        ...RO,
        handler: async (a) => {
          const p = pool();
          const { rows } = await p.query(`${LIST_SQL}\n        ORDER BY date DESC, id DESC LIMIT 3000`);
          const top = (list, f, n = 5) => {
            const m = new Map();
            for (const r of list) { const v = f(r); if (v) m.set(v, (m.get(v) || 0) + 1); }
            return [...m].sort((x, y) => y[1] - x[1]).slice(0, n).map(([value, count]) => ({ value, count }));
          };
          const by_store = [];
          for (const s of (Array.isArray(a.stores) ? a.stores : []).slice(0, 20)) {
            const ns = normStore(s);
            const hit = ns ? rows.filter((r) => { const x = normStore(r.store); return x === ns || (ns.length >= 3 && x.length >= 3 && (x.includes(ns) || ns.includes(x))); }) : [];
            const cat = top(hit, (r) => r.category), wt = top(hit, (r) => r.workType), st = top(hit, (r) => r.site), pay = top(hit, (r) => r.payment);
            by_store.push({
              store: s, past_count: hit.length,
              category: cat, work_type: wt, site: st, payment: pay,
              suggest: hit.length ? { category: cat[0]?.value, work_type: wt[0]?.value, payment: pay[0]?.value, consistent: cat[0]?.count === hit.length } : undefined,
              last: hit[0] ? { id: Number(hit[0].id), date: hit[0].date, store: hit[0].store, total: Number(hit[0].total), category: hit[0].category, work_type: hit[0].workType, site: hit[0].site, payment: hit[0].payment, memo: hit[0].memo || undefined } : undefined,
              note: hit.length ? undefined : "過去の登録なし。レシートの内容から選ぶ",
            });
          }
          const { rows: sites } = await p.query(`SELECT name FROM sites ORDER BY (done_at IS NOT NULL) ASC, CASE WHEN done_at IS NULL THEN id END ASC, done_at DESC`);
          const recent = rows.slice(0, 300);
          return {
            choices: { categories: CATEGORIES, work_types: WORK_TYPES, payments: PAYMENTS, buyers: BUYERS },
            defaults: { work_type: DEFAULTS.workType, payment: DEFAULTS.payment },
            guide: GUIDE_TEXT,
            sites: sites.map((r) => r.name),
            by_store,
            overall: { recent_records: recent.length, category: top(recent, (r) => r.category, 7), work_type: top(recent, (r) => r.workType, 10), payment: top(recent, (r) => r.payment, 4), site: top(recent, (r) => r.site, 8) },
          };
        },
      },
      {
        name: "keihi_receipt_list",
        description: "経費の記録を一覧・検索する (経費アプリの「記録」画面と同じ。現場・月で絞った合計と件数も返る)。現場・月・期間・費目・工種・支払方法・購入者・店舗名/メモの言葉・金額・写真の有無で絞れる。新しい順 (購入日 → ID の降順)。写真は keihi_receipt_photo、集計は keihi_receipt_summary。「今月の入谷の経費は？」「この領収書もう登録した？」はこれで引く。",
        inputSchema: {
          type: "object",
          properties: { ...FILTER_PROPS, limit: { type: "integer", description: "既定 50、最大 500" }, offset: { type: "integer" }, order: { type: "string", enum: ["date_desc", "date_asc", "total_desc"], description: "既定 date_desc (画面と同じ)" } },
        },
        ...RO,
        handler: async (a) => {
          const p = pool();
          const w = await buildWhere(p, a);
          const limit = Math.max(1, Math.min(500, Math.trunc(Number(a.limit) || 50))), offset = Math.max(0, Math.trunc(Number(a.offset) || 0));
          const order = a.order === "date_asc" ? "date ASC, id ASC" : a.order === "total_desc" ? "total DESC, id DESC" : "date DESC, id DESC";
          const [{ rows: agg }, { rows }] = await Promise.all([
            p.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::bigint AS total FROM records ${w.sql}`, w.vals),
            p.query(`${LIST_SQL} ${w.sql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, w.vals),
          ]);
          return { label: filterLabel(a), count: agg[0].n, total: Number(agg[0].total), returned: rows.length, truncated: agg[0].n > offset + rows.length || undefined, records: rows.map(recOut) };
        },
      },
      {
        name: "keihi_receipt_get",
        description: "経費の記録 1 件の詳細 (id から)。写真は keihi_receipt_photo。",
        inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        ...RO,
        handler: async (a) => {
          const { rows } = await pool().query(`${LIST_SQL} WHERE id=$1`, [Number(a.id)]);
          if (!rows.length) throw new Error(`記録が見つからない: #${a.id}`);
          return { record: { ...recOut(rows[0]), photo_gs: rows[0].imageUrl || undefined, drive_url: rows[0].driveUrl || undefined } };
        },
      },
      {
        name: "keihi_receipt_summary",
        description: "経費の集計 (件数と合計金額)。group_by に month (購入月) / site / category / work_type / payment / buyer / store を 1〜2 個。絞り込みは keihi_receipt_list と同じ。経費アプリの「全現場 合計」「現場 / 月」の合計を、現場別・月別・費目別などに分けて出す。例: 今月の現場別 = month=今月 + group_by=[site]、入谷の費目別 = site=入谷 + group_by=[category]。",
        inputSchema: {
          type: "object",
          properties: { ...FILTER_PROPS, group_by: { type: "array", items: { type: "string", enum: ["month", "site", "category", "work_type", "payment", "buyer", "store"] }, minItems: 1, maxItems: 2 } },
        },
        ...RO,
        handler: async (a) => {
          const p = pool();
          const w = await buildWhere(p, a);
          const EXPR = { month: "to_char(date, 'YYYY-MM')", site: "site", category: "category", work_type: "work_type", payment: "payment", buyer: "buyer", store: "store" };
          const gb = (Array.isArray(a.group_by) ? a.group_by : a.group_by ? [a.group_by] : []).slice(0, 2);
          for (const g of gb) if (!EXPR[g]) throw new Error(`group_by は ${Object.keys(EXPR).join(" / ")} (指定: ${g})`);
          const { rows: all } = await p.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::bigint AS total FROM records ${w.sql}`, w.vals);
          let groups = [];
          if (gb.length) {
            const sel = gb.map((g, i) => `${EXPR[g]} AS g${i}`).join(", "), grp = gb.map((_, i) => `g${i}`).join(", ");
            const order = gb[0] === "month" ? "g0 DESC" : "total DESC";
            const { rows } = await p.query(`SELECT ${sel}, COUNT(*)::int AS n, COALESCE(SUM(total),0)::bigint AS total FROM records ${w.sql} GROUP BY ${grp} ORDER BY ${order}, n DESC LIMIT 300`, w.vals);
            groups = rows.map((r) => ({ ...Object.fromEntries(gb.map((g, i) => [g, r[`g${i}`] || "(空)"])), count: r.n, total: Number(r.total) }));
          }
          return { label: filterLabel(a), count: all[0].n, total: Number(all[0].total), group_by: gb, groups };
        },
      },
      {
        name: "keihi_receipt_update",
        description: [
          "経費の記録を直す (経費アプリの「記録を編集」と同じ処理。DB を更新して、シートにも追記し直す = アプリの編集と同じで、月別タブには新しい行が増える。古い行は手で消す)。変えたい項目だけ渡せばいい (渡さなかった項目はそのまま)。",
          `項目と選択肢は keihi_receipt_add と同じ (${CHOICES_TEXT})。写真を付け替えるときは photo_ref か photo_base64 (画面では写真は差し替えられない。AI 経由の追加機能)。`,
          "削除は keihi_receipt_delete。",
        ].join("\n"),
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "integer" },
            date: { type: "string" }, site: { type: "string" }, store: { type: "string" }, total: { type: "number" },
            category: { type: "string", enum: CATEGORIES }, work_type: { type: "string", enum: WORK_TYPES }, payment: { type: "string", enum: PAYMENTS },
            buyer: { type: "string", enum: BUYERS }, memo: { type: "string" },
            photo_ref: { type: "string" }, photo_base64: { type: "string" },
          },
          required: ["id"],
        },
        handler: async (a) => {
          const p = pool();
          const id = Number(a.id);
          const { rows } = await p.query(`${LIST_SQL} WHERE id=$1`, [id]);
          if (!rows.length) throw new Error(`記録が見つからない: #${id}`);
          const cur = rows[0];
          const has = (k) => a[k] !== undefined && a[k] !== null;
          const wt = a.work_type ?? a.workType;
          const next = {
            date: has("date") ? parseDate(a.date) : cur.date,
            store: has("store") ? (String(a.store).trim() || (() => { throw new Error("store を空にはできない"); })()) : cur.store,
            total: has("total") ? parseTotal(a.total) : Number(cur.total),
            category: has("category") ? normCategory(a.category) : cur.category,
            workType: wt != null ? normWorkType(wt) : cur.workType,
            payment: has("payment") ? normPayment(a.payment) : cur.payment,
            buyer: has("buyer") ? normBuyer(a.buyer) : cur.buyer,
            site: has("site") ? await resolveSiteName(p, a.site) : cur.site,
            memo: has("memo") ? String(a.memo).trim() : (cur.memo || ""),
            driveUrl: cur.driveUrl || null,
          };
          let newImage = null;
          if (a.photo_ref || a.photo_base64) newImage = await resolvePhoto(p, a, new Map(), true);
          const n = await updateRecordRow(id, next);
          if (!n) throw new Error(`記録が見つからない: #${id}`);
          if (newImage) await p.query(`UPDATE records SET image_url=$1 WHERE id=$2`, [newImage, id]);
          let st = null;
          if (appendRecordToSheet) st = await appendRecordToSheet({ ...next, id, imageUrl: newImage || cur.imageUrl || null }).catch((e) => ({ monthly: { ok: false, error: e.message }, tx: { ok: false, error: e.message } }));
          const { rows: after } = await p.query(`${LIST_SQL} WHERE id=$1`, [id]);
          const sheet = sheetOut(next.date, st);
          return { ok: true, record: recOut(after[0]), sheet, note: "シートには追記された (アプリの編集と同じ)。月別タブの古い行は手で消す。取引シートは元 ID で同じ行を 2 回入れない" + (sheet.ok ? "" : "。シートへの反映に失敗 → keihi_receipt_sheet_sync(ids=[…])") };
        },
      },
      {
        name: "keihi_receipt_delete",
        description: "経費の記録を削除する (経費アプリの「×」と同じ処理: DB の行だけ消える。写真 (GCS) とシートの行は残る = アプリと同じ)。取り消せないので、人に確認してから confirm=true で呼ぶ。confirm なしで呼ぶと、消す内容を返すだけで消さない。",
        inputSchema: { type: "object", properties: { id: { type: "integer" }, confirm: { type: "boolean", description: "人に確認したら true" } }, required: ["id"] },
        handler: async (a) => {
          const p = pool();
          const id = Number(a.id);
          const { rows } = await p.query(`${LIST_SQL} WHERE id=$1`, [id]);
          if (!rows.length) throw new Error(`記録が見つからない: #${id}`);
          if (a.confirm !== true) return { deleted: false, will_delete: recOut(rows[0]), note: "消していない。人に確認して confirm=true で呼び直す" };
          await deleteRecordRow(id);
          return { deleted: true, record: recOut(rows[0]), note: "DB の行だけ消した。シートの行と写真は残っている (アプリと同じ)" };
        },
      },
      {
        name: "keihi_receipt_photo",
        description: "領収書の写真を見る (経費アプリの 🧾 と同じ。10 分有効の閲覧 URL と、画像そのもの (AI が読める) を返す)。記録の id から。写真が無い記録はエラー。",
        inputSchema: { type: "object", properties: { id: { type: "integer" }, include_image: { type: "boolean", description: "画像を返す (既定 true)。URL だけでいいなら false" } }, required: ["id"] },
        ...RO,
        handler: async (a) => {
          const id = Number(a.id);
          const gs = await getImageGsUrl(id);
          if (!gs || !gs.startsWith("gs://")) throw new Error(`#${id} には写真が無い`);
          const url = await signedReadUrl(gs);
          const content = [{ type: "text", text: JSON.stringify({ id, url, expires_in_min: SIGN_MIN, view_url: viewUrl(id) }) }];
          if (a.include_image !== false) {
            try {
              const [, , b, ...rest] = gs.split("/");
              const [buf] = await store().bucket(b).file(rest.join("/")).download();
              if (buf.length <= 4 * 1024 * 1024) content.push({ type: "image", data: buf.toString("base64"), mimeType: /\.pdf$/i.test(gs) ? "application/pdf" : "image/jpeg" });
              else content[0].text = JSON.stringify({ id, url, expires_in_min: SIGN_MIN, view_url: viewUrl(id), note: "画像が大きいので URL だけ" });
            } catch (e) { console.warn("[keihi] photo download", e.message); }
          }
          return { content };
        },
      },
      {
        name: "keihi_receipt_export_csv",
        description: "経費の記録を CSV で返す (経費アプリの「CSV」と同じ列: 購入日・現場名・店舗名・金額・費目・工種・支払方法・購入者・メモ。先頭は BOM)。絞り込みは keihi_receipt_list と同じ (省略 = 新しい順に最大 1000 件、画面と同じ)。返った csv をそのままファイルにする。",
        inputSchema: { type: "object", properties: { ...FILTER_PROPS, limit: { type: "integer", description: "既定 1000 (画面と同じ上限)、最大 5000" } } },
        ...RO,
        handler: async (a) => {
          const p = pool();
          const w = await buildWhere(p, a);
          const limit = Math.max(1, Math.min(5000, Math.trunc(Number(a.limit) || 1000)));
          const { rows } = await p.query(`${LIST_SQL} ${w.sql} ORDER BY date DESC, id DESC LIMIT ${limit}`, w.vals);
          const header = ["購入日", "現場名", "店舗名", "金額", "費目", "工種", "支払方法", "購入者", "メモ"].map(csvCell).join(",");
          const lines = rows.map((r) => [r.date, r.site, r.store, r.total, r.category, r.workType, r.payment, r.buyer, r.memo].map(csvCell).join(","));
          return { filename: `経費_${todayStr()}.csv`, label: filterLabel(a), rows: rows.length, csv: "﻿" + [header, ...lines].join("\n") };
        },
      },
      {
        name: "keihi_receipt_sheet_sync",
        description: "経費の記録をスプレッドシート (経費記録の月別タブ + 取引シート) に書き出し直す。登録のときに失敗した記録や、シートに無い古い記録を入れる用。シートに既にある行 (写真セルの view=ID / 取引シートの元 ID) は飛ばして、無いものだけ追記する (二重に入らない)。ids か month で対象を決める。dry_run=true で、どれが足りないかを見るだけ。",
        inputSchema: {
          type: "object",
          properties: { ids: { type: "array", items: { type: "integer" } }, month: { type: "string", description: "YYYY-MM" }, dry_run: { type: "boolean" } },
        },
        handler: async (a) => {
          if (!syncSheets) throw new Error("シート書き出しが設定されていない");
          if (a.ids == null && !a.month) throw new Error("ids か month が必要 (全件は重いので、月ごとに)");
          const p = pool();
          const w = await buildWhere(p, { ids: a.ids, month: a.month });
          const { rows } = await p.query(`${LIST_SQL} ${w.sql} ORDER BY date ASC, id ASC LIMIT 500`, w.vals);
          if (!rows.length) return { checked: 0, results: [], note: "対象の記録が無い" };
          const results = await syncSheets(rows, { dryRun: a.dry_run === true });
          return { checked: rows.length, dry_run: a.dry_run === true || undefined, appended: results.filter((r) => r.monthly === "appended" || r.tx === "appended").length, results };
        },
      },
      {
        name: "keihi_sites",
        description: "経費で選べる現場の一覧 (経費アプリの現場ボタンと同じ。進行中が先、完了は後ろ)。「共通」「会社」も現場として入っている。現場の追加・編集は経費アプリではなく現場アプリ側 (genba_register)。keihi_receipt_add の site は、ここの名前か、その表記ゆれ・一部で指定できる。",
        inputSchema: { type: "object", properties: {} },
        ...RO,
        handler: async () => {
          const { rows } = await pool().query(
            `SELECT id, name, address, done_at AS "doneAt" FROM sites
              ORDER BY (done_at IS NOT NULL) ASC, CASE WHEN done_at IS NULL THEN id END ASC, done_at DESC`);
          return { sites: rows.map((r) => ({ id: Number(r.id), name: r.name, address: r.address || undefined, done: !!r.doneAt })) };
        },
      },
    ];
  }

  return {
    tools, instructions: EXPENSE_INSTRUCTIONS, uploadRoute,
    // 画面 (REST) と共通の処理
    listAll, insertRecord, updateRecordRow, deleteRecordRow, getImageGsUrl, signedReadUrl, putReceiptObject,
    viewUrl,
  };
}
