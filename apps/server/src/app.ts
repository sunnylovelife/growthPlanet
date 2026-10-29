import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { enqueueDownload, probeDuration } from "./download.ts";
import { HttpError, createService, type Clock, type Service } from "./service.ts";

type Ctx = { params: Record<string, string>; query: Record<string, string>; body: unknown; raw: Buffer; user: ReturnType<Service["publicUser"]> | null };

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
  const uploads = new Map<string, { filename: string; dir: string; parts: number }>();

  const routes: { method: string; path: string; role?: "parent" | "child"; handler: (ctx: Ctx, res: ServerResponse, req: IncomingMessage) => Promise<unknown> }[] = [
    { method: "GET", path: "/api/ping", handler: async () => ({ ok: true, now: opts.clock.now().toISOString() }) },
    { method: "POST", path: "/api/auth/login", handler: async (ctx, res) => {
      const body = ctx.body as { username?: string; password?: string; portal?: "kid" | "admin" };
      const result = service.login(body.username || "", body.password || "", body.portal === "admin" ? "admin" : "kid", { device: reqHeader(res, "user-agent-store"), ip: "" });
      res.setHeader("set-cookie", `gp_session=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
      return { user: result.user };
    } },
    { method: "POST", path: "/api/auth/logout", handler: async (ctx, res) => {
      const token = cookiesFromCtx(ctx);
      if (token) service.logout(token);
      res.setHeader("set-cookie", "gp_session=; Path=/; HttpOnly; Max-Age=0");
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
    { method: "PATCH", path: "/api/admin/videos/:id", role: "parent", handler: async (ctx) => service.markVideo(Number(ctx.params.id), ctx.body as { title?: string; published?: boolean; durationSeconds?: number }) },
    { method: "DELETE", path: "/api/admin/videos/:id", role: "parent", handler: async (ctx) => { service.deleteVideo(mustUser(ctx).id, Number(ctx.params.id)); return { ok: true }; } },
    { method: "POST", path: "/api/admin/uploads", role: "parent", handler: async (ctx) => {
      const body = ctx.body as { filename?: string; parts?: number };
      const id = randomBytes(8).toString("hex");
      const dir = path.join(opts.dataDir, "uploads", id);
      mkdirSync(dir, { recursive: true });
      uploads.set(id, { filename: body.filename || "video.mp4", dir, parts: body.parts || 1 });
      return { id };
    } },
    { method: "PUT", path: "/api/admin/uploads/:id/chunks/:n", role: "parent", handler: async (ctx) => {
      const slot = uploads.get(ctx.params.id);
      if (!slot) throw new HttpError(404, "上传已失效，请重新选择");
      writeFileSync(path.join(slot.dir, ctx.params.n), ctx.raw);
      return { ok: true };
    } },
    { method: "POST", path: "/api/admin/uploads/:id/finish", role: "parent", handler: async (ctx) => {
      const slot = uploads.get(ctx.params.id);
      if (!slot) throw new HttpError(404, "上传已失效，请重新选择");
      const dir = path.join(opts.dataDir, "videos");
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${Date.now()}.mp4`);
      const out = createWriteStream(target);
      for (let i = 0; i < slot.parts; i++) out.write(readFileSync(path.join(slot.dir, String(i))));
      await new Promise((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve(null)));
      const duration = await probeDuration(target);
      uploads.delete(ctx.params.id);
      return service.saveUpload(mustUser(ctx).id, slot.filename, target, duration);
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
  function reqHeader(_res: ServerResponse, _name: string) { return ""; }

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
      const raw = await readRaw(req);
      const contentType = String(req.headers["content-type"] || "");
      const body = contentType.includes("application/json") && raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const token = cookies(req).gp_session;
      const user = service.userByToken(token);
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
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      const message = error instanceof Error ? error.message : "";
      if (message.includes("UNIQUE")) return send(res, 400, { error: "已经存在，不能重复" });
      console.error(error);
      send(res, 500, { error: "服务器出错了" });
    }
  });

  return { server, service };
}

function streamFile(req: IncomingMessage, res: ServerResponse, file: string, type: string) {
  const stat = statSync(file);
  const range = req.headers.range;
  if (range) {
    const matched = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(matched?.[1] ?? 0);
    const end = matched?.[2] ? Number(matched[2]) : stat.size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1, "cache-control": "no-store" });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": stat.size, "accept-ranges": "bytes", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}

function serveWeb(webRoot: string, url: string, res: ServerResponse) {
  const adminRoot = path.join(webRoot, "apps/admin/dist");
  const kidRoot = path.join(webRoot, "apps/kid/dist");
  if (url === "/admin" || url.startsWith("/admin/")) {
    if (!existsSync(adminRoot)) return false;
    const rel = url.replace(/^\/admin\/?/, "") || "index.html";
    const file = path.normalize(path.join(adminRoot, rel));
    const target = existsSync(file) && statSync(file).isFile() ? file : path.join(adminRoot, "index.html");
    streamFile({ headers: {} } as IncomingMessage, res, target, mime(target));
    return true;
  }
  if (!existsSync(kidRoot) || url.startsWith("/api")) return false;
  const file = path.normalize(path.join(kidRoot, url === "/" ? "index.html" : url));
  const target = file.startsWith(kidRoot) && existsSync(file) && statSync(file).isFile() ? file : path.join(kidRoot, "index.html");
  streamFile({ headers: {} } as IncomingMessage, res, target, mime(target));
  return true;
}

function mime(file: string) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
