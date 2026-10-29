export type TaskCode = "school_hw" | "houhai_hw" | "swim" | "vocab";

export interface Economy {
  schoolBase: number;
  houhaiBase: number;
  swimBase: number;
  schoolDeadline: string;
  swimAuto: string;
  streakWed: number;
  streakFri: number;
  swimDays: number[];
  video: VideoPricing;
}

export interface VideoPricing {
  base: number;
  step: number;
  longThresholdSeconds: number;
  longExtra: number;
}

export const DEFAULT_ECONOMY: Economy = {
  schoolBase: 3,
  houhaiBase: 2,
  swimBase: 2,
  schoolDeadline: "19:30",
  swimAuto: "20:00",
  streakWed: 1,
  streakFri: 2,
  swimDays: [1, 4],
  video: { base: 2, step: 1, longThresholdSeconds: 600, longExtra: 1 },
};

export interface PeriodSpec {
  task: Exclude<TaskCode, "vocab">;
  periodStart: string;
  periodEnd: string;
  weekStart: string;
  deadlineAt: string | null;
}

export interface Outfit {
  id: string;
  name: string;
  tagline: string;
  mascot: string;
}

export const OUTFITS: Outfit[] = [
  { id: "rocket", name: "火箭少年", tagline: "点火，冲出大气层", mascot: "🚀" },
  { id: "magic", name: "星光少女", tagline: "星光为你亮起来", mascot: "✨" },
];

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface CardDef {
  id: string;
  series: string;
  name: string;
  rarity: Rarity;
  weight: number;
  emoji: string;
  blurb: string;
}

export const CARDS: CardDef[] = [
  { id: "mercury", series: "星球", name: "水星信使", rarity: "common", weight: 10, emoji: "☿️", blurb: "跑得最快的小信使" },
  { id: "venus", series: "星球", name: "金星花环", rarity: "common", weight: 10, emoji: "🌸", blurb: "把晚霞戴在头上" },
  { id: "earth", series: "星球", name: "地球守护", rarity: "rare", weight: 6, emoji: "🌍", blurb: "家里这颗蓝色星球" },
  { id: "mars", series: "星球", name: "火星小火山", rarity: "epic", weight: 3, emoji: "🌋", blurb: "脾气热，心很暖" },
  { id: "whale", series: "星空伙伴", name: "星鲸", rarity: "common", weight: 10, emoji: "🐋", blurb: "在银河里慢慢游" },
  { id: "rabbit", series: "星空伙伴", name: "云兔", rarity: "common", weight: 10, emoji: "🐰", blurb: "踩着云朵值夜班" },
  { id: "fox", series: "星空伙伴", name: "月狐", rarity: "rare", weight: 6, emoji: "🦊", blurb: "月亮底下的小向导" },
  { id: "cat", series: "星空伙伴", name: "彗星猫", rarity: "epic", weight: 3, emoji: "🐱", blurb: "尾巴是一道彗星" },
  { id: "kid", series: "宇宙英雄", name: "光速小孩", rarity: "rare", weight: 6, emoji: "🧒", blurb: "作业写完就能加速" },
  { id: "captain", series: "宇宙英雄", name: "星图船长", rarity: "epic", weight: 3, emoji: "🧭", blurb: "不会迷路的船长" },
  { id: "knight", series: "宇宙英雄", name: "流星骑士", rarity: "legendary", weight: 1, emoji: "🛡️", blurb: "一闪而过，刚好赶上" },
  { id: "gardener", series: "宇宙英雄", name: "银河园丁", rarity: "legendary", weight: 1, emoji: "🌱", blurb: "给星星浇水的人" },
];

const RARITY_WEIGHT: Record<Rarity, number> = { common: 70, rare: 22, epic: 7, legendary: 1 };
const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function weekday(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function weekStart(dateKey: string): string {
  return addDays(dateKey, 1 - weekday(dateKey));
}

export function shanghaiParts(date: Date) {
  const s = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    y: s.getUTCFullYear(),
    m: s.getUTCMonth() + 1,
    d: s.getUTCDate(),
    hh: s.getUTCHours(),
    mm: s.getUTCMinutes(),
    ss: s.getUTCSeconds(),
  };
}

export function dateKeyOf(date: Date): string {
  const p = shanghaiParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function toShanghaiIso(date: Date): string {
  const p = shanghaiParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}+08:00`;
}

export function atShanghai(dateKey: string, hhmm: string): string {
  const [hh, mm] = hhmm.split(":");
  return `${dateKey}T${pad(Number(hh))}:${pad(Number(mm))}:00+08:00`;
}

export function activePeriod(task: Exclude<TaskCode, "vocab">, dateKey: string, economy: Economy): PeriodSpec | null {
  const wd = weekday(dateKey);
  const ws = weekStart(dateKey);
  if (task === "school_hw") {
    if (wd <= 4) {
      return { task, periodStart: dateKey, periodEnd: dateKey, weekStart: ws, deadlineAt: atShanghai(dateKey, economy.schoolDeadline) };
    }
    const fri = addDays(dateKey, 5 - wd);
    const sun = addDays(fri, 2);
    return { task, periodStart: fri, periodEnd: sun, weekStart: ws, deadlineAt: atShanghai(sun, economy.schoolDeadline) };
  }
  if (task === "houhai_hw") {
    return { task, periodStart: dateKey, periodEnd: dateKey, weekStart: ws, deadlineAt: null };
  }
  if (!economy.swimDays.includes(wd)) return null;
  return { task, periodStart: dateKey, periodEnd: dateKey, weekStart: ws, deadlineAt: null };
}

export function weekPeriodSpecs(weekStartKey: string, economy: Economy): PeriodSpec[] {
  const seen = new Set<string>();
  const out: PeriodSpec[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStartKey, i);
    for (const task of ["school_hw", "houhai_hw", "swim"] as const) {
      const spec = activePeriod(task, day, economy);
      if (!spec) continue;
      const key = `${spec.task}|${spec.periodStart}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(spec);
    }
  }
  return out;
}

export function baseReward(task: Exclude<TaskCode, "vocab">, economy: Economy): number {
  if (task === "school_hw") return economy.schoolBase;
  if (task === "houhai_hw") return economy.houhaiBase;
  return economy.swimBase;
}

export function streakBonus(task: Exclude<TaskCode, "vocab">, periodStart: string, earlierAllQualified: boolean, economy: Economy): number {
  if (task === "swim" || !earlierAllQualified) return 0;
  const wd = weekday(periodStart);
  if (wd >= 5) return economy.streakFri;
  if (wd >= 3) return economy.streakWed;
  return 0;
}

export function videoPrice(dailyIndex: number, durationSeconds: number, pricing: VideoPricing): number {
  const base = pricing.base + (dailyIndex - 1) * pricing.step;
  const extra = durationSeconds > pricing.longThresholdSeconds ? pricing.longExtra : 0;
  return base + extra;
}

export function extractDouyin(text: string): { url?: string; title?: string; author?: string } {
  const url = text.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/)?.[0];
  const title = text.match(/《([^》]+)》/)?.[1];
  const author = text.match(/【([^】]+)】/)?.[1];
  return { url, title, author };
}

export function pickWeighted<T>(items: T[], weight: (item: T) => number, rand: () => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let cursor = rand() * total;
  for (const item of items) {
    cursor -= weight(item);
    if (cursor <= 0) return item;
  }
  return items[items.length - 1];
}

export function drawCard(pityCounter: number, rand: () => number, pityMax = 8): { card: CardDef; nextPity: number } {
  let rarities = (Object.keys(RARITY_WEIGHT) as Rarity[]).map((rarity) => ({ rarity, weight: RARITY_WEIGHT[rarity] }));
  if (pityCounter + 1 >= pityMax) rarities = rarities.filter((item) => item.rarity !== "common");
  const rarity = pickWeighted(rarities, (item) => item.weight, rand).rarity;
  const pool = CARDS.filter((card) => card.rarity === rarity);
  const card = pickWeighted(pool, (item) => item.weight, rand);
  const nextPity = RARITY_RANK[card.rarity] >= RARITY_RANK.rare ? 0 : pityCounter + 1;
  return { card, nextPity };
}

export function taskLabel(task: TaskCode): string {
  if (task === "school_hw") return "学校作业";
  if (task === "houhai_hw") return "厚海英语";
  if (task === "swim") return "游泳";
  return "背单词";
}

export function rarityLabel(rarity: Rarity): string {
  if (rarity === "common") return "普通";
  if (rarity === "rare") return "稀有";
  if (rarity === "epic") return "史诗";
  return "传说";
}
