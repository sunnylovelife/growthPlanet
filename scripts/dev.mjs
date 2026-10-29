import { spawn } from "node:child_process";

const children = [
  spawn("node", ["--experimental-strip-types", "apps/server/src/index.ts"], { stdio: "inherit" }),
  spawn("pnpm", ["--dir", "apps/kid", "dev"], { stdio: "inherit" }),
  spawn("pnpm", ["--dir", "apps/admin", "dev"], { stdio: "inherit" }),
];
for (const child of children) child.on("exit", (code) => { if (code) process.exit(code); });
process.on("SIGINT", () => { for (const child of children) child.kill("SIGINT"); process.exit(0); });
