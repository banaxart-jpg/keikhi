FROM node:20-slim
# ffmpeg: 動画の音声差し替え (drama replaceAudioUrl) と Veo 動画の最終フレーム抽出に使う
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# 奥行きビューア (/depth/) の深度推定モデル: Depth Anything V2 Small (Apache-2.0、Base/Large は非商用なので使わない)。
# git には入れずビルド時に取ってきてイメージに焼く。リビジョン固定 + サイズ確認で、上流が変わっても壊れない
ARG DEPTH_MODEL_URL=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx
RUN mkdir -p /app/models && node -e "\
  const url = process.argv[1]; \
  fetch(url).then(async (r) => { \
    if (!r.ok) throw new Error('HTTP ' + r.status); \
    const b = Buffer.from(await r.arrayBuffer()); \
    if (b.length < 50e6) throw new Error('model too small: ' + b.length); \
    require('fs').writeFileSync('/app/models/depth-anything-v2-small.onnx', b); \
    console.log('depth model', b.length, 'bytes'); \
  }).catch((e) => { console.error(e); process.exit(1); });" "$DEPTH_MODEL_URL"
ENV DEPTH_MODEL_PATH=/app/models/depth-anything-v2-small.onnx
# onnxruntime 1.30 は既定で利用統計を送ろうとする (slim には CA が無く警告が出るだけだが、送らない)
ENV ORT_DISABLE_TELEMETRY=1
COPY package.json ./
# onnxruntime-node は postinstall で CUDA 版を落としに行って失敗するので skip (CPU 版は同梱)。
# 他 OS 向けのバイナリ (~220MB) は要らないので消す
RUN ONNXRUNTIME_NODE_INSTALL=skip npm install --omit=dev --no-audit --no-fund \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 node_modules/onnxruntime-node/bin/napi-v*/linux/arm64
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]
