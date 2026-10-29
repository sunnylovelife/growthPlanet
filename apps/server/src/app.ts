import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { enqueueDownload, enqueueTranscode, probeDuration } from "./download.ts";
import { HttpError, createService, type Clock, type Service } from "./service.ts";

type Ctx = { params: Record<string, string>; query: Record<string, string>; body: unknown; raw: Buffer; user: ReturnType<Service["publicUser"]> | null };

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

const ANON_BODY_LIMIT = 64 * 1024;
const AUTHED_BODY_LIMIT = 20 * 1024 * 1024;
const MAX_UPLOAD_PARTS = 400;
const UPLOAD_TTL_MS = 24 * 3600 * 1000;

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] || 0) > limit) return reject(new HttpError(413, "内容太大了"));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.pause();
        return reject(new HttpError(413, "内容太大了"));
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function fromLocalProxy(req: IncomingMessage) {
  const remote = req.socket.remoteAddress || "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function clientIp(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  if (forwarded && fromLocalProxy(req)) return forwarded.split(",").pop()!.trim();
  return req.socket.remoteAddress || "";
}

function sessionCookie(req: IncomingMessage, value: string, maxAge: number) {
  const secure = fromLocalProxy(req) && req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `gp_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function insideDir(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  return file === base || file.startsWith(base + path.sep) ? file : null;
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) out[key] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function fileFromMultipart(raw: Buffer, contentType: string): Buffer | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.[1] || /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.[2];
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let cursor = raw.indexOf(marker);
  while (cursor >= 0) {
    const next = raw.indexOf(marker, cursor + marker.length);
    if (next < 0) break;
    parts.push(raw.subarray(cursor + marker.length, next));
    cursor = next;
  }
  for (const part of parts) {
    const textStart = part[0] === 13 ? 2 : 0;
    const sep = part.indexOf(Buffer.from("\r\n\r\n"), textStart);
    if (sep < 0) continue;
    const head = part.subarray(textStart, sep).toString("utf8");
    if (!head.includes("filename=")) continue;
    let data = part.subarray(sep + 4);
    if (data.length >= 2 && data[data.length - 2] === 13) data = data.subarray(0, -2);
    return data;
  }
  return null;
}

function matchRoute(method: string, url: string, routeMethod: string, pattern: string) {
  if (method !== routeMethod) return null;
  const [pathname, search = ""] = url.split("?");
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].startsWith(":")) params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
    else if (expected[i] !== actual[i]) return null;
  }
  return { params, query: Object.fromEntries(new URLSearchParams(search)) };
}

export function buildApp(opts: { db: DatabaseSync; clock: Clock; dataDir: string; webRoot?: string }) {
  const service = createService(opts.db, opts.clock, opts.dataDir);
  const uploads = new Map<string, { filename: string; dir: string; parts: number; createdAt: number }>();
  const uploadsRoot = path.join(opts.dataDir, "uploads");
  // 上传进度只存在内存里，启动时残留的分片都已无法续传
  rmSync(uploadsRoot, { recursive: true, force: true });

  function sweepUploads() {
    for (const [id, slot] of uploads) {
      if (Date.now() - slot.createdAt < UPLOAD_TTL_MS) continue;
      uploads.delete(id);
      rmSync(slot.dir, { recursive: true, force: true });
    }
  }

  const routes: { method: string; path: string; role?: "parent" | "child"; handler: (ctx: Ctx, res: ServerResponse, req: IncomingMessage) => Promise<unknown> }[] = [
    { method: "GET", path: "/api/ping", handler: async () => ({ ok: true, now: opts.clock.now().toISOString() }) },
    { method: "POST", path: "/api/auth/login", handler: async (ctx, res, req) => {
      const body = ctx.body as { username?: string; password?: string; portal?: "kid" | "admin" };
      const device = String(req.headers["user-agent"] || "").slice(0, 200);
      const result = service.login(String(body.username || ""), String(body.password || ""), body.portal === "admin" ? "admin" : "kid", { device, ip: clientIp(req) });
      res.setHeader("set-cookie", sessionCookie(req, result.token, 30 * 24 * 3600));
      return { user: result.user };
    } },
    { method: "POST", path: "/api/auth/logout", handler: async (ctx, res, req) => {
      const token = cookiesFromCtx(ctx);
      if (token) service.logout(token);
      res.setHeader("set-cookie", sessionCookie(req, "", 0));
      return { ok: true };
    } },
    { method: "GET", path: "/api/auth/me", role: undefined, handler: async (ctx) => ({ user: mustUser(ctx) }) },
    { method: "GET", path: "/api/home", role: "child", handler: async (ctx) => service.kidHome(mustUser(ctx).id) },
    { method: "POST", path: "/api/notices/read", role: "child", handler: async (ctx) => { service.markNoticesRead(mustUser(ctx).id); return { ok: true }; } },
    { method: "PATCH", path: "/api/me", role: "child", handler: async (ctx) => service.updateMe(mustUser(ctx).id, ctx.body as { nickname?: string; outfitId?: string }) },
    { method: "GET", path: "/api/album", role: "child", handler: async (ctx) => service.album(mustUser(ctx).id) },
    { method: "GET", path: "/api/wallet", role: "child", handler: async (ctx) => service.ledger(mustUser(ctx).id) },
    { method: "GET", path: "/api/videos", role: "child", handler: async (ctx) => ({ videos: service.listVideos(mustUser(ctx).id) }) },
    { method: "GET", path: "/api/videos/:id/quote", role: "child", handler: async (ctx) => service.quoteVideo(mustUser(ctx).id, Number(ctx.params.id)) },
    { method: "POST", path: "/api/videos/:id/play", role: "child", handler: async (ctx) => {
      const body = ctx.body as { quotedPrice?: number | null; idempotencyKey?: string };
      return service.startPlay(mustUser(ctx).id, Number(ctx.params.id), body.quotedPrice ?? null, body.idempotencyKey || randomBytes(8).toString("hex"));
    } },
    { method: "POST", path: "/api/watch/:id/heartbeat", role: "child", handler: async (ctx) => service.heartbeat(mustUser(ctx).id, Number(ctx.params.id), Number((ctx.body as { seconds?: number }).seconds ?? 0)) },
    { method: "POST", path: "/api/watch/:id/end", role: "child", handler: async (ctx) => service.endWatch(mustUser(ctx).id, Number(ctx.params.id), String((ctx.body as { reason?: string }).reason || "closed"), Number((ctx.body as { seconds?: number }).seconds ?? 0)) },
    { method: "POST", path: "/api/rewards/:id/claim", role: "child", handler: async (ctx) => service.claim(mustUser(ctx).id, Number(ctx.params.id)) },
    { method: "POST", path: "/api/events", role: "child", handler: async (ctx) => { service.recordEvents(mustUser(ctx).id, ((ctx.body as { events?: [] }).events) || []); return { ok: true }; } },
    { method: "POST", path: "/api/tasks/:id/submit", role: "child", handler: async (ctx, _res, req) => {
      const photo = fileFromMultipart(ctx.raw, String(req.headers["content-type"] || ""));
      if (!photo?.length) throw new HttpError(400, "请拍一张作业照片");
      return service.submitPhoto(mustUser(ctx).id, Number(ctx.params.id), photo);
    } },
    { method: "GET", path: "/api/admin/today", role: "parent", handler: async () => ({ children: service.adminToday(), approvals: service.approvals() }) },
    { method: "POST", path: "/api/admin/tasks/:id/complete", role: "parent", handler: async (ctx) => service.completeTask(mustUser(ctx).id, Number(ctx.params.id), (ctx.body as { completedAt?: string }).completedAt) },
    { method: "PATCH", path: "/api/admin/tasks/:id/deadline", role: "parent", handler: async (ctx) => {
      const deadlineAt = (ctx.body as { deadlineAt?: string }).deadlineAt;
      if (!deadlineAt) throw new HttpError(400, "请填写截止时间");
      return service.setDeadline(mustUser(ctx).id, Number(ctx.params.id), deadlineAt);
    } },
    { method: "POST", path: "/api/admin/tasks/:id/skip", role: "parent", handler: async (ctx) => service.skipSwim(mustUser(ctx).id, Number(ctx.params.id)) },
    { method: "POST", path: "/api/admin/tasks/:id/undo", role: "parent", handler: async (ctx) => service.undoTask(mustUser(ctx).id, Number(ctx.params.id)) },
    { method: "GET", path: "/api/admin/videos", role: "parent", handler: async () => ({ videos: service.listVideos() }) },
    { method: "POST", path: "/api/admin/videos", role: "parent", handler: async (ctx) => {
      const created = service.addVideoFromShare(mustUser(ctx).id, String((ctx.body as { shareText?: string }).shareText || ""));
      const row = service.markVideo(created.id, { status: "queued" });
      enqueueDownload(service, created.id, created.url!, opts.dataDir);
      return row;
    } },
    { method: "POST", path: "/api/admin/videos/:id/retry", role: "parent", handler: async (ctx) => {
      const video = service.markVideo(Number(ctx.params.id), { status: "queued", error: null }) as { source_url?: string };
      if (!video?.source_url) throw new HttpError(400, "这条没有链接，请重新上传");
      enqueueDownload(service, Number(ctx.params.id), video.source_url, opts.dataDir);
      return { ok: true };
    } },
    { method: "PATCH", path: "/api/admin/videos/:id", role: "parent", handler: async (ctx) => {
      const body = ctx.body as { title?: unknown; published?: unknown; durationSeconds?: unknown };
      return service.markVideo(Number(ctx.params.id), {
        title: typeof body.title === "string" ? body.title : undefined,
        published: typeof body.published === "boolean" ? body.published : undefined,
        durationSeconds: Number.isFinite(body.durationSeconds) ? Number(body.durationSeconds) : undefined,
      });
    } },
    { method: "DELETE", path: "/api/admin/videos/:id", role: "parent", handler: async (ctx) => { service.deleteVideo(mustUser(ctx).id, Number(ctx.params.id)); return { ok: true }; } },
    { method: "POST", path: "/api/admin/uploads", role: "parent", handler: async (ctx) => {
      const body = ctx.body as { filename?: string; parts?: number };
      const parts = Math.floor(Number(body.parts) || 1);
      if (parts < 1 || parts > MAX_UPLOAD_PARTS) throw new HttpError(400, "视频太大了，最多 2GB");
      sweepUploads();
      const id = randomBytes(8).toString("hex");
      const dir = path.join(uploadsRoot, id);
      mkdirSync(dir, { recursive: true });
      uploads.set(id, { filename: String(body.filename || "video.mp4").slice(0, 120), dir, parts, createdAt: Date.now() });
      return { id };
    } },
    { method: "PUT", path: "/api/admin/uploads/:id/chunks/:n", role: "parent", handler: async (ctx) => {
      const slot = uploads.get(ctx.params.id);
      if (!slot) throw new HttpError(404, "上传已失效，请重新选择");
      if (!/^\d+$/.test(ctx.params.n) || Number(ctx.params.n) >= slot.parts) throw new HttpError(400, "分片编号不对");
      writeFileSync(path.join(slot.dir, String(Number(ctx.params.n))), ctx.raw);
      return { ok: true };
    } },
    { method: "POST", path: "/api/admin/uploads/:id/finish", role: "parent", handler: async (ctx) => {
      const slot = uploads.get(ctx.params.id);
      if (!slot) throw new HttpError(404, "上传已失效，请重新选择");
      for (let i = 0; i < slot.parts; i++) if (!existsSync(path.join(slot.dir, String(i)))) throw new HttpError(400, "还有分片没传完，请重新上传");
      const dir = path.join(opts.dataDir, "videos");
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${Date.now()}.mp4`);
      try {
        const out = createWriteStream(target);
        for (let i = 0; i < slot.parts; i++) out.write(readFileSync(path.join(slot.dir, String(i))));
        await new Promise((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve(null)));
      } finally {
        uploads.delete(ctx.params.id);
        rmSync(slot.dir, { recursive: true, force: true });
      }
      const duration = await probeDuration(target);
      const saved = service.saveUpload(mustUser(ctx).id, slot.filename, target, duration);
      enqueueTranscode(service, saved.id, target);
      return saved;
    } },
    { method: "GET", path: "/api/admin/ledger", role: "parent", handler: async (ctx) => service.ledger(Number(ctx.query.childId)) },
    { method: "POST", path: "/api/admin/ledger/other", role: "parent", handler: async (ctx) => service.otherEntry(mustUser(ctx).id, ctx.body as { childIds: number[]; kind: "income" | "expense"; title: string; amount: number }) },
    { method: "GET", path: "/api/admin/events", role: "parent", handler: async (ctx) => ({ events: service.events({ childId: ctx.query.childId ? Number(ctx.query.childId) : undefined, type: ctx.query.type }) }) },
    { method: "GET", path: "/api/admin/stats/today", role: "parent", handler: async () => ({ children: service.statsToday() }) },
    { method: "GET", path: "/api/admin/action-logs", role: "parent", handler: async () => ({ logs: service.actionLogs() }) },
    { method: "GET", path: "/api/admin/users", role: "parent", handler: async () => ({ users: service.users() }) },
    { method: "POST", path: "/api/admin/users", role: "parent", handler: async (ctx) => ({ users: service.createUser(mustUser(ctx).id, ctx.body as { username: string; password: string; role: "parent" | "child"; displayRole: string; nickname?: string }) }) },
    { method: "PATCH", path: "/api/admin/users/:id", role: "parent", handler: async (ctx) => ({ users: service.updateUser(mustUser(ctx).id, Number(ctx.params.id), ctx.body as { password?: string; status?: string; displayRole?: string }) }) },
    { method: "GET", path: "/api/admin/settings", role: "parent", handler: async () => ({ economy: service.economy() }) },
    { method: "PUT", path: "/api/admin/settings", role: "parent", handler: async (ctx) => { service.saveEconomy(mustUser(ctx).id, ctx.body as ReturnType<Service["economy"]>); return { economy: service.economy() }; } },
    { method: "POST", path: "/api/admin/jobs/run", role: "parent", handler: async () => { service.runJobs(); return { ok: true }; } },
  ];

  function mustUser(ctx: Ctx) {
    if (!ctx.user) throw new HttpError(401, "请先登录");
    return ctx.user;
  }
  function cookiesFromCtx(ctx: Ctx) {
    return (ctx as Ctx & { token?: string }).token;
  }
  const server = createServer(async (req, res) => {
    try {
      const url = req.url || "/";
      if (req.method === "GET" && url.startsWith("/media/videos/")) {
        const token = new URL(url, "http://local").searchParams.get("t") || undefined;
        const file = service.mediaAuth(token);
        return streamFile(req, res, file, "video/mp4");
      }
      if (req.method === "GET" && /^\/api\/admin\/tasks\/\d+\/photo/.test(url.split("?")[0])) {
        const token = cookies(req).gp_session;
        const user = service.userByToken(token);
        if (!user || user.role !== "parent") throw new HttpError(403, "只有家长可以看");
        const id = Number(url.split("/")[4]);
        return streamFile(req, res, service.photoFile(id), "image/jpeg");
      }
      const token = cookies(req).gp_session;
      const user = service.userByToken(token);
      const raw = await readRaw(req, user ? AUTHED_BODY_LIMIT : ANON_BODY_LIMIT);
      const contentType = String(req.headers["content-type"] || "");
      let body: unknown = {};
      if (contentType.includes("application/json") && raw.length) {
        try { body = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "请求格式不对"); }
      }
      for (const route of routes) {
        const matched = matchRoute(req.method || "GET", url, route.method, route.path);
        if (!matched) continue;
        if (route.role && user?.role !== route.role) throw new HttpError(user ? 403 : 401, user ? (route.role === "parent" ? "只有家长可以操作" : "请用孩子账号") : "请先登录");
        if (!route.role && route.path === "/api/auth/me" && !user) throw new HttpError(401, "请先登录");
        const ctx = { params: matched.params, query: matched.query, body, raw, user, token } as Ctx & { token?: string };
        const result = await route.handler(ctx, res, req);
        if (!res.headersSent && result !== undefined) send(res, 200, result);
        else if (!res.headersSent) res.end();
        return;
      }
      if (opts.webRoot && req.method === "GET") {
        const served = serveWeb(opts.webRoot, url.split("?")[0], res);
        if (served) return;
      }
      send(res, 404, { error: "没有这个页面" });
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof HttpError && error.status === 413) res.setHeader("connection", "close");
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      const message = error instanceof Error ? error.message : "";
      if (message.includes("UNIQUE")) return send(res, 400, { error: "已经存在，不能重复" });
      console.error(error);
      send(res, 500, { error: "服务器出错了" });
    }
  });

  return { server, service };
}

function streamFile(req: IncomingMessage, res: ServerResponse, file: string, type: string, cacheControl = "no-store") {
  const stat = statSync(file);
  const range = req.headers.range;
  if (range) {
    const matched = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(matched?.[1] ?? 0);
    const end = Math.min(matched?.[2] ? Number(matched[2]) : stat.size - 1, stat.size - 1);
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1, "cache-control": cacheControl });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": stat.size, "accept-ranges": "bytes", "cache-control": cacheControl });
  createReadStream(file).pipe(res);
}

function serveWeb(webRoot: string, url: string, res: ServerResponse) {
  const isAdmin = url === "/admin" || url.startsWith("/admin/");
  if (!isAdmin && url.startsWith("/api")) return false;
  const root = path.join(webRoot, isAdmin ? "apps/admin/dist" : "apps/kid/dist");
  if (!existsSync(root)) return false;
  const rel = (isAdmin ? url.replace(/^\/admin\/?/, "") : url.replace(/^\/+/, "")) || "index.html";
  const file = insideDir(root, rel);
  const target = file && existsSync(file) && statSync(file).isFile() ? file : path.join(root, "index.html");
  // 带哈希的打包产物可以长期缓存；index.html、sw.js 等每次都要回源确认
  const cache = target.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
  streamFile({ headers: {} } as IncomingMessage, res, target, mime(target), cache);
  return true;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
};

function mime(file: string) {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
