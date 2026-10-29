import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.ts";
import { migrate, openDatabase } from "../src/db.ts";

function boot(start = "2026-10-28T02:00:00.000Z") {
  const clock = { current: new Date(start), now() { return this.current; } };
  const db = openDatabase(":memory:");
  migrate(db);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gp-"));
  const built = buildApp({ db, clock, dataDir });
  built.service.seed();
  built.service.ensureCurrentWeeks();
  return { ...built, clock, dataDir };
}

async function listen(server: ReturnType<typeof boot>["server"]) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function login(base: string, username: string, portal: "kid" | "admin") {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "123456", portal }),
  });
  const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  return { status: res.status, body: await res.json(), cookie: String(setCookie[0] || "").split(";")[0] };
}

test("登录区分家长和孩子", async () => {
  const { server } = boot();
  const base = await listen(server);
  try {
    const parent = await login(base, "parent", "admin");
    assert.equal(parent.status, 200);
    assert.equal(parent.body.user.role, "parent");
    const kidAsAdmin = await login(base, "boy", "admin");
    assert.equal(kidAsAdmin.status, 403);
    const parentAsKid = await login(base, "parent", "kid");
    assert.equal(parentAsKid.status, 403);
    const boy = await login(base, "boy", "kid");
    assert.equal(boy.status, 200);
    const wrong = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "boy", password: "nope", portal: "kid" }) });
    assert.equal(wrong.status, 401);
  } finally {
    server.close();
  }
});

test("周三学校作业在截止前达标，周一没完成就没有连续加成", async () => {
  const { server, service } = boot();
  const base = await listen(server);
  try {
    const parent = await login(base, "parent", "admin");
    const boy = service.adminToday().find((child) => child.username === "boy")!;
    const school = boy.tasks.find((task) => task.code === "school_hw")!;
    const done = await fetch(`${base}/api/admin/tasks/${school.id}/complete`, { method: "POST", headers: { cookie: parent.cookie, "content-type": "application/json" }, body: "{}" });
    const doneBody = await done.json();
    assert.equal(done.status, 200);
    assert.equal(doneBody.qualified, true);
    assert.equal(doneBody.rewardAmount, 3);
    const home = service.kidHome(boy.id);
    assert.equal(home.unclaimed[0].amount, 3);
    assert.equal(home.unclaimed[0].cardDraws, 1);
    const kid = await login(base, "boy", "kid");
    const claim = await fetch(`${base}/api/rewards/${home.unclaimed[0].id}/claim`, { method: "POST", headers: { cookie: kid.cookie } });
    const claimBody = await claim.json();
    assert.equal(claim.status, 200);
    assert.equal(claimBody.newBalance, 3);
    assert.equal(claimBody.cards.length, 1);
    const again = await fetch(`${base}/api/rewards/${home.unclaimed[0].id}/claim`, { method: "POST", headers: { cookie: kid.cookie } });
    assert.equal(again.status, 400);
  } finally {
    server.close();
  }
});

test("连续完成周一到周三，周三奖励变成 4，事后补前两天会补差额", async () => {
  const { service, clock } = boot("2026-10-28T02:00:00.000Z");
  const parentId = service.users().find((user) => user.username === "parent")!.id as number;
  const boy = service.adminToday().find((child) => child.username === "boy")!;
  service.completeTask(parentId, boy.tasks.find((task) => task.code === "school_hw")!.id);
  assert.equal(service.kidHome(boy.id).unclaimed.find((item) => item.title.includes("学校"))!.amount, 3);

  clock.current = new Date("2026-10-26T02:00:00.000Z");
  service.ensureCurrentWeeks();
  const monday = service.adminToday().find((child) => child.username === "boy")!.tasks.find((task) => task.code === "school_hw")!;
  service.completeTask(parentId, monday.id);
  clock.current = new Date("2026-10-27T02:00:00.000Z");
  service.ensureCurrentWeeks();
  const tuesday = service.adminToday().find((child) => child.username === "boy")!.tasks.find((task) => task.code === "school_hw")!;
  service.completeTask(parentId, tuesday.id);

  clock.current = new Date("2026-10-28T02:00:00.000Z");
  const amounts = service.kidHome(boy.id).unclaimed.map((item) => item.amount).sort((a, b) => a - b);
  assert.deepEqual(amounts, [3, 3, 4]);
});

test("超过 19:30 的学校作业不发奖励，厚海晚上完成仍然算达标", async () => {
  const { service, clock } = boot("2026-10-29T12:30:00.000Z");
  service.ensureCurrentWeeks();
  const parentId = service.users().find((user) => user.username === "parent")!.id as number;
  const boy = service.adminToday().find((child) => child.username === "boy")!;
  const school = service.completeTask(parentId, boy.tasks.find((task) => task.code === "school_hw")!.id);
  const houhai = service.completeTask(parentId, boy.tasks.find((task) => task.code === "houhai_hw")!.id);
  assert.equal(school.qualified, false);
  assert.equal(school.rewardAmount, 0);
  assert.equal(houhai.qualified, true);
  assert.equal(houhai.rewardAmount, 2);
  void clock;
});

test("周五到周日的学校作业只有一条，截止前完成奖励含周五加成", async () => {
  const { service, clock } = boot("2026-10-26T02:00:00.000Z");
  const parentId = service.users().find((user) => user.username === "parent")!.id as number;
  for (const day of ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]) {
    clock.current = new Date(`${day}T02:00:00.000Z`);
    service.ensureCurrentWeeks();
    const school = service.adminToday().find((child) => child.username === "boy")!.tasks.find((task) => task.code === "school_hw")!;
    service.completeTask(parentId, school.id);
  }
  clock.current = new Date("2026-10-30T02:00:00.000Z");
  service.ensureCurrentWeeks();
  const friday = service.adminToday().find((child) => child.username === "boy")!.tasks.find((task) => task.code === "school_hw")!;
  assert.equal(friday.periodStart, "2026-10-30");
  assert.equal(friday.periodEnd, "2026-11-01");
  const done = service.completeTask(parentId, friday.id);
  assert.equal(done.qualified, true);
  assert.equal(done.rewardAmount, 5);
  clock.current = new Date("2026-10-31T02:00:00.000Z");
  const saturday = service.adminToday().find((child) => child.username === "boy")!.tasks.find((task) => task.code === "school_hw")!;
  assert.equal(saturday.id, friday.id);
  assert.equal(saturday.status, "done");
});

test("游泳 20:00 自动发放，标记没去会扣回，余额可以为负", async () => {
  const { service, clock } = boot("2026-10-26T12:00:00.000Z");
  service.ensureCurrentWeeks();
  service.runJobs();
  const boy = service.users().find((user) => user.username === "boy")!;
  const home = service.kidHome(boy.id as number);
  const swimReward = home.unclaimed.find((item) => item.title.includes("游泳"));
  assert.equal(swimReward?.amount, 2);
  service.claim(boy.id as number, swimReward!.id);
  assert.equal(service.ledger(boy.id as number).balance, 2);
  const swim = service.adminToday().find((child) => child.username === "boy")!.tasks.find((task) => task.code === "swim")!;
  const parentId = service.users().find((user) => user.username === "parent")!.id as number;
  service.skipSwim(parentId, swim.id);
  assert.equal(service.ledger(boy.id as number).balance, 0);
  service.otherEntry(parentId, { childIds: [boy.id as number], kind: "expense", title: "买零食", amount: 5 });
  assert.equal(service.ledger(boy.id as number).balance, -5);
  const notices = service.kidHome(boy.id as number).notices;
  assert.match(notices[0].text, /买零食/);
  void clock;
});

test("视频第二遍免费，第三遍按新的序号计价，超 10 分钟加 1", async () => {
  const { service, server, dataDir } = boot();
  const base = await listen(server);
  try {
    const parentId = service.users().find((user) => user.username === "parent")!.id as number;
    const boy = service.users().find((user) => user.username === "boy")!;
    service.otherEntry(parentId, { childIds: [boy.id as number], kind: "income", title: "起步资金", amount: 30 });
    const income = service.kidHome(boy.id as number).unclaimed[0];
    service.claim(boy.id as number, income.id);
    const file = path.join(dataDir, "demo.mp4");
    writeFileSync(file, Buffer.from("demo-video"));
    const short = service.saveUpload(parentId, "短片.mp4", file, 30);
    const long = service.saveUpload(parentId, "长片.mp4", file, 601);
    service.markVideo(short.id, { published: true });
    service.markVideo(long.id, { published: true });

    const first = service.quoteVideo(boy.id as number, short.id);
    assert.equal(first.price, 2);
    const play1 = service.startPlay(boy.id as number, short.id, 2, "k1");
    assert.equal("price" in play1 && play1.price, 2);
    service.endWatch(boy.id as number, play1.watchId!, "finished", 30);
    const second = service.quoteVideo(boy.id as number, short.id);
    assert.equal(second.freeReplay, true);
    const play2 = service.startPlay(boy.id as number, short.id, 0, "k2");
    assert.equal("price" in play2 && play2.price, 0);
    service.endWatch(boy.id as number, play2.watchId!, "finished", 30);
    const third = service.quoteVideo(boy.id as number, short.id);
    assert.equal(third.freeReplay, false);
    assert.equal(third.dailyIndex, 2);
    assert.equal(third.price, 3);
    service.startPlay(boy.id as number, short.id, 3, "k3");
    const longQuote = service.quoteVideo(boy.id as number, long.id);
    assert.equal(longQuote.dailyIndex, 3);
    assert.equal(longQuote.price, 5);
    const kid = await login(base, "boy", "kid");
    const blocked = await fetch(`${base}/media/videos/${short.id}`, { headers: { cookie: kid.cookie } });
    assert.equal(blocked.status, 401);
  } finally {
    server.close();
  }
});

test("一周全部达标时，完成最后一个任务的奖励抽 2 张卡", async () => {
  const { service, clock } = boot("2026-10-26T02:00:00.000Z");
  const parentId = service.users().find((user) => user.username === "parent")!.id as number;
  const boyId = service.users().find((user) => user.username === "boy")!.id as number;
  for (const day of ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]) {
    clock.current = new Date(`${day}T02:00:00.000Z`);
    service.ensureCurrentWeeks();
    const tasks = service.adminToday().find((child) => child.id === boyId)!.tasks;
    for (const task of tasks) {
      if (task.code === "swim" || task.status !== "pending") continue;
      service.completeTask(parentId, task.id);
    }
  }
  clock.current = new Date("2026-10-26T12:00:00.000Z");
  service.runJobs();
  clock.current = new Date("2026-10-29T12:00:00.000Z");
  service.runJobs();
  const draws = service.kidHome(boyId).unclaimed.map((item) => item.cardDraws);
  assert.ok(draws.includes(2), `应有一次抽 2 张，实际 ${draws.join(",")}`);
});
