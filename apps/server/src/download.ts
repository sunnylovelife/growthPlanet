import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Service } from "./service.ts";

const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export type JobPhase = "opening" | "downloading" | "transcoding";
export type JobProgress = { phase: JobPhase; received: number; total: number | null; etaSeconds: number | null; speedBps: number };
type JobState = { phase: JobPhase; received: number; total: number | null; startedAt: number; etaSeconds?: number | null; speedBps?: number };
const jobs = new Map<number, JobState>();

export function estimateEta(received: number, total: number | null, startedAt: number, now: number): { etaSeconds: number | null; speedBps: number } {
  const elapsed = (now - startedAt) / 1000;
  if (elapsed < 0.8 || received <= 0) return { etaSeconds: null, speedBps: 0 };
  const speedBps = received / elapsed;
  if (!total || total <= received) return { etaSeconds: total != null && total <= received ? 0 : null, speedBps };
  return { etaSeconds: Math.round((total - received) / speedBps), speedBps };
}

export function jobProgress(videoId: number, now = Date.now()): JobProgress | null {
  const job = jobs.get(videoId);
  if (!job) return null;
  const estimated = job.speedBps == null ? estimateEta(job.received, job.total, job.startedAt, now) : { etaSeconds: job.etaSeconds ?? null, speedBps: job.speedBps };
  return { phase: job.phase, received: job.received, total: job.total, etaSeconds: estimated.etaSeconds, speedBps: Math.round(estimated.speedBps) };
}

function setJob(videoId: number, job: JobState) {
  jobs.set(videoId, job);
}

function clearJob(videoId: number) {
  jobs.delete(videoId);
}

export function parseYtDlpProgress(line: string): { percent: number; totalBytes: number; speedBps: number; etaSeconds: number | null } | null {
  const matched = /\[download\]\s+([\d.]+)% of\s+~?([\d.]+)\s*(Ki|Mi|Gi)?B at\s+([\d.]+)\s*(Ki|Mi|Gi)?B\/s(?: ETA (\d+):(\d+)(?::(\d+))?)?/.exec(line);
  if (!matched) return null;
  const scale = (unit?: string) => unit === "Gi" ? 1024 ** 3 : unit === "Mi" ? 1024 ** 2 : unit === "Ki" ? 1024 : 1;
  const eta = matched[6] == null ? null : matched[8] != null
    ? Number(matched[6]) * 3600 + Number(matched[7]) * 60 + Number(matched[8])
    : Number(matched[6]) * 60 + Number(matched[7]);
  return { percent: Number(matched[1]), totalBytes: Number(matched[2]) * scale(matched[3]), speedBps: Number(matched[4]) * scale(matched[5]), etaSeconds: eta };
}

export function parseFfmpegOutTime(line: string): number | null {
  const matched = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line.trim());
  if (!matched) return null;
  return Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3]);
}

function grabFrame(videoFile: string, coverFile: string, at: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-y", "-ss", at, "-i", videoFile, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", coverFile], { stdio: "ignore" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 20000);
    const done = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0 && existsSync(coverFile) && statSync(coverFile).size > 0));
  });
}

export async function extractCover(videoFile: string, coverFile: string): Promise<boolean> {
  mkdirSync(path.dirname(coverFile), { recursive: true });
  if (await grabFrame(videoFile, coverFile, "1")) return true;
  rmSync(coverFile, { force: true });
  return grabFrame(videoFile, coverFile, "0");
}

export async function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.on("error", () => resolve(0));
    child.on("close", () => resolve(Math.round(Number(out) || 0)));
  });
}

export type ProbeInfo = { formatName: string; bitRate: number; video?: { codec: string; width: number; height: number; pixFmt: string }; audioCodec?: string };

export async function probeMedia(file: string): Promise<ProbeInfo | null> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        const data = JSON.parse(out) as { format?: { format_name?: string; bit_rate?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string }[] };
        const video = data.streams?.find((s) => s.codec_type === "video");
        const audio = data.streams?.find((s) => s.codec_type === "audio");
        resolve({
          formatName: data.format?.format_name ?? "",
          bitRate: Number(data.format?.bit_rate) || 0,
          video: video ? { codec: video.codec_name ?? "", width: video.width ?? 0, height: video.height ?? 0, pixFmt: video.pix_fmt ?? "" } : undefined,
          audioCodec: audio?.codec_name,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

const MAX_SHORT_SIDE = 720;
const MAX_BIT_RATE = 3_000_000;

export function needsTranscode(info: ProbeInfo): boolean {
  if (!info.video) return false;
  if (!info.formatName.includes("mp4")) return true;
  if (info.video.codec !== "h264" || info.video.pixFmt !== "yuv420p") return true;
  if (Math.min(info.video.width, info.video.height) > MAX_SHORT_SIDE) return true;
  if (info.bitRate > MAX_BIT_RATE) return true;
  return Boolean(info.audioCodec && info.audioCodec !== "aac");
}

async function transcode(file: string, videoId: number, durationSeconds: number) {
  const tmp = `${file}.transcoding.mp4`;
  setJob(videoId, { phase: "transcoding", received: 0, total: durationSeconds > 0 ? durationSeconds : null, startedAt: Date.now() });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-y", "-i", file,
        "-vf", `scale=w='if(gt(iw,ih),-2,min(${MAX_SHORT_SIDE},iw))':h='if(gt(iw,ih),min(${MAX_SHORT_SIDE},ih),-2)'`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-maxrate", "2M", "-bufsize", "4M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-threads", "2",
        "-progress", "pipe:1", "-nostats", tmp,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let buffer = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const seconds = parseFfmpegOutTime(line);
          if (seconds == null) continue;
          const current = jobs.get(videoId);
          setJob(videoId, { phase: "transcoding", received: seconds, total: durationSeconds > 0 ? durationSeconds : null, startedAt: current?.startedAt ?? Date.now() });
        }
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-400) || `ffmpeg 退出码 ${code}`)));
    });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function finalizeVideo(service: Service, videoId: number, file: string) {
  try {
    service.markVideo(videoId, { status: "processing", error: null });
    const info = await probeMedia(file);
    let note: string | null = null;
    if (info && needsTranscode(info)) {
      try {
        await transcode(file, videoId, await probeDuration(file));
      } catch (error) {
        note = `转码失败，先用原文件：${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120)}`;
      }
    }
    const durationSeconds = await probeDuration(file);
    service.markVideo(videoId, { filePath: file, durationSeconds, status: "ready" });
    if (note) service.markVideo(videoId, { status: "ready", error: note });
    await extractCover(file, path.join(path.dirname(file), "..", "covers", `${videoId}.jpg`));
  } finally {
    clearJob(videoId);
  }
}

type PlayAddr = { url_list?: string[]; width?: number; height?: number };
type DouyinVideo = { play_addr?: PlayAddr; bit_rate?: { bit_rate?: number; is_h265?: number; play_addr?: PlayAddr }[] };

export function pickPlayUrls(video: DouyinVideo, maxShortSide = 720): string[] {
  const h264 = (video.bit_rate ?? []).filter((item) => !item.is_h265 && item.play_addr?.url_list?.length);
  const shortSide = (addr: PlayAddr) => Math.min(addr.width || addr.height || 0, addr.height || addr.width || 0);
  const fit = h264.filter((item) => shortSide(item.play_addr!) <= maxShortSide);
  const best = (fit.length ? fit : h264).sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
  return best?.play_addr?.url_list ?? video.play_addr?.url_list ?? [];
}

async function fetchDouyinDetail(url: string): Promise<{ desc?: string; video: DouyinVideo }> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const context = await browser.newContext({ userAgent: DESKTOP_UA, locale: "zh-CN", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const detail = page.waitForResponse((res) => res.url().includes("/aweme/v1/web/aweme/detail/") && res.status() === 200, { timeout: 30000 });
    detail.catch(() => undefined);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const body = await (await detail).json() as { aweme_detail?: { desc?: string; video?: DouyinVideo } };
    if (!body.aweme_detail?.video) throw new Error("抖音没有返回视频信息，可能触发了验证");
    return { desc: body.aweme_detail.desc, video: body.aweme_detail.video };
  } finally {
    await browser.close();
  }
}

async function downloadViaBrowser(url: string, out: string, videoId: number) {
  setJob(videoId, { phase: "opening", received: 0, total: null, startedAt: Date.now() });
  const detail = await fetchDouyinDetail(url);
  const urls = pickPlayUrls(detail.video);
  if (!urls.length) throw new Error("抖音视频信息里没有播放地址");
  let lastError: unknown;
  for (const playUrl of urls) {
    try {
      const res = await fetch(playUrl, { headers: { "user-agent": DESKTOP_UA, referer: "https://www.douyin.com/" } });
      if (!res.ok || !res.body) throw new Error(`视频地址返回 ${res.status}`);
      const total = Number(res.headers.get("content-length")) || null;
      let received = 0;
      const startedAt = Date.now();
      setJob(videoId, { phase: "downloading", received: 0, total, startedAt });
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          setJob(videoId, { phase: "downloading", received, total, startedAt });
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), counter, createWriteStream(out));
      return;
    } catch (error) {
      lastError = error;
      rmSync(out, { force: true });
    }
  }
  throw lastError;
}

function runYtDlp(url: string, out: string, videoId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", ["-o", out, "--no-playlist", "--merge-output-format", "mp4", "--newline", url], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buffer = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseYtDlpProgress(line);
        if (!parsed) continue;
        const current = jobs.get(videoId);
        setJob(videoId, {
          phase: "downloading",
          received: Math.round(parsed.totalBytes * parsed.percent / 100),
          total: Math.round(parsed.totalBytes),
          startedAt: current?.startedAt ?? Date.now(),
          etaSeconds: parsed.etaSeconds,
          speedBps: parsed.speedBps,
        });
      }
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-400) || `yt-dlp 退出码 ${code}`)));
  });
}

let chain: Promise<void> = Promise.resolve();

export function enqueueDownload(service: Service, videoId: number, url: string, dataDir: string) {
  chain = chain.then(() => downloadOne(service, videoId, url, dataDir)).catch(() => undefined);
}

export function enqueueTranscode(service: Service, videoId: number, file: string) {
  chain = chain.then(() => finalizeVideo(service, videoId, file)).catch((error) => {
    try { service.markVideo(videoId, { status: "failed", error: `处理失败：${error instanceof Error ? error.message : String(error)}` }); } catch { /* 视频已被删除 */ }
  });
}

export function idle(): Promise<void> {
  return chain;
}

async function downloadOne(service: Service, videoId: number, url: string, dataDir: string) {
  const dir = path.join(dataDir, "videos");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${videoId}.mp4`);
  service.markVideo(videoId, { status: "downloading", error: null });
  const errors: string[] = [];
  for (const [name, attempt] of [
    ["浏览器", () => downloadViaBrowser(url, out, videoId)],
    ["yt-dlp", () => runYtDlp(url, out, videoId)],
  ] as const) {
    try {
      await attempt();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${name}：${message.includes("ENOENT") ? "服务器上没有安装" : message.split("\n")[0].slice(0, 120)}`);
      continue;
    }
    await finalizeVideo(service, videoId, out);
    return;
  }
  clearJob(videoId);
  service.markVideo(videoId, { status: "failed", error: `下载失败，请从相册上传。${errors.join("；")}` });
}
