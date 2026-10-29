import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
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
      const durationSeconds = await probeDuration(out);
      service.markVideo(videoId, { filePath: out, durationSeconds, status: "ready" });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${name}：${message.includes("ENOENT") ? "服务器上没有安装" : message.split("\n")[0].slice(0, 120)}`);
    }
  }
  service.markVideo(videoId, { status: "failed", error: `下载失败，请从相册上传。${errors.join("；")}` });
}
