FROM node:20-slim
# ffmpeg: 動画の音声差し替え (drama replaceAudioUrl) と Veo 動画の最終フレーム抽出に使う
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]
