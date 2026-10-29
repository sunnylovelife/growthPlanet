import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ECONOMY,
  activePeriod,
  addDays,
  drawCard,
  extractDouyin,
  streakBonus,
  videoPrice,
  weekPeriodSpecs,
  weekStart,
  weekday,
} from "../src/domain.ts";

test("2026-10-28 是周三，周一开始于 10-26", () => {
  assert.equal(weekday("2026-10-28"), 3);
  assert.equal(weekStart("2026-10-28"), "2026-10-26");
});

test("学校作业周五到周日合并，截止周日 19:30", () => {
  const fri = activePeriod("school_hw", "2026-10-30", DEFAULT_ECONOMY);
  const sat = activePeriod("school_hw", "2026-10-31", DEFAULT_ECONOMY);
  assert.equal(fri?.periodStart, "2026-10-30");
  assert.equal(fri?.periodEnd, "2026-11-01");
  assert.equal(fri?.deadlineAt, "2026-11-01T19:30:00+08:00");
  assert.equal(sat?.periodStart, fri?.periodStart);
});

test("厚海每天一个周期且没有截止时间", () => {
  const sat = activePeriod("houhai_hw", "2026-10-31", DEFAULT_ECONOMY);
  assert.equal(sat?.periodStart, "2026-10-31");
  assert.equal(sat?.deadlineAt, null);
});

test("游泳只在周一和周四", () => {
  assert.equal(activePeriod("swim", "2026-10-26", DEFAULT_ECONOMY)?.periodStart, "2026-10-26");
  assert.equal(activePeriod("swim", "2026-10-28", DEFAULT_ECONOMY), null);
  assert.equal(activePeriod("swim", "2026-10-29", DEFAULT_ECONOMY)?.periodStart, "2026-10-29");
});

test("一周必做周期去重后是 14 个", () => {
  const specs = weekPeriodSpecs("2026-10-26", DEFAULT_ECONOMY);
  assert.equal(specs.length, 14);
  assert.equal(specs.filter((item) => item.task === "school_hw").length, 5);
  assert.equal(specs.filter((item) => item.task === "houhai_hw").length, 7);
  assert.equal(specs.filter((item) => item.task === "swim").length, 2);
});

test("连续加成：周三 +1，周五起 +2，前面断了则为 0", () => {
  assert.equal(streakBonus("school_hw", "2026-10-26", true, DEFAULT_ECONOMY), 0);
  assert.equal(streakBonus("school_hw", "2026-10-27", true, DEFAULT_ECONOMY), 0);
  assert.equal(streakBonus("school_hw", "2026-10-28", true, DEFAULT_ECONOMY), 1);
  assert.equal(streakBonus("school_hw", "2026-10-28", false, DEFAULT_ECONOMY), 0);
  assert.equal(streakBonus("school_hw", "2026-10-30", true, DEFAULT_ECONOMY), 2);
  assert.equal(streakBonus("houhai_hw", "2026-11-01", true, DEFAULT_ECONOMY), 2);
  assert.equal(streakBonus("swim", "2026-10-29", true, DEFAULT_ECONOMY), 0);
});

test("视频计价逐个递增，超过 10 分钟加 1，第二天的序号由调用方重置", () => {
  const pricing = DEFAULT_ECONOMY.video;
  assert.equal(videoPrice(1, 60, pricing), 2);
  assert.equal(videoPrice(2, 60, pricing), 3);
  assert.equal(videoPrice(3, 60, pricing), 4);
  assert.equal(videoPrice(1, 601, pricing), 3);
  assert.equal(videoPrice(3, 600, pricing), 4);
});

test("能从抖音分享文案里抽出链接和标题", () => {
  const text = "1.53 复制打开抖音，看看【孩子的一棠课的作品】《王戎不取道旁李》 流传了一千五百年 https://v.douyin.com/z735N6lkOeM/ 12/17 odN:/ :5pm q@E.ho";
  const parsed = extractDouyin(text);
  assert.equal(parsed.url, "https://v.douyin.com/z735N6lkOeM/");
  assert.equal(parsed.title, "王戎不取道旁李");
  assert.equal(parsed.author, "孩子的一棠课的作品");
});

test("连续 8 次没出稀有时，下一次至少是稀有", () => {
  const alwaysCommon = () => 0;
  const forced = drawCard(7, alwaysCommon, 8);
  assert.notEqual(forced.card.rarity, "common");
  assert.equal(forced.nextPity, 0);
  const normal = drawCard(0, alwaysCommon, 8);
  assert.equal(normal.card.rarity, "common");
  assert.equal(normal.nextPity, 1);
});

test("addDays 可以跨月", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
});
