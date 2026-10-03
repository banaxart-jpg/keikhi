// ffmpeg ラッパー (Cloud Run イメージに apt で入れている。無ければ null を返して呼び出し側が諦める)
// 用途: 1) 完成動画の音声を別音声に差し替える (replaceAudioUrl)  2) Veo 動画の最終フレーム抽出
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function run(bin, args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).split("\n").filter(Boolean).slice(-6).join(" | ");
        return reject(new Error(`${path.basename(bin)} 失敗: ${tail}`));
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

let _available = null;
export async function ffmpegAvailable() {
  if (_available != null) return _available;
  try { await run(FFMPEG, ["-version"], { timeoutMs: 10000 }); _available = true; }
  catch { _available = false; }
  return _available;
}

async function withTmp(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "drama-ff-"));
  try { return await fn(dir); }
  finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// 動画の尺 (秒)。取れなければ null
export async function probeDuration(videoBuf) {
  return withTmp(async (dir) => {
    const v = path.join(dir, "in.mp4");
    await fs.promises.writeFile(v, videoBuf);
    try {
      const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", v], { timeoutMs: 30000 });
      const d = parseFloat(stdout.trim());
      return Number.isFinite(d) ? d : null;
    } catch { return null; }
  });
}

// 最終フレームを PNG で取り出す (Veo は API が最終フレームを返さないため)
export async function extractLastFrame(videoBuf) {
  return withTmp(async (dir) => {
    const v = path.join(dir, "in.mp4"), out = path.join(dir, "last.png");
    await fs.promises.writeFile(v, videoBuf);
    await run(FFMPEG, ["-y", "-sseof", "-0.1", "-i", v, "-frames:v", "1", "-update", "1", out]);
    return fs.promises.readFile(out);
  });
}

// 動画の音声を audioBuf に差し替える。映像は再エンコードしない (-c:v copy)。
// offsetSec > 0: 音声を offsetSec 遅らせて開始 (頭は無音)。offsetSec < 0: 音声の頭を |offsetSec| 秒切ってから開始。
// 音声が尺より短ければ末尾を無音で埋め (apad)、長ければ動画の尺で切る (-t)。
export async function replaceAudio(videoBuf, audioBuf, { offsetSec = 0, audioExt = "wav", audioCodec = "aac" } = {}) {
  return withTmp(async (dir) => {
    const v = path.join(dir, "in.mp4"), a = path.join(dir, `in.${audioExt}`), out = path.join(dir, "out.mp4");
    await fs.promises.writeFile(v, videoBuf);
    await fs.promises.writeFile(a, audioBuf);
    const dur = await (async () => {
      try {
        const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", v], { timeoutMs: 30000 });
        const d = parseFloat(stdout.trim()); return Number.isFinite(d) ? d : null;
      } catch { return null; }
    })();
    const off = Number(offsetSec) || 0;
    const chain = [];
    if (off > 0) { const ms = Math.round(off * 1000); chain.push(`adelay=${ms}|${ms}`); }
    else if (off < 0) chain.push(`atrim=start=${(-off).toFixed(3)},asetpts=PTS-STARTPTS`);
    chain.push("apad");
    const args = [
      "-y", "-i", v, "-i", a,
      "-filter_complex", `[1:a]${chain.join(",")}[a]`,
      "-map", "0:v:0", "-map", "[a]",
      "-c:v", "copy", "-c:a", audioCodec, "-b:a", "160k", "-ac", "2",
      ...(dur ? ["-t", dur.toFixed(3)] : ["-shortest"]),
      "-movflags", "+faststart",
      out,
    ];
    await run(FFMPEG, args);
    return { buffer: await fs.promises.readFile(out), durationSec: dur };
  });
}
