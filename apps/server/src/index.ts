import path from "node:path";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrate, openDatabase } from "./db.ts";
import { buildApp } from "./app.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = path.join(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = openDatabase(path.join(dataDir, "growth.sqlite"));
migrate(db);
const { server, service } = buildApp({ db, clock: { now: () => new Date() }, dataDir, webRoot: root });
service.seed();
const demoDir = path.join(dataDir, "videos");
mkdirSync(demoDir, { recursive: true });
if (service.listVideos().length === 0) {
  const demo = path.join(demoDir, "welcome.mp4");
  const made = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=0x1b3a4b:s=640x360:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-pix_fmt", "yuv420p", demo], { stdio: "ignore" });
  if (made.status === 0) {
    const parent = service.users().find((user) => user.username === "parent");
    if (parent) {
      const saved = service.saveUpload(parent.id, "欢迎来到成长星球.mp4", demo, 3);
      service.markVideo(saved.id, { published: true });
    }
  }
}
setInterval(() => {
  try { service.runJobs(); } catch (error) { console.error(error); }
}, 30_000);
service.runJobs();

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`成长星球已启动 http://localhost:${port}`);
  console.log("孩子端开发地址 http://localhost:5173    家长后台 http://localhost:5174");
  console.log("初始账号  家长 parent / 123456    儿子 boy / 123456    女儿 girl / 123456");
});
