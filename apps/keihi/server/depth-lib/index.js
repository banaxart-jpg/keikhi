// ═══════════════════ 奥行きビューア (/depth/) ═══════════════════
// 写真 1 枚 → Depth Anything V2 Small (ONNX, Apache-2.0) で深度マップを推定 → GCS に保存。
// ビューア (Hosting の /depth/v/<id>) は認証なしで開けて、素材はこのサーバーの
// /depth/v/<id>/{image.jpg,depth.png,meta.json,thumb.jpg} から読む (GCS の署名 URL には飛ばさない。
// WebGL テクスチャは CORS ヘッダが要るので、ACAO:* を返すここ経由にする)。
// アップロード・一覧・削除・調整値の保存は /api/depth/* (既存の Firebase ID トークン + ALLOWED_EMAILS)。
// モデルは git に入れず Dockerfile でイメージに焼く (DEPTH_MODEL_PATH)。セッションは起動時に 1 回だけ作る。
import crypto from "node:crypto";
import fs from "node:fs";
import sharp from "sharp";

const MODEL_PATH = process.env.DEPTH_MODEL_PATH || "/app/models/depth-anything-v2-small.onnx";
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const LONG_SIDE = 1600; // 保存する写真の長辺
const NET_LONG = 518;   // 推論入力の長辺 (14 の倍数に丸める)
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const DEFAULT_AMP = 0.06;

// ── ONNX セッション (起動時に読み込み開始、推論時に await) ──
let sessionPromise = null;
let ortModule = null;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!fs.existsSync(MODEL_PATH)) throw new Error(`depth model not found: ${MODEL_PATH}`);
      ortModule = await import("onnxruntime-node");
      const t0 = Date.now();
      const s = await ortModule.InferenceSession.create(MODEL_PATH, { graphOptimizationLevel: "all" });
      console.log(`[depth] model loaded in ${Date.now() - t0}ms inputs=${s.inputNames} outputs=${s.outputNames}`);
      return s;
    })();
    sessionPromise.catch((e) => { console.warn("[depth] model load failed:", e.message); sessionPromise = null; });
  }
  return sessionPromise;
}

// ── 深度推定: JPEG バッファ → { depth: Uint8Array (w*h), width, height, focus } ──
export async function estimateDepth(jpeg) {
  const session = await getSession();
  const { width: W, height: H } = await sharp(jpeg).metadata();
  const s = NET_LONG / Math.max(W, H);
  const nw = Math.max(14, Math.round((W * s) / 14) * 14);
  const nh = Math.max(14, Math.round((H * s) / 14) * 14);
  const { data } = await sharp(jpeg).removeAlpha().resize(nw, nh, { fit: "fill", kernel: "cubic" })
    .raw().toBuffer({ resolveWithObject: true });
  const plane = nw * nh;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const feeds = { [session.inputNames.includes("pixel_values") ? "pixel_values" : session.inputNames[0]]:
    new ortModule.Tensor("float32", input, [1, 3, nh, nw]) };
  const out = await session.run(feeds);
  const t = out[session.outputNames[0]];
  // 出力は [1, h, w] (大きいほど手前)。念のため dims の後ろ 2 つを使う
  const oh = t.dims[t.dims.length - 2], ow = t.dims[t.dims.length - 1];
  const big = resizeBicubic(t.data, ow, oh, W, H);
  normalizePercentile(big, 0.02, 0.98);
  const blurred = gaussianBlur(big, W, H, 1);
  const depth = new Uint8Array(W * H);
  for (let i = 0; i < depth.length; i++) depth[i] = Math.round(Math.min(1, Math.max(0, blurred[i])) * 255);
  return { depth, width: W, height: H, focus: centerMedian(blurred, W, H) };
}

// 双三次 (Catmull-Rom 系 a=-0.5) で src(sw×sh) → dst(dw×dh)。分離 2 パス
function cubicW(x) {
  const a = -0.5; x = Math.abs(x);
  if (x <= 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
  if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
  return 0;
}
function cubicTaps(n, m) { // m 個の出力それぞれに対する入力 4 タップ (index, weight)
  const idx = new Int32Array(m * 4), w = new Float32Array(m * 4), sc = n / m;
  for (let o = 0; o < m; o++) {
    const x = (o + 0.5) * sc - 0.5, x0 = Math.floor(x);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const xi = x0 - 1 + k;
      idx[o * 4 + k] = Math.min(n - 1, Math.max(0, xi));
      sum += (w[o * 4 + k] = cubicW(x - xi));
    }
    for (let k = 0; k < 4; k++) w[o * 4 + k] /= sum;
  }
  return { idx, w };
}
function resizeBicubic(src, sw, sh, dw, dh) {
  const tx = cubicTaps(sw, dw), ty = cubicTaps(sh, dh);
  const tmp = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < dw; x++) {
      const b = x * 4;
      tmp[y * dw + x] = src[row + tx.idx[b]] * tx.w[b] + src[row + tx.idx[b + 1]] * tx.w[b + 1]
        + src[row + tx.idx[b + 2]] * tx.w[b + 2] + src[row + tx.idx[b + 3]] * tx.w[b + 3];
    }
  }
  const dst = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const b = y * 4;
    const r0 = ty.idx[b] * dw, r1 = ty.idx[b + 1] * dw, r2 = ty.idx[b + 2] * dw, r3 = ty.idx[b + 3] * dw;
    const w0 = ty.w[b], w1 = ty.w[b + 1], w2 = ty.w[b + 2], w3 = ty.w[b + 3];
    for (let x = 0; x < dw; x++) dst[y * dw + x] = tmp[r0 + x] * w0 + tmp[r1 + x] * w1 + tmp[r2 + x] * w2 + tmp[r3 + x] * w3;
  }
  return dst;
}

// 2〜98 パーセンタイルで 0〜1 に (外れ値で全体が潰れないように)。分位点は間引きサンプルで求める
function normalizePercentile(a, plo, phi) {
  const step = Math.max(1, Math.floor(a.length / 200000));
  const sample = new Float32Array(Math.ceil(a.length / step));
  for (let i = 0, j = 0; i < a.length; i += step) sample[j++] = a[i];
  sample.sort();
  const lo = sample[Math.floor(plo * (sample.length - 1))];
  const hi = sample[Math.floor(phi * (sample.length - 1))];
  const r = hi - lo || 1;
  for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, (a[i] - lo) / r));
}

function gaussianBlur(a, w, h, sigma) {
  const rad = Math.ceil(sigma * 3), k = [];
  let sum = 0;
  for (let i = -rad; i <= rad; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let i = -rad; i <= rad; i++) v += a[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + rad];
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let i = -rad; i <= rad; i++) v += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + rad];
    out[y * w + x] = v;
  }
  return out;
}

// 画像中央 40% (縦横とも 30%〜70%) の深度の中央値 = 初期の focus (画面の面に来る奥行き)
function centerMedian(a, w, h) {
  const vals = [];
  const x0 = Math.floor(w * 0.3), x1 = Math.ceil(w * 0.7), y0 = Math.floor(h * 0.3), y1 = Math.ceil(h * 0.7);
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 40000)));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) vals.push(a[y * w + x]);
  vals.sort((p, q) => p - q);
  return Math.round((vals[Math.floor(vals.length / 2)] ?? 0.5) * 1000) / 1000;
}

// ── ルート ──
export function createDepth({ getPool, getStorage, bucket }) {
  let schemaReady = false;
  async function ensureTable() {
    if (schemaReady) return;
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS depth_works (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        file_name TEXT,
        width INT NOT NULL,
        height INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    schemaReady = true;
  }
  const file = (id, name) => getStorage().bucket(bucket).file(`depth/${id}/${name}`);
  const ready = (res) => {
    if (!getPool()) { res.status(503).json({ error: "DB not configured" }); return false; }
    if (!bucket || !getStorage()) { res.status(503).json({ error: "bucket not configured" }); return false; }
    return true;
  };

  // POST /api/depth  { image: base64 (JPEG), fileName } → { id }
  async function create(req, res) {
    if (!ready(res)) return;
    try {
      const b64 = String(req.body?.image || "").replace(/^data:[^,]*,/, "");
      if (!b64) return res.status(400).json({ error: "image がありません" });
      const t0 = Date.now();
      // ブラウザで 1600px JPEG にしてから来るが、念のため EXIF の向きを反映して長辺 1600 に揃え直す (メタデータも落ちる)
      const image = await sharp(Buffer.from(b64, "base64")).rotate()
        .resize(LONG_SIDE, LONG_SIDE, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90 }).toBuffer();
      const { depth, width, height, focus } = await estimateDepth(image);
      const depthPng = await sharp(Buffer.from(depth), { raw: { width, height, channels: 1 } }).png().toBuffer();
      const thumb = await sharp(image).resize(480, 480, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
      const id = crypto.randomBytes(16).toString("base64url").slice(0, 22);
      const fileName = String(req.body?.fileName || "").slice(0, 200) || null;
      const meta = { width, height, createdAt: new Date().toISOString(), fileName, focus, amp: DEFAULT_AMP };
      await Promise.all([
        file(id, "image.jpg").save(image, { contentType: "image/jpeg", resumable: false }),
        file(id, "depth.png").save(depthPng, { contentType: "image/png", resumable: false }),
        file(id, "thumb.jpg").save(thumb, { contentType: "image/jpeg", resumable: false }),
        file(id, "meta.json").save(JSON.stringify(meta), { contentType: "application/json", resumable: false }),
      ]);
      await ensureTable();
      await getPool().query(
        "INSERT INTO depth_works (id, owner_email, file_name, width, height) VALUES ($1,$2,$3,$4,$5)",
        [id, (req.user?.email || "").toLowerCase(), fileName, width, height]);
      console.log(`[depth] ${id} ${width}x${height} focus=${focus} ${Date.now() - t0}ms`);
      res.json({ id, ...meta });
    } catch (e) {
      console.error("[depth] create failed:", e);
      res.status(500).json({ error: e.message });
    }
  }

  // GET /api/depth → 新しい順 (全員共有。records/tasks と同じく社内メンバーで 1 つの一覧)
  async function list(req, res) {
    if (!ready(res)) return;
    try {
      await ensureTable();
      const { rows } = await getPool().query(
        "SELECT id, owner_email, file_name, width, height, created_at FROM depth_works ORDER BY created_at DESC LIMIT 200");
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }

  // DELETE /api/depth/:id → 一覧と GCS の素材を両方消す (送った URL も見られなくなる)
  async function remove(req, res) {
    if (!ready(res)) return;
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
    try {
      await ensureTable();
      await getPool().query("DELETE FROM depth_works WHERE id=$1", [id]);
      await getStorage().bucket(bucket).deleteFiles({ prefix: `depth/${id}/` }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }

  // PATCH /api/depth/:id { focus?, amp? } → meta.json に書き戻す (ビューアの設定パネルの「保存」)
  async function patch(req, res) {
    if (!ready(res)) return;
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
    try {
      const f = file(id, "meta.json");
      const [buf] = await f.download().catch(() => [null]);
      if (!buf) return res.status(404).json({ error: "not found" });
      const meta = JSON.parse(buf.toString());
      const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);
      const focus = num(req.body?.focus, 0, 1), amp = num(req.body?.amp, 0, 0.3);
      if (focus !== undefined) meta.focus = Math.round(focus * 1000) / 1000;
      if (amp !== undefined) meta.amp = Math.round(amp * 1000) / 1000;
      await f.save(JSON.stringify(meta), { contentType: "application/json", resumable: false });
      res.json(meta);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }

  // GET /depth/v/:id/:name (認証なし)。id は推測できない 22 文字なので、知っている人だけが見られる
  const ASSETS = {
    "image.jpg": ["image/jpeg", "public, max-age=31536000, immutable"],
    "depth.png": ["image/png", "public, max-age=31536000, immutable"],
    "thumb.jpg": ["image/jpeg", "public, max-age=31536000, immutable"],
    "meta.json": ["application/json", "no-cache"],
  };
  async function asset(req, res) {
    const { id, name } = req.params;
    const a = ASSETS[name];
    if (!ID_RE.test(id) || !a) return res.status(404).end();
    if (!bucket || !getStorage()) return res.status(503).end();
    try {
      const [buf] = await file(id, name).download();
      res.setHeader("Content-Type", a[0]);
      res.setHeader("Cache-Control", a[1]);
      res.send(buf);
    } catch (e) {
      res.status(e.code === 404 ? 404 : 500).end();
    }
  }

  return { create, list, remove, patch, asset, warmup: () => getSession().catch(() => {}) };
}
