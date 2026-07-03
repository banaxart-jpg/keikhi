import sharp from "sharp";

// グリッド絵コンテ画像の分割。
// 画像生成モデルは「3×3 で描け」と指示しても 12/15/18 コマ等で描いてくる (実測) ため、
// 枠数をプロンプトで縛るのは諦めて、白い罫線 (ガター) をピクセル解析で検出し
// 実際の行列で分割する。検出に自信が持てない時は null を返す (呼び出し側でフォールバック)。

// 輝度プロファイルから「ほぼ全面が明るい帯」を見つける
function findBands(profile, threshold = 0.90) {
  const bands = [];
  let start = -1;
  for (let i = 0; i <= profile.length; i++) {
    const g = i < profile.length && profile[i] >= threshold;
    if (g && start < 0) start = i;
    if (!g && start >= 0) { bands.push([start, i - 1]); start = -1; }
  }
  return bands;
}

// 帯からセル境界 (開始/終了のペア) を作る。端の帯は余白、内側の帯は罫線
function cellsFromBands(bands, length) {
  const inner = [];
  let contentStart = 0, contentEnd = length;
  for (const [a, b] of bands) {
    if (a <= 1) contentStart = b + 1;                 // 先頭の余白
    else if (b >= length - 2) contentEnd = a;          // 末尾の余白
    else inner.push((a + b) / 2);                       // 罫線の中心
  }
  const cuts = [contentStart, ...inner, contentEnd];
  const cells = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = Math.ceil(cuts[i]);
    const to = Math.floor(cuts[i + 1]);
    if (to - from > 4) cells.push([from, to]);
  }
  return cells;
}

// 検出のみ: { rows, cols, rowCells, colCells } (解析解像度での座標) or null
// 解析解像度が低いと 1px の罫線が薄まって消える (実測) ため 256 で解析する
export async function detectGrid(buf) {
  const W = 256;
  const { data, info } = await sharp(buf).resize(W).greyscale().raw().toBuffer({ resolveWithObject: true });
  const H = info.height;
  const rowProfile = [];
  for (let y = 0; y < H; y++) {
    let bright = 0;
    for (let x = 0; x < W; x++) if (data[y * W + x] > 200) bright++;
    rowProfile.push(bright / W);
  }
  const colProfile = [];
  for (let x = 0; x < W; x++) {
    let bright = 0;
    for (let y = 0; y < H; y++) if (data[y * W + x] > 200) bright++;
    colProfile.push(bright / H);
  }
  const rowCells = cellsFromBands(findBands(rowProfile, 0.85), H);
  const colCells = cellsFromBands(findBands(colProfile, 0.85), W);
  const rows = rowCells.length, cols = colCells.length;
  if (rows < 2 || rows > 8 || cols < 2 || cols > 5) return null;
  // セルサイズがある程度揃っているか (最小が最大の 6 割未満なら誤検出とみなす)
  const sizes = (cells) => cells.map(([a, b]) => b - a);
  const uniform = (arr) => Math.min(...arr) / Math.max(...arr) >= 0.6;
  if (!uniform(sizes(rowCells)) || !uniform(sizes(colCells))) return null;
  return { rows, cols, rowCells, colCells, analysisWidth: W, analysisHeight: H };
}

// 分割: 行優先の順で各コマを PNG バッファにして返す。検出できなければ null
export async function splitGridImage(buf) {
  const grid = await detectGrid(buf);
  if (!grid) return null;
  const meta = await sharp(buf).metadata();
  const sx = meta.width / grid.analysisWidth;
  const sy = meta.height / grid.analysisHeight;
  const panels = [];
  for (const [y0, y1] of grid.rowCells) {
    for (const [x0, x1] of grid.colCells) {
      // 罫線の食い込みを避けるため 1.5% 内側に寄せる
      const w = (x1 - x0) * sx, h = (y1 - y0) * sy;
      const inset = 0.015;
      const region = {
        left: Math.round(x0 * sx + w * inset),
        top: Math.round(y0 * sy + h * inset),
        width: Math.round(w * (1 - inset * 2)),
        height: Math.round(h * (1 - inset * 2)),
      };
      panels.push(await sharp(buf).extract(region).png().toBuffer());
    }
  }
  return { rows: grid.rows, cols: grid.cols, panels };
}
