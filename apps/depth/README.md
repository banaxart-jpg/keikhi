# 奥行きビューア（/depth/）

写真を 1 枚上げると AI が奥行き（深度マップ）を推定し、スマホを傾けると写真の中に物が本当にあるように見える全画面ページを作る。

## 使い方
- ランチャーから [奥行きビューア] をタップ（社内アカウントでログイン）
- 「写真を選ぶ」→ iPhone の写真（HEIC・縦向きもそのまま）を選ぶ → 数秒でビューアに移る
- ビューアで「タップして始める」→ 傾きセンサーを許可 → 傾けると奥行きが出る
- ビューアの URL（`/depth/v/<id>`）はログインなしで開ける。人に送って見せられる
- ビューアで 2 本指タップ（PC はダブルクリック）→ 「奥行きの強さ」「画面の面の位置」を調整。ログイン中なら「保存」できる
- センサーが無いときは指でなぞる / マウスを動かすと動く

## 仕組み
| 場所 | 中身 |
|---|---|
| `apps/depth/index.html` | アップロード + 一覧（Hosting、要ログイン）。ブラウザで長辺 1600px の JPEG (q0.9) にしてから送る |
| `apps/depth/v/index.html` | ビューア（Hosting、認証なし）。`firebase.json` の rewrite で `/depth/v/**` をここに向ける。WebGL1 の視差オクルージョン（48 段 + 二分探索 6 回） |
| `apps/keihi/server/depth-lib/index.js` | `POST/GET /api/depth`、`PATCH/DELETE /api/depth/:id`（要ログイン）、`GET /depth/v/:id/{image.jpg,depth.png,meta.json,thumb.jpg}`（認証なし） |

- モデル: Depth Anything V2 **Small**（`onnx-community/depth-anything-v2-small`、Apache-2.0）。Base/Large は非商用ライセンスなので使わない
- 実行: `onnxruntime-node`（CPU）。モデルは Dockerfile でビルド時に取ってきてイメージに焼く。起動時に 1 回だけ読み込む
- 保存: GCS `<RECEIPTS_BUCKET>/depth/<id>/`、一覧は Cloud SQL `depth_works`（初回アクセスで自動作成）
- 素材は Cloud Run から ACAO:* 付きで返す（GCS の署名 URL には飛ばさない。WebGL テクスチャは CORS が要るため）
- 削除すると GCS の素材も消える（送った URL も見られなくなる）

## 残課題 / 今後やりたいこと
- [ ] 傾きの符号を実機で確認（右に傾けて手前が右・奥が左なら正解）
