import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { Service } from "./service.ts";

const FIREFOX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0";
const CHROMIUM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

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
type DouyinVideo = { play_addr?: PlayAddr; duration?: number; bit_rate?: { bit_rate?: number; is_h265?: number; play_addr?: PlayAddr }[] };

/** 抖音给搜索引擎爬虫单独渲染的分享页，带 schema.org 的 VideoObject，能拿到标题/作者/封面。 */
const SEO_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
export type DouyinSeo = { title?: string; author?: string; covers: string[] };

export function parseDouyinSeo(html: string): DouyinSeo {
  const meta: DouyinSeo = { covers: [] };
  for (const block of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let data: unknown;
    try {
      data = JSON.parse(block[1]);
    } catch {
      continue;
    }
    const node = data as { "@type"?: string; name?: unknown; thumbnailUrl?: unknown; creator?: { name?: unknown } };
    if (node?.["@type"] !== "VideoObject") continue;
    if (typeof node.name === "string" && node.name.trim()) meta.title = node.name.trim().slice(0, 80);
    if (typeof node.creator?.name === "string") meta.author = node.creator.name;
    const thumbs = Array.isArray(node.thumbnailUrl) ? node.thumbnailUrl : [node.thumbnailUrl];
    meta.covers = thumbs.filter((item): item is string => typeof item === "string" && item.startsWith("http"));
    break;
  }
  return meta;
}

function fetchText(url: string, userAgent: string, hops = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (hops > 4) {
      reject(new Error("重定向次数过多"));
      return;
    }
    const client = url.startsWith("http:") ? http : https;
    const request = client.get(url, { headers: { "user-agent": userAgent, "accept-language": "zh-CN,zh;q=0.9" } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        fetchText(new URL(response.headers.location, url).toString(), userAgent, hops + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`页面返回 ${status}`));
        return;
      }
      response.setEncoding("utf8");
      let text = "";
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve(text));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(15000, () => request.destroy(new Error("请求超时")));
  });
}

function awemeIdOf(url: string): string | undefined {
  return url.match(/(\d{15,25})/)?.[1];
}

/**
 * 抖音的详情接口被 Argus 风控（要求正式 UIFID cookie），纯 HTTP 拿不到播放地址；
 * 但 SEO 分享页是公开的，能稳定拿到标题、作者、封面。先把这些填上，让人工上传时不至于一片空白。
 */
async function enrichFromSeo(videoId: number, url: string, dataDir: string, service: Service): Promise<DouyinSeo | null> {
  const awemeId = awemeIdOf(url);
  if (!awemeId) return null;
  try {
    const html = await fetchText(`https://www.iesdouyin.com/share/video/${awemeId}/`, SEO_UA);
    const meta = parseDouyinSeo(html);
    if (!meta.title && !meta.covers.length) return null;
    if (meta.title) service.markVideo(videoId, { title: meta.title });
    if (meta.covers.length) {
      const covers = path.join(dataDir, "covers");
      mkdirSync(covers, { recursive: true });
      await downloadToFile(meta.covers[0], path.join(covers, `${videoId}.jpg`), { "user-agent": SEO_UA }, () => undefined).catch(() => undefined);
    }
    return meta;
  } catch {
    return null;
  }
}

export function pickPlayUrls(video: DouyinVideo, maxShortSide = 720): string[] {
  const h264 = (video.bit_rate ?? []).filter((item) => !item.is_h265 && item.play_addr?.url_list?.length);
  const shortSide = (addr: PlayAddr) => Math.min(addr.width || addr.height || 0, addr.height || addr.width || 0);
  const fit = h264.filter((item) => shortSide(item.play_addr!) <= maxShortSide);
  const best = (fit.length ? fit : h264).sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
  return best?.play_addr?.url_list ?? video.play_addr?.url_list ?? [];
}

/**
 * Node 22 的 undici 在第一次访问 fetch / Response 等全局时才会实例化 WASM（llhttp 解析器）。
 * 一些受限环境（地址空间被压到 4GB、内存紧张）会让这次 WASM 分配直接抛 RangeError 甚至带走进程，
 * 而 playwright-core 加载时就会碰这些全局。这里先占位，避免解析抖音链接时把服务折腾崩。
 * 服务端自己的下载走 node:https，不依赖 undici。
 */
let undiciStubbed = false;
function stubUndiciGlobals() {
  if (undiciStubbed) return;
  undiciStubbed = true;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.fetch = () => Promise.reject(new Error("fetch 已停用（改用 node:https）"));
  for (const name of ["Headers", "Request", "Response", "FormData"]) globals[name] = class {};
}

type BrowserHandle = Awaited<ReturnType<(typeof import("playwright-core"))["firefox"]["launch"]>>;
type BrowserPage = Awaited<ReturnType<BrowserHandle["newPage"]>>;
export type BrowserSession = { engine: "chromium" | "firefox"; userAgent: string; newPage: () => Promise<BrowserPage>; close: () => Promise<void> };

/** 抖音会检查 navigator.webdriver / window.chrome 这些自动化痕迹，进页面之前先抹掉。 */
const STEALTH = [
  "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
  "Object.defineProperty(navigator,'languages',{get:()=>['zh-CN','zh','en']});",
  "window.chrome=window.chrome||{runtime:{}};",
].join("");

const CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
];

/**
 * 抖音详情只能靠真浏览器通过人机校验后自己发请求，所以这里需要一个能跑起来的浏览器。
 * 优先 Chromium：它把渲染拆成独立子进程，每个进程单独吃一份地址空间，
 * 在「单进程地址空间被压到 4GB」的机器上不会像 Firefox 那样十几秒就 OOM 崩掉。
 * 给了 profileDir 就用持久化用户目录，扫码登录一次后 UIFID / ttwid 这些 cookie 会一直留着。
 */
export async function launchBrowser(profileDir?: string): Promise<BrowserSession> {
  stubUndiciGlobals();
  const { firefox, chromium } = await import("playwright-core");
  const preference = (process.env.GP_BROWSER || "auto").toLowerCase();
  if (preference === "none" || preference === "off") throw new Error("已按 GP_BROWSER 配置关闭浏览器通道");
  const problems: string[] = [];
  const headless = process.env.GP_BROWSER_HEADED !== "1";
  const order: ("chromium" | "firefox")[] = preference === "firefox" ? ["firefox"] : preference === "chromium" ? ["chromium"] : ["chromium", "firefox"];

  for (const engine of order) {
    if (engine === "chromium") {
      const shared = {
        headless,
        locale: "zh-CN",
        viewport: { width: 1366, height: 900 },
        userAgent: CHROMIUM_UA,
        ignoreDefaultArgs: ["--enable-automation"],
        args: CHROMIUM_ARGS,
      };
      const variants: { label: string; opts: Record<string, unknown> }[] = [];
      if (profileDir) variants.push({ label: "Chromium（带登录态）", opts: { ...shared, channel: "chromium", userDataDir: profileDir } });
      variants.push({ label: "Chromium", opts: { ...shared, channel: "chromium" } });
      variants.push({ label: "Chromium", opts: shared });

      for (const { label, opts } of variants) {
        try {
          if (profileDir && opts.userDataDir) {
            mkdirSync(profileDir, { recursive: true });
            const context = await chromium.launchPersistentContext(profileDir, { ...opts, userDataDir: undefined, executablePath: process.env.CHROMIUM_PATH || undefined });
            await context.addInitScript({ content: STEALTH });
            return { engine: "chromium", userAgent: CHROMIUM_UA, newPage: () => context.newPage(), close: () => context.close() };
          }
          const browser = await chromium.launch({ ...opts, channel: opts.channel === "chromium" ? "chromium" : undefined, executablePath: process.env.CHROMIUM_PATH || undefined });
          const context = await browser.newContext({ userAgent: CHROMIUM_UA, locale: "zh-CN", viewport: { width: 1366, height: 900 } });
          await context.addInitScript({ content: STEALTH });
          return { engine: "chromium", userAgent: CHROMIUM_UA, newPage: () => context.newPage(), close: () => browser.close() };
        } catch (error) {
          const text = errorText(error);
          if (!problems.some((item) => item.endsWith(text))) problems.push(`${label}：${text}`);
        }
      }
    } else {
      try {
        const browser = await firefox.launch({
          headless,
          executablePath: process.env.FIREFOX_PATH || undefined,
          env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: "1" },
          firefoxUserPrefs: { "security.sandbox.content.level": 0, "dom.ipc.processCount": 1, "permissions.default.image": 2 },
        });
        const context = await browser.newContext({ userAgent: FIREFOX_UA, locale: "zh-CN", viewport: { width: 1280, height: 900 } });
        return { engine: "firefox", userAgent: FIREFOX_UA, newPage: () => context.newPage(), close: () => browser.close() };
      } catch (error) {
        problems.push(`Firefox：${errorText(error)}`);
      }
    }
  }
  throw new Error(`没有可用的浏览器（${problems.join("；")}）。装一个：ops/install-browser.sh`);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 160);
}

async function fetchDouyinDetail(url: string, dataDir?: string): Promise<{ desc?: string; video: DouyinVideo }> {
  const session = await launchBrowser(dataDir ? path.join(dataDir, "browser-profile") : undefined);
  let crashed = false;
  try {
    const page = await session.newPage();
    page.on("crash", () => { crashed = true; });
    let body = "";
    let emptyDetail = false;
    page.on("response", (res) => {
      if (body || !res.url().includes("/aweme/v1/web/aweme/detail/")) return;
      res.text().then((text) => {
        if (body) return;
        if (text && text.includes("aweme_detail")) body = text;
        else if (res.status() === 200) emptyDetail = true;
      }).catch(() => undefined);
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const deadline = Date.now() + 25000;
    while (!body && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300));
    if (!body) {
      if (crashed) throw new Error("浏览器页面崩了（内存不足），改用无头内核再试一次");
      throw new Error(emptyDetail
        ? "抖音风控要求正式 UIFID：详情接口返回空数据（未登录）。先跑 ops/douyin-login.sh 扫码登录一次，之后就能自动下载"
        : "浏览器没有拿到抖音详情接口的响应");
    }
    const parsed = JSON.parse(body) as { aweme_detail?: { desc?: string; video?: DouyinVideo } };
    if (!parsed.aweme_detail?.video) throw new Error("抖音没有返回视频信息，可能触发了验证");
    return { desc: parsed.aweme_detail.desc, video: parsed.aweme_detail.video };
  } finally {
    await session.close().catch(() => undefined);
  }
}

function downloadToFile(url: string, out: string, headers: Record<string, string>, onProgress: (received: number, total: number | null) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (target: string, hops: number) => {
      if (hops > 5) {
        reject(new Error("视频地址重定向次数过多"));
        return;
      }
      const client = target.startsWith("http:") ? http : https;
      const request = client.get(target, { headers }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          follow(new URL(response.headers.location, target).toString(), hops + 1);
          return;
        }
        if (status !== 200 && status !== 206) {
          response.resume();
          reject(new Error(`视频地址返回 ${status}`));
          return;
        }
        const total = Number(response.headers["content-length"]) || null;
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          onProgress(received, total);
        });
        response.on("error", reject);
        const file = createWriteStream(out);
        file.on("error", reject);
        file.on("finish", () => resolve());
        response.pipe(file);
      });
      request.on("error", reject);
      request.setTimeout(30000, () => request.destroy(new Error("下载超时")));
    };
    follow(url, 0);
  });
}

/** 登录脚本扫码成功后会留下这个标记；没有它就别浪费 55 秒去开浏览器了。 */
export const LOGIN_MARKER = ".gp-logged-in";

export function douyinLoggedIn(dataDir: string): boolean {
  if ((process.env.GP_DOUYIN_LOGIN || "").toLowerCase() === "skip") return true;
  return existsSync(path.join(dataDir, "browser-profile", LOGIN_MARKER));
}

async function downloadViaBrowser(url: string, out: string, videoId: number, dataDir: string) {
  // 没登录时抖音一定返回空数据（甚至先甩验证码），这里直接短路，不要让人盯着进度条等 55 秒
  if (!douyinLoggedIn(dataDir)) throw new Error("还没扫码登录抖音，抓不到播放地址——先跑一次 bash ops/douyin-login.sh");
  setJob(videoId, { phase: "opening", received: 0, total: null, startedAt: Date.now() });
  const detail = await fetchDouyinDetail(url, dataDir);
  const urls = pickPlayUrls(detail.video);
  if (!urls.length) throw new Error("抖音视频信息里没有播放地址");
  let lastError: unknown;
  for (const playUrl of urls) {
    try {
      const startedAt = Date.now();
      let total: number | null = null;
      setJob(videoId, { phase: "downloading", received: 0, total: null, startedAt });
      await downloadToFile(playUrl, out, { "user-agent": CHROMIUM_UA, referer: "https://www.douyin.com/" }, (received, size) => {
        total = size ?? total;
        setJob(videoId, { phase: "downloading", received, total, startedAt });
      });
      return;
    } catch (error) {
      lastError = error;
      rmSync(out, { force: true });
    }
  }
  throw lastError;
}

function runYtDlp(url: string, out: string, videoId: number, dataDir?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-o", out, "--no-playlist", "--merge-output-format", "mp4", "--newline"];
    // 扫码登录过会导出 cookies.txt，有的话交给 yt-dlp 一起用
    const cookies = dataDir ? path.join(dataDir, "cookies.txt") : "";
    if (cookies && existsSync(cookies)) args.push("--cookies", cookies);
    args.push(url);
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
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
  const seo = await enrichFromSeo(videoId, url, dataDir, service);
  const errors: string[] = [];
  for (const [name, attempt] of [
    ["浏览器", () => downloadViaBrowser(url, out, videoId, dataDir)],
    ["yt-dlp", () => runYtDlp(url, out, videoId, dataDir)],
  ] as const) {
    try {
      await attempt();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${name}：${message.includes("ENOENT") ? "服务器上没有安装" : message.split("\n")[0].slice(0, 120)}`);
      continue;
    }
    // 通道只留一条日志：下次出问题能立刻看出是浏览器成的还是 yt-dlp 成的
    console.log(`[下载] 视频 ${videoId} 经「${name}」通道拿到文件`);
    await finalizeVideo(service, videoId, out);
    return;
  }
  clearJob(videoId);
  console.log(`[下载] 视频 ${videoId} 全部通道失败：${errors.join("；")}`);
  const hint = seo?.title
    ? "标题和封面已经自动填好，视频文件请用手机「分享 → 保存到相册」后从相册上传。"
    : "没能自动下载这个视频，请用手机把它保存到相册后从相册上传。";
  service.markVideo(videoId, { status: "failed", error: `${hint}（${errors.join("；")}）`.slice(0, 400) });
}
