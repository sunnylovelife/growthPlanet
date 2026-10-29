import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Service } from "./service.ts";

const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function exec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().slice(-400) || `${cmd} 退出码 ${code}`));
    });
  });
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

async function transcode(file: string) {
  const tmp = `${file}.transcoding.mp4`;
  try {
    await exec("ffmpeg", [
      "-y", "-i", file,
      "-vf", `scale=w='if(gt(iw,ih),-2,min(${MAX_SHORT_SIDE},iw))':h='if(gt(iw,ih),min(${MAX_SHORT_SIDE},ih),-2)'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-maxrate", "2M", "-bufsize", "4M", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-threads", "2",
      tmp,
    ]);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function finalizeVideo(service: Service, videoId: number, file: string) {
  service.markVideo(videoId, { status: "processing", error: null });
  const info = await probeMedia(file);
  let note: string | null = null;
  if (info && needsTranscode(info)) {
    try {
      await transcode(file);
    } catch (error) {
      note = `转码失败，先用原文件：${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120)}`;
    }
  }
  const durationSeconds = await probeDuration(file);
  service.markVideo(videoId, { filePath: file, durationSeconds, status: "ready" });
  if (note) service.markVideo(videoId, { status: "ready", error: note });
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

async function downloadViaBrowser(url: string, out: string) {
  const detail = await fetchDouyinDetail(url);
  const urls = pickPlayUrls(detail.video);
  if (!urls.length) throw new Error("抖音视频信息里没有播放地址");
  let lastError: unknown;
  for (const playUrl of urls) {
    try {
      const res = await fetch(playUrl, { headers: { "user-agent": DESKTOP_UA, referer: "https://www.douyin.com/" } });
      if (!res.ok || !res.body) throw new Error(`视频地址返回 ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(out));
      return;
    } catch (error) {
      lastError = error;
      rmSync(out, { force: true });
    }
  }
  throw lastError;
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
    ["浏览器", () => downloadViaBrowser(url, out)],
    ["yt-dlp", () => exec("yt-dlp", ["-o", out, "--no-playlist", "--merge-output-format", "mp4", url])],
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
  service.markVideo(videoId, { status: "failed", error: `下载失败，请从相册上传。${errors.join("；")}` });
}
