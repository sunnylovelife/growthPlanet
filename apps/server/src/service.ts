import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  CARDS,
  DEFAULT_ECONOMY,
  OUTFITS,
  type Economy,
  type TaskCode,
  activePeriod,
  addDays,
  atShanghai,
  baseReward,
  dateKeyOf,
  drawCard,
  extractDouyin,
  streakBonus,
  taskLabel,
  toShanghaiIso,
  videoPrice,
  weekPeriodSpecs,
  weekStart,
  weekday,
} from "../../../packages/shared/src/domain.ts";
import { many, one, run, tx } from "./db.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Clock {
  now(): Date;
}

interface TaskRow {
  id: number;
  child_id: number;
  task_code: Exclude<TaskCode, "vocab">;
  period_start: string;
  period_end: string;
  week_start: string;
  deadline_at: string | null;
  status: string;
  completed_at: string | null;
  completed_via: string | null;
  confirmed_by: number | null;
  photo_path: string | null;
  photo_hash: string | null;
  qualified: number | null;
  base_reward: number | null;
  streak_bonus: number | null;
  reward_amount: number | null;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: "parent" | "child";
  display_role: string | null;
  status: string;
  failed_login_count: number;
  locked_until: string | null;
}

interface ClaimRow {
  id: number;
  child_id: number;
  source_type: string;
  source_id: string;
  amount: number;
  title: string;
  card_draws: number;
  breakdown_json: string | null;
  perfect_week: number;
  week_start: string | null;
  status: string;
}

const TASKS = ["school_hw", "houhai_hw", "swim"] as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const got = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const ACCOUNT_FAIL_LIMIT = 5;
const IP_FAIL_LIMIT = 20;

export function createService(db: DatabaseSync, clock: Clock, dataDir: string) {
  function nowIso() {
    return toShanghaiIso(clock.now());
  }

  // 失败次数按"IP + 账号"计，外人猜密码锁不住家里 iPad 上的账号
  const loginFailures = new Map<string, number[]>();

  function recentFailures(key: string): number {
    const now = clock.now().getTime();
    const list = (loginFailures.get(key) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
    if (list.length) loginFailures.set(key, list);
    else loginFailures.delete(key);
    return list.length;
  }

  function recordFailure(key: string) {
    if (loginFailures.size > 5000) for (const stale of [...loginFailures.keys()]) recentFailures(stale);
    loginFailures.set(key, [...(loginFailures.get(key) ?? []), clock.now().getTime()]);
  }

  function economy(): Economy {
    const row = one<{ value_json: string }>(db, "SELECT value_json FROM setting WHERE key = 'economy'");
    if (!row) return structuredClone(DEFAULT_ECONOMY);
    const parsed = JSON.parse(row.value_json) as Partial<Economy>;
    return { ...DEFAULT_ECONOMY, ...parsed, video: { ...DEFAULT_ECONOMY.video, ...(parsed.video ?? {}) } };
  }

  function logAction(parentId: number, action: string, targetType: string, targetId: string, detail: unknown) {
    run(db, "INSERT INTO parent_action_log (parent_id, action, target_type, target_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", parentId, action, targetType, targetId, JSON.stringify(detail), nowIso());
  }

  function logEvent(userId: number | null, type: string, props: unknown, source = "server") {
    run(db, "INSERT INTO event_log (user_id, type, props_json, source, server_ts) VALUES (?, ?, ?, ?, ?)", userId, type, JSON.stringify(props ?? {}), source, nowIso());
  }

  function balanceOf(childId: number): number {
    return one<{ b: number }>(db, "SELECT balance_after AS b FROM ledger_entry WHERE child_id = ? ORDER BY id DESC LIMIT 1", childId)?.b ?? 0;
  }

  function applyLedger(input: { childId: number; amount: number; type: string; title: string; refType?: string; refId?: string; createdBy?: number; idempotencyKey?: string }) {
    if (input.idempotencyKey) {
      const existing = one<{ id: number }>(db, "SELECT id FROM ledger_entry WHERE idempotency_key = ?", input.idempotencyKey);
      if (existing) return existing.id;
    }
    const next = balanceOf(input.childId) + input.amount;
    return run(db, `INSERT INTO ledger_entry (child_id, amount, balance_after, type, ref_type, ref_id, title, created_by, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.childId, input.amount, next, input.type, input.refType ?? null, input.refId ?? null, input.title, input.createdBy ?? null, input.idempotencyKey ?? null, nowIso()).id;
  }

  function children() {
    return many<{ id: number; username: string; display_role: string; nickname: string; outfit_id: string; status: string }>(db, `
      SELECT u.id, u.username, u.display_role, u.status, p.nickname, p.outfit_id
      FROM user u JOIN child_profile p ON p.user_id = u.id
      WHERE u.role = 'child' ORDER BY u.id`);
  }

  function ensureWeek(childId: number, week: string) {
    const eco = economy();
    for (const spec of weekPeriodSpecs(week, eco)) {
      run(db, `INSERT OR IGNORE INTO task_instance
        (child_id, task_code, period_start, period_end, week_start, deadline_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')`, childId, spec.task, spec.periodStart, spec.periodEnd, spec.weekStart, spec.deadlineAt);
    }
  }

  function ensureCurrentWeeks() {
    const key = dateKeyOf(clock.now());
    const week = weekStart(key);
    for (const child of children()) ensureWeek(child.id, week);
  }

  function taskById(id: number): TaskRow {
    const row = one<TaskRow>(db, "SELECT * FROM task_instance WHERE id = ?", id);
    if (!row) throw new HttpError(404, "任务不存在");
    return row;
  }

  function earlierAllQualified(period: TaskRow): boolean {
    const rows = many<TaskRow>(db, `SELECT * FROM task_instance
      WHERE child_id = ? AND task_code = ? AND week_start = ? AND period_start < ?
      ORDER BY period_start`, period.child_id, period.task_code, period.week_start, period.period_start);
    return rows.every((row) => row.qualified === 1);
  }

  function weekIsPerfect(childId: number, week: string): boolean {
    const eco = economy();
    for (const spec of weekPeriodSpecs(week, eco)) {
      const row = one<TaskRow>(db, "SELECT * FROM task_instance WHERE child_id = ? AND task_code = ? AND period_start = ?", childId, spec.task, spec.periodStart);
      if (!row || row.qualified !== 1) return false;
    }
    return true;
  }

  function paidForTask(periodId: number): number {
    return one<{ s: number }>(db, "SELECT COALESCE(SUM(amount), 0) AS s FROM ledger_entry WHERE ref_type = 'task' AND ref_id = ?", String(periodId))?.s ?? 0;
  }

  function unclaimedForTask(periodId: number): ClaimRow[] {
    return many<ClaimRow>(db, "SELECT * FROM reward_claim WHERE status = 'unclaimed' AND source_id LIKE ? ORDER BY id", `task:${periodId}:%`);
  }

  function syncPeriodReward(periodId: number, grantCards: boolean) {
    const period = taskById(periodId);
    const eco = economy();
    const qualified = period.qualified === 1;
    const base = qualified ? baseReward(period.task_code, eco) : 0;
    const bonus = qualified ? streakBonus(period.task_code, period.period_start, earlierAllQualified(period), eco) : 0;
    const total = base + bonus;
    run(db, "UPDATE task_instance SET base_reward = ?, streak_bonus = ?, reward_amount = ? WHERE id = ?", base, bonus, total, period.id);
    const paid = paidForTask(period.id);
    const unclaimed = unclaimedForTask(period.id);
    const promised = unclaimed.reduce((sum, claim) => sum + claim.amount, 0);
    let delta = total - paid - promised;
    if (delta > 0) {
      if (unclaimed[0]) {
        run(db, "UPDATE reward_claim SET amount = amount + ?, breakdown_json = ? WHERE id = ?", delta, JSON.stringify({ base, streakBonus: bonus }), unclaimed[0].id);
      } else {
        const perfect = grantCards && weekIsPerfect(period.child_id, period.week_start)
          && !one(db, "SELECT id FROM reward_claim WHERE child_id = ? AND week_start = ? AND perfect_week = 1", period.child_id, period.week_start);
        const draws = grantCards ? (perfect ? 2 : 1) : 0;
        run(db, `INSERT INTO reward_claim (child_id, source_type, source_id, amount, title, card_draws, breakdown_json, perfect_week, week_start, status, created_at)
          VALUES (?, 'task', ?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?)`,
          period.child_id, `task:${period.id}:${total}:${randomBytes(3).toString("hex")}`, delta, `${taskLabel(period.task_code)}奖励`, draws,
          JSON.stringify({ base, streakBonus: bonus }), perfect ? 1 : 0, period.week_start, nowIso());
      }
    } else if (delta < 0) {
      let left = -delta;
      for (const claim of unclaimed) {
        if (left <= 0) break;
        const cut = Math.min(claim.amount, left);
        left -= cut;
        if (claim.amount - cut <= 0) run(db, "UPDATE reward_claim SET status = 'revoked', amount = 0 WHERE id = ?", claim.id);
        else run(db, "UPDATE reward_claim SET amount = ? WHERE id = ?", claim.amount - cut, claim.id);
      }
      if (left > 0) {
        applyLedger({ childId: period.child_id, amount: -left, type: "reversal", title: `${taskLabel(period.task_code)}奖励调整`, refType: "task", refId: String(period.id) });
      }
    }
    return { base, bonus, total };
  }

  function resyncWeek(childId: number, taskCode: string, week: string) {
    const rows = many<TaskRow>(db, `SELECT * FROM task_instance WHERE child_id = ? AND task_code = ? AND week_start = ? AND qualified = 1 ORDER BY period_start`, childId, taskCode, week);
    for (const row of rows) syncPeriodReward(row.id, true);
  }

  function finishTask(periodId: number, input: { completedAt: string; via: string; parentId: number | null }) {
    const period = taskById(periodId);
    if (period.status === "done" || period.status === "skipped") throw new HttpError(400, "这个任务已经处理过了");
    const qualified = period.deadline_at ? input.completedAt <= period.deadline_at : true;
    run(db, `UPDATE task_instance SET status = 'done', completed_at = ?, completed_via = ?, confirmed_by = ?, qualified = ? WHERE id = ?`,
      input.completedAt, input.via, input.parentId, qualified ? 1 : 0, period.id);
    syncPeriodReward(period.id, qualified);
    resyncWeek(period.child_id, period.task_code, period.week_start);
    logEvent(period.child_id, "task_done", { task: period.task_code, qualified, via: input.via });
    return taskById(period.id);
  }

  function publicTask(row: TaskRow) {
    const eco = economy();
    const qualifiedNow = row.qualified === 1;
    const previewBonus = streakBonus(row.task_code, row.period_start, earlierAllQualified(row), eco);
    const late = Boolean(row.deadline_at && row.status === "pending" && nowIso() > row.deadline_at);
    const preview = late ? 0 : baseReward(row.task_code, eco) + previewBonus;
    return {
      id: row.id,
      code: row.task_code,
      name: taskLabel(row.task_code),
      periodStart: row.period_start,
      periodEnd: row.period_end,
      deadlineAt: row.deadline_at,
      status: row.status,
      qualified: row.qualified === 1 ? true : row.qualified === 0 ? false : null,
      completedAt: row.completed_at,
      completedVia: row.completed_via,
      photoPath: row.photo_path,
      duplicatePhoto: Boolean(row.photo_hash && one(db, "SELECT id FROM task_instance WHERE child_id = ? AND photo_hash = ? AND id != ?", row.child_id, row.photo_hash, row.id)),
      rewardAmount: row.reward_amount ?? 0,
      streakBonus: row.streak_bonus ?? 0,
      previewReward: preview,
      previewStreak: previewBonus,
    };
  }

  function weekView(childId: number, taskCode: string, week: string) {
    const rows = many<TaskRow>(db, "SELECT * FROM task_instance WHERE child_id = ? AND task_code = ? AND week_start = ? ORDER BY period_start", childId, taskCode, week);
    return rows.map((row) => ({
      periodStart: row.period_start,
      label: row.task_code === "school_hw" && weekday(row.period_start) >= 5 ? "周末" : "周" + "一二三四五六日"[weekday(row.period_start) - 1],
      status: row.status,
      qualified: row.qualified === 1,
    }));
  }

  return {
    economy,
    saveEconomy(parentId: number, next: Economy) {
      run(db, "INSERT INTO setting (key, value_json) VALUES ('economy', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", JSON.stringify(next));
      logAction(parentId, "save_economy", "setting", "economy", next);
    },
    seed(initialPassword?: string) {
      if (one(db, "SELECT id FROM user LIMIT 1")) return null;
      const stamp = nowIso();
      const credentials = ["parent", "boy", "girl"].map((username) => ({ username, password: initialPassword || randomBytes(6).toString("base64url") }));
      const [parentPw, boyPw, girlPw] = credentials.map((item) => hashPassword(item.password));
      const parent = run(db, "INSERT INTO user (username, password_hash, role, display_role, status, created_at) VALUES (?, ?, 'parent', '爸爸', 'active', ?)", "parent", parentPw, stamp);
      const boy = run(db, "INSERT INTO user (username, password_hash, role, display_role, status, created_at) VALUES (?, ?, 'child', '儿子', 'active', ?)", "boy", boyPw, stamp);
      const girl = run(db, "INSERT INTO user (username, password_hash, role, display_role, status, created_at) VALUES (?, ?, 'child', '女儿', 'active', ?)", "girl", girlPw, stamp);
      run(db, "INSERT INTO child_profile (user_id, nickname, outfit_id) VALUES (?, '小宇', 'rocket')", boy.id);
      run(db, "INSERT INTO child_profile (user_id, nickname, outfit_id) VALUES (?, '小星', 'magic')", girl.id);
      run(db, "INSERT INTO setting (key, value_json) VALUES ('economy', ?)", JSON.stringify(DEFAULT_ECONOMY));
      run(db, "INSERT INTO pity (child_id, counter) VALUES (?, 0)", boy.id);
      run(db, "INSERT INTO pity (child_id, counter) VALUES (?, 0)", girl.id);
      logEvent(parent.id, "seed", { parent: parent.id });
      return credentials;
    },
    ensureCurrentWeeks,
    login(username: string, password: string, portal: "kid" | "admin", meta: { ip?: string; device?: string }) {
      const name = username.trim();
      const ip = meta.ip || "unknown";
      const ipKey = `ip:${ip}`;
      const accountKey = `account:${ip}:${name}`;
      if (recentFailures(ipKey) >= IP_FAIL_LIMIT) throw new HttpError(429, "尝试太频繁，请 10 分钟后再试");
      if (recentFailures(accountKey) >= ACCOUNT_FAIL_LIMIT) throw new HttpError(423, "密码错太多次，请 10 分钟后再试");
      const user = one<UserRow>(db, "SELECT * FROM user WHERE username = ?", name);
      const stamp = nowIso();
      const ok = Boolean(user && user.status === "active" && verifyPassword(password, user.password_hash));
      run(db, "INSERT INTO login_log (username, user_id, success, ip, device, created_at) VALUES (?, ?, ?, ?, ?, ?)", name, user?.id ?? null, ok ? 1 : 0, meta.ip ?? null, meta.device ?? null, stamp);
      if (!user || !ok) {
        recordFailure(ipKey);
        recordFailure(accountKey);
        throw new HttpError(401, "用户名或密码不对");
      }
      if (portal === "admin" && user.role !== "parent") throw new HttpError(403, "孩子账号不能进家长后台");
      if (portal === "kid" && user.role !== "child") throw new HttpError(403, "请用孩子账号登录");
      loginFailures.delete(accountKey);
      const token = randomBytes(24).toString("hex");
      const expires = toShanghaiIso(new Date(clock.now().getTime() + 30 * 24 * 3600 * 1000));
      run(db, "INSERT INTO session (token, user_id, created_at, expires_at, device, ip) VALUES (?, ?, ?, ?, ?, ?)", token, user.id, stamp, expires, meta.device ?? null, meta.ip ?? null);
      logEvent(user.id, "login", { portal });
      return { token, user: this.publicUser(user.id) };
    },
    logout(token: string) {
      run(db, "DELETE FROM session WHERE token = ?", token);
    },
    userByToken(token: string | undefined) {
      if (!token) return null;
      const row = one<{ user_id: number; expires_at: string }>(db, "SELECT user_id, expires_at FROM session WHERE token = ?", token);
      if (!row || row.expires_at <= nowIso()) return null;
      return this.publicUser(row.user_id);
    },
    publicUser(id: number) {
      const user = one<UserRow>(db, "SELECT * FROM user WHERE id = ?", id);
      if (!user) throw new HttpError(401, "请先登录");
      const profile = one<{ nickname: string; outfit_id: string }>(db, "SELECT nickname, outfit_id FROM child_profile WHERE user_id = ?", id);
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        displayRole: user.display_role,
        nickname: profile?.nickname ?? user.display_role,
        outfitId: profile?.outfit_id ?? null,
        balance: user.role === "child" ? balanceOf(user.id) : null,
      };
    },
    kidHome(childId: number) {
      ensureCurrentWeeks();
      const key = dateKeyOf(clock.now());
      const week = weekStart(key);
      const tasks = many<TaskRow>(db, "SELECT * FROM task_instance WHERE child_id = ? AND week_start = ? ORDER BY period_start, task_code", childId, week)
        .filter((row) => row.period_start <= key && row.period_end >= key);
      const unclaimed = many<ClaimRow>(db, "SELECT * FROM reward_claim WHERE child_id = ? AND status = 'unclaimed' AND amount > 0 ORDER BY id", childId);
      const notices = many<{ id: number; text: string }>(db, "SELECT id, text FROM notice WHERE child_id = ? AND read_at IS NULL ORDER BY id", childId);
      return {
        user: this.publicUser(childId),
        date: key,
        tasks: tasks.map(publicTask),
        vocab: { name: "背单词", status: "placeholder", hint: "玩法还在设计，先占个位置" },
        unclaimed: unclaimed.map((claim) => ({ id: claim.id, amount: claim.amount, title: claim.title, cardDraws: claim.card_draws, perfectWeek: claim.perfect_week === 1 })),
        notices,
        outfits: OUTFITS,
      };
    },
    markNoticesRead(childId: number) {
      run(db, "UPDATE notice SET read_at = ? WHERE child_id = ? AND read_at IS NULL", nowIso(), childId);
    },
    updateMe(childId: number, input: { nickname?: string; outfitId?: string }) {
      if (input.nickname) {
        const nickname = input.nickname.trim().slice(0, 12);
        if (!nickname) throw new HttpError(400, "昵称不能为空");
        run(db, "UPDATE child_profile SET nickname = ? WHERE user_id = ?", nickname, childId);
        logEvent(childId, "nickname_change", { nickname });
      }
      if (input.outfitId) {
        if (!OUTFITS.some((item) => item.id === input.outfitId)) throw new HttpError(400, "没有这套装扮");
        run(db, "UPDATE child_profile SET outfit_id = ? WHERE user_id = ?", input.outfitId, childId);
        logEvent(childId, "outfit_change", { outfitId: input.outfitId });
      }
      return this.publicUser(childId);
    },
    submitPhoto(childId: number, taskId: number, photo: Buffer) {
      const period = taskById(taskId);
      if (period.child_id !== childId) throw new HttpError(403, "这不是你的任务");
      if (period.task_code === "swim") throw new HttpError(400, "游泳不用拍照");
      if (period.status !== "pending" && period.status !== "missed") throw new HttpError(400, "这个任务现在不能提交");
      const hash = createHash("sha256").update(photo).digest("hex");
      const duplicate = Boolean(one(db, "SELECT id FROM task_instance WHERE child_id = ? AND photo_hash = ?", childId, hash));
      const dir = path.join(dataDir, "photos");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${period.id}-${Date.now()}.jpg`);
      writeFileSync(file, photo);
      const completedAt = nowIso();
      run(db, `UPDATE task_instance SET status = 'submitted', completed_at = ?, completed_via = 'kid_photo', photo_path = ?, photo_hash = ? WHERE id = ?`, completedAt, file, hash, period.id);
      logEvent(childId, "task_submit_photo", { taskId, duplicate });
      return { task: publicTask(taskById(period.id)), duplicate };
    },
    photoFile(taskId: number) {
      const period = taskById(taskId);
      if (!period.photo_path) throw new HttpError(404, "没有照片");
      return period.photo_path;
    },
    adminToday() {
      ensureCurrentWeeks();
      const key = dateKeyOf(clock.now());
      return children().filter((child) => child.status === "active").map((child) => ({
        ...child,
        balance: balanceOf(child.id),
        tasks: many<TaskRow>(db, "SELECT * FROM task_instance WHERE child_id = ? AND period_start <= ? AND period_end >= ? ORDER BY task_code", child.id, key, key).map(publicTask),
      }));
    },
    completeTask(parentId: number, taskId: number, completedAt?: string) {
      return tx(db, () => {
        const period = taskById(taskId);
        const stamp = completedAt || (period.status === "submitted" && period.completed_at ? period.completed_at : nowIso());
        const done = finishTask(taskId, { completedAt: stamp, via: period.status === "submitted" ? "kid_photo" : "parent_click", parentId });
        logAction(parentId, "complete_task", "task", String(taskId), { completedAt: stamp, qualified: done.qualified === 1 });
        return publicTask(done);
      });
    },
    setDeadline(parentId: number, taskId: number, deadlineAt: string) {
      const period = taskById(taskId);
      if (period.task_code !== "school_hw") throw new HttpError(400, "只有学校作业需要截止时间");
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(deadlineAt)) throw new HttpError(400, "时间格式不对");
      run(db, "UPDATE task_instance SET deadline_at = ? WHERE id = ?", deadlineAt, taskId);
      logAction(parentId, "edit_deadline", "task", String(taskId), { deadlineAt });
      return publicTask(taskById(taskId));
    },
    skipSwim(parentId: number, taskId: number) {
      return tx(db, () => {
        const period = taskById(taskId);
        if (period.task_code !== "swim") throw new HttpError(400, "只有游泳可以标记没去");
        if (period.status === "skipped") return publicTask(period);
        run(db, "UPDATE task_instance SET status = 'skipped', qualified = 0 WHERE id = ?", period.id);
        syncPeriodReward(period.id, false);
        logAction(parentId, "mark_no_swim", "task", String(taskId), {});
        logEvent(period.child_id, "swim_skipped", { taskId });
        return publicTask(taskById(period.id));
      });
    },
    undoTask(parentId: number, taskId: number) {
      return tx(db, () => {
        const period = taskById(taskId);
        const paid = paidForTask(period.id);
        if (paid !== 0) throw new HttpError(400, "奖励已经领取，请用「其他花费」扣回");
        run(db, "DELETE FROM reward_claim WHERE status = 'unclaimed' AND source_id LIKE ?", `task:${period.id}:%`);
        run(db, `UPDATE task_instance SET status = 'pending', completed_at = NULL, completed_via = NULL, confirmed_by = NULL, qualified = NULL, base_reward = NULL, streak_bonus = NULL, reward_amount = NULL WHERE id = ?`, period.id);
        resyncWeek(period.child_id, period.task_code, period.week_start);
        logAction(parentId, "undo_task", "task", String(taskId), {});
        return publicTask(taskById(period.id));
      });
    },
    approvals() {
      return many<TaskRow>(db, "SELECT * FROM task_instance WHERE status = 'submitted' ORDER BY completed_at").map((row) => ({
        ...publicTask(row),
        child: this.publicUser(row.child_id),
      }));
    },
    claim(childId: number, claimId: number) {
      return tx(db, () => {
        const claim = one<ClaimRow>(db, "SELECT * FROM reward_claim WHERE id = ? AND child_id = ?", claimId, childId);
        if (!claim || claim.status !== "unclaimed") throw new HttpError(400, "这份奖励已经领过了");
        const changed = run(db, "UPDATE reward_claim SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'unclaimed'", nowIso(), claim.id);
        if (changed.changes !== 1) throw new HttpError(400, "这份奖励已经领过了");
        const periodId = /^task:(\d+):/.exec(claim.source_id)?.[1];
        applyLedger({
          childId,
          amount: claim.amount,
          type: claim.source_type === "task" ? "task_reward" : "other_income",
          title: claim.title,
          refType: periodId ? "task" : "claim",
          refId: periodId ?? String(claim.id),
        });
        const cards = [];
        let pity = one<{ counter: number }>(db, "SELECT counter FROM pity WHERE child_id = ?", childId)?.counter ?? 0;
        for (let i = 0; i < claim.card_draws; i++) {
          const drawn = drawCard(pity, Math.random);
          pity = drawn.nextPity;
          const owned = one(db, "SELECT card_id FROM child_card WHERE child_id = ? AND card_id = ?", childId, drawn.card.id);
          if (owned) run(db, "UPDATE child_card SET count = count + 1 WHERE child_id = ? AND card_id = ?", childId, drawn.card.id);
          else run(db, "INSERT INTO child_card (child_id, card_id, count, first_obtained_at) VALUES (?, ?, 1, ?)", childId, drawn.card.id, nowIso());
          run(db, "INSERT INTO card_draw (child_id, reward_claim_id, card_id, rarity, created_at) VALUES (?, ?, ?, ?, ?)", childId, claim.id, drawn.card.id, drawn.card.rarity, nowIso());
          cards.push({ ...drawn.card, isNew: !owned });
        }
        run(db, "INSERT INTO pity (child_id, counter) VALUES (?, ?) ON CONFLICT(child_id) DO UPDATE SET counter = excluded.counter", childId, pity);
        const profile = this.publicUser(childId);
        const taskCode = periodId ? taskById(Number(periodId)).task_code : null;
        const breakdown = claim.breakdown_json ? JSON.parse(claim.breakdown_json) as { base: number; streakBonus: number } : { base: claim.amount, streakBonus: 0 };
        logEvent(childId, "reward_claim", { claimId, amount: claim.amount, cards: cards.map((card) => card.id) });
        return {
          amount: claim.amount,
          title: claim.title,
          breakdown,
          newBalance: balanceOf(childId),
          week: taskCode ? weekView(childId, taskCode, claim.week_start || weekStart(dateKeyOf(clock.now()))) : [],
          streakLevelUp: breakdown.streakBonus >= economy().streakFri && breakdown.streakBonus > 0 ? "fri" : breakdown.streakBonus > 0 ? "wed" : null,
          perfectWeek: claim.perfect_week === 1,
          cards,
          outfitId: profile.outfitId,
          nickname: profile.nickname,
        };
      });
    },
    album(childId: number) {
      const owned = many<{ card_id: string; count: number }>(db, "SELECT card_id, count FROM child_card WHERE child_id = ?", childId);
      const map = new Map(owned.map((row) => [row.card_id, row.count]));
      const series = [...new Set(CARDS.map((card) => card.series))].map((name) => {
        const cards = CARDS.filter((card) => card.series === name).map((card) => ({ ...card, count: map.get(card.id) ?? 0 }));
        return { name, cards, owned: cards.filter((card) => card.count > 0).length, total: cards.length };
      });
      return { series };
    },
    ledger(childId: number) {
      return {
        balance: balanceOf(childId),
        entries: many(db, "SELECT id, amount, balance_after AS balanceAfter, type, title, created_at AS createdAt FROM ledger_entry WHERE child_id = ? ORDER BY id DESC LIMIT 100", childId),
      };
    },
    otherEntry(parentId: number, input: { childIds: number[]; kind: "income" | "expense"; title: string; amount: number }) {
      const title = input.title.trim().slice(0, 40);
      const amount = Math.round(Number(input.amount));
      if (!title) throw new HttpError(400, "请填写事项");
      if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "金额要是正数");
      if (!input.childIds.length) throw new HttpError(400, "请选择孩子");
      return tx(db, () => {
        const created = [];
        for (const childId of input.childIds) {
          const child = this.publicUser(childId);
          if (child.role !== "child") throw new HttpError(400, "只能记在孩子账上");
          if (input.kind === "income") {
            const id = run(db, `INSERT INTO reward_claim (child_id, source_type, source_id, amount, title, card_draws, breakdown_json, perfect_week, status, created_at)
              VALUES (?, 'other', ?, ?, ?, 1, ?, 0, 'unclaimed', ?)`, childId, `other:${randomBytes(8).toString("hex")}`, amount, title, JSON.stringify({ base: amount, streakBonus: 0 }), nowIso()).id;
            created.push(id);
          } else {
            applyLedger({ childId, amount: -amount, type: "other_expense", title, createdBy: parentId, refType: "parent", refId: String(parentId) });
            run(db, "INSERT INTO notice (child_id, text, created_at) VALUES (?, ?, ?)", childId, `${title} -${amount} 星币`, nowIso());
          }
        }
        logAction(parentId, input.kind === "income" ? "other_income" : "other_expense", "ledger", title, input);
        return { ok: true, created };
      });
    },
    quoteVideo(childId: number, videoId: number) {
      const video = one<{ id: number; duration_seconds: number; published: number; status: string; title: string }>(db, "SELECT * FROM video WHERE id = ?", videoId);
      if (!video || video.status !== "ready" || !video.published) throw new HttpError(404, "视频还不能看");
      const open = one<{ id: number; plays_used: number }>(db, "SELECT * FROM video_purchase WHERE child_id = ? AND video_id = ? AND plays_used < 2 ORDER BY id DESC LIMIT 1", childId, videoId);
      if (open) return { freeReplay: true, price: 0, playNo: open.plays_used + 1, title: video.title, balance: balanceOf(childId) };
      const day = dateKeyOf(clock.now());
      const count = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM video_purchase WHERE child_id = ? AND purchase_date = ?", childId, day)?.n ?? 0;
      const dailyIndex = count + 1;
      const price = videoPrice(dailyIndex, video.duration_seconds, economy().video);
      const long = video.duration_seconds > economy().video.longThresholdSeconds;
      return { freeReplay: false, price, dailyIndex, long, title: video.title, balance: balanceOf(childId), durationSeconds: video.duration_seconds };
    },
    startPlay(childId: number, videoId: number, quotedPrice: number | null, idempotencyKey: string) {
      return tx(db, () => {
        const existing = one<{ token: string; id: number }>(db, "SELECT id, token FROM video_watch WHERE idempotency_key = ?", idempotencyKey);
        if (existing) return { watchId: existing.id, token: existing.token, reused: true };
        const live = one<{ token: string; id: number }>(db, "SELECT id, token FROM video_watch WHERE child_id = ? AND video_id = ? AND ended_at IS NULL AND token_expires_at >= ? ORDER BY id DESC LIMIT 1", childId, videoId, nowIso());
        if (live) return { watchId: live.id, token: live.token, reused: true };
        const video = one<{ id: number; duration_seconds: number; published: number; status: string; file_path: string | null }>(db, "SELECT * FROM video WHERE id = ?", videoId);
        if (!video || video.status !== "ready" || !video.published || !video.file_path) throw new HttpError(404, "视频还不能看");
        const open = one<{ id: number; plays_used: number }>(db, "SELECT * FROM video_purchase WHERE child_id = ? AND video_id = ? AND plays_used < 2 ORDER BY id DESC LIMIT 1", childId, videoId);
        let purchaseId: number;
        let playNo: number;
        let price = 0;
        if (open) {
          run(db, "UPDATE video_purchase SET plays_used = plays_used + 1 WHERE id = ? AND plays_used < 2", open.id);
          purchaseId = open.id;
          playNo = open.plays_used + 1;
        } else {
          const day = dateKeyOf(clock.now());
          const count = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM video_purchase WHERE child_id = ? AND purchase_date = ?", childId, day)?.n ?? 0;
          const dailyIndex = count + 1;
          price = videoPrice(dailyIndex, video.duration_seconds, economy().video);
          if (quotedPrice != null && quotedPrice !== price) return { reprice: true, price, dailyIndex };
          if (balanceOf(childId) < price) throw new HttpError(400, "星币不够，先去完成任务吧");
          const ledgerId = applyLedger({ childId, amount: -price, type: "video_purchase", title: `看视频（今天第 ${dailyIndex} 个）`, refType: "video", refId: String(videoId), idempotencyKey: `video:${idempotencyKey}` });
          purchaseId = run(db, `INSERT INTO video_purchase (child_id, video_id, purchase_date, daily_index, price, plays_used, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?)`, childId, videoId, day, dailyIndex, price, nowIso()).id;
          void ledgerId;
          playNo = 1;
        }
        const token = randomBytes(18).toString("hex");
        const expires = toShanghaiIso(new Date(clock.now().getTime() + 60 * 1000));
        const watchId = run(db, `INSERT INTO video_watch (purchase_id, child_id, video_id, play_no, token, idempotency_key, started_at, token_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, purchaseId, childId, videoId, playNo, token, idempotencyKey, nowIso(), expires).id;
        logEvent(childId, playNo === 1 ? "video_purchase" : "video_replay", { videoId, price, playNo });
        return { watchId, token, price, playNo, balance: balanceOf(childId) };
      });
    },
    heartbeat(childId: number, watchId: number, seconds: number) {
      const watch = one<{ id: number; child_id: number; ended_at: string | null }>(db, "SELECT * FROM video_watch WHERE id = ?", watchId);
      if (!watch || watch.child_id !== childId) throw new HttpError(404, "播放不存在");
      if (watch.ended_at) throw new HttpError(400, "这次播放已经结束");
      const expires = toShanghaiIso(new Date(clock.now().getTime() + 60 * 1000));
      run(db, "UPDATE video_watch SET watched_seconds = ?, last_heartbeat_at = ?, token_expires_at = ? WHERE id = ?", Math.max(0, Math.round(seconds)), nowIso(), expires, watchId);
      return { ok: true };
    },
    endWatch(childId: number, watchId: number, reason: string, seconds: number) {
      const watch = one<{ id: number; child_id: number; video_id: number }>(db, "SELECT * FROM video_watch WHERE id = ?", watchId);
      if (!watch || watch.child_id !== childId) throw new HttpError(404, "播放不存在");
      run(db, "UPDATE video_watch SET ended_at = ?, end_reason = ?, watched_seconds = ?, completed = ? WHERE id = ? AND ended_at IS NULL", nowIso(), reason, Math.round(seconds), reason === "finished" ? 1 : 0, watchId);
      logEvent(childId, "video_end", { watchId, reason, seconds });
      return { ok: true };
    },
    mediaAuth(token: string | undefined) {
      if (!token) throw new HttpError(401, "不能直接打开视频");
      const watch = one<{ video_id: number; token_expires_at: string; ended_at: string | null }>(db, "SELECT * FROM video_watch WHERE token = ?", token);
      if (!watch || watch.ended_at || watch.token_expires_at < nowIso()) throw new HttpError(401, "播放链接已失效");
      const video = one<{ file_path: string | null }>(db, "SELECT file_path FROM video WHERE id = ?", watch.video_id);
      if (!video?.file_path) throw new HttpError(404, "视频文件不存在");
      return video.file_path;
    },
    listVideos(childId?: number) {
      const rows = many<{ id: number; title: string; duration_seconds: number; status: string; error: string | null; published: number; created_at: string; source_url: string | null }>(db, "SELECT id, title, duration_seconds, status, error, published, created_at, source_url FROM video ORDER BY id DESC");
      if (childId == null) return rows;
      return rows.filter((row) => row.published && row.status === "ready").map((row) => ({ ...row, quote: this.quoteVideo(childId, row.id) }));
    },
    addVideoFromShare(parentId: number, shareText: string) {
      const parsed = extractDouyin(shareText);
      if (!parsed.url) throw new HttpError(400, "没有找到抖音链接");
      const id = run(db, `INSERT INTO video (source_url, share_text, title, status, published, created_at) VALUES (?, ?, ?, 'queued', 0, ?)`,
        parsed.url, shareText, parsed.title || parsed.author || "抖音视频", nowIso()).id;
      logAction(parentId, "add_video", "video", String(id), { url: parsed.url });
      return { id, ...parsed };
    },
    markVideo(id: number, patch: { status?: string; error?: string | null; filePath?: string; durationSeconds?: number; title?: string; published?: boolean }) {
      const video = one(db, "SELECT id FROM video WHERE id = ?", id);
      if (!video) throw new HttpError(404, "视频不存在");
      if (patch.status) run(db, "UPDATE video SET status = ?, error = ? WHERE id = ?", patch.status, patch.error ?? null, id);
      if (patch.filePath) run(db, "UPDATE video SET file_path = ?, status = 'ready', error = NULL WHERE id = ?", patch.filePath, id);
      if (patch.durationSeconds != null) run(db, "UPDATE video SET duration_seconds = ? WHERE id = ?", Math.round(patch.durationSeconds), id);
      if (patch.title) run(db, "UPDATE video SET title = ? WHERE id = ?", patch.title.slice(0, 80), id);
      if (patch.published != null) run(db, "UPDATE video SET published = ? WHERE id = ?", patch.published ? 1 : 0, id);
      return one(db, "SELECT * FROM video WHERE id = ?", id);
    },
    deleteVideo(parentId: number, id: number) {
      const video = one<{ file_path: string | null; status: string }>(db, "SELECT file_path, status FROM video WHERE id = ?", id);
      if (video && (video.status === "downloading" || video.status === "processing")) throw new HttpError(400, "视频还在处理，等一会儿再删");
      run(db, "DELETE FROM video WHERE id = ?", id);
      const videosDir = path.resolve(dataDir, "videos") + path.sep;
      if (video?.file_path && path.resolve(video.file_path).startsWith(videosDir)) rmSync(video.file_path, { force: true });
      logAction(parentId, "delete_video", "video", String(id), {});
    },
    unfinishedVideos() {
      return many<{ id: number; status: string; source_url: string | null; file_path: string | null }>(db,
        "SELECT id, status, source_url, file_path FROM video WHERE status IN ('queued', 'downloading', 'processing') ORDER BY id");
    },
    saveUpload(parentId: number, filename: string, filePath: string, durationSeconds: number) {
      const id = run(db, `INSERT INTO video (title, file_path, duration_seconds, status, published, created_at) VALUES (?, ?, ?, 'ready', 0, ?)`,
        filename.replace(/\.[^.]+$/, "").slice(0, 80) || "相册视频", filePath, durationSeconds, nowIso()).id;
      logAction(parentId, "upload_video", "video", String(id), { filename });
      return { id };
    },
    events(filters: { childId?: number; type?: string }) {
      const clauses = ["1=1"];
      const params: unknown[] = [];
      if (filters.childId) { clauses.push("user_id = ?"); params.push(filters.childId); }
      if (filters.type) { clauses.push("type = ?"); params.push(filters.type); }
      return many(db, `SELECT id, user_id AS userId, type, page, props_json AS props, source, client_ts AS clientTs, server_ts AS serverTs
        FROM event_log WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT 200`, ...params);
    },
    recordEvents(userId: number, events: { clientEventId?: string; type: string; page?: string; props?: unknown; clientTs?: string }[]) {
      for (const event of events.slice(0, 50)) {
        if (!event.type) continue;
        try {
          run(db, `INSERT INTO event_log (client_event_id, user_id, type, page, props_json, source, client_ts, server_ts)
            VALUES (?, ?, ?, ?, ?, 'client', ?, ?)`, event.clientEventId ?? null, userId, String(event.type).slice(0, 40), event.page ?? null, JSON.stringify(event.props ?? {}), event.clientTs ?? null, nowIso());
        } catch {
          /* duplicate client event */
        }
      }
    },
    statsToday() {
      ensureCurrentWeeks();
      const key = dateKeyOf(clock.now());
      return children().map((child) => {
        const tasks = many<TaskRow>(db, "SELECT * FROM task_instance WHERE child_id = ? AND period_start <= ? AND period_end >= ?", child.id, key, key);
        const spent = one<{ s: number }>(db, "SELECT COALESCE(SUM(-amount),0) AS s FROM ledger_entry WHERE child_id = ? AND amount < 0 AND created_at LIKE ?", child.id, `${key}%`)?.s ?? 0;
        const earned = one<{ s: number }>(db, "SELECT COALESCE(SUM(amount),0) AS s FROM ledger_entry WHERE child_id = ? AND amount > 0 AND created_at LIKE ?", child.id, `${key}%`)?.s ?? 0;
        const watches = many<{ watched_seconds: number; video_id: number }>(db, "SELECT watched_seconds, video_id FROM video_watch WHERE child_id = ? AND started_at LIKE ?", child.id, `${key}%`);
        return {
          child,
          balance: balanceOf(child.id),
          tasks: tasks.map(publicTask),
          earned,
          spent,
          watchCount: watches.length,
          watchSeconds: watches.reduce((sum, row) => sum + row.watched_seconds, 0),
        };
      });
    },
    actionLogs() {
      return many(db, "SELECT id, parent_id AS parentId, action, target_type AS targetType, target_id AS targetId, detail_json AS detail, created_at AS createdAt FROM parent_action_log ORDER BY id DESC LIMIT 100");
    },
    users() {
      return many(db, `SELECT u.id, u.username, u.role, u.display_role AS displayRole, u.status, p.nickname
        FROM user u LEFT JOIN child_profile p ON p.user_id = u.id ORDER BY u.id`);
    },
    createUser(parentId: number, input: { username: string; password: string; role: "parent" | "child"; displayRole: string; nickname?: string }) {
      const username = input.username.trim();
      if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) throw new HttpError(400, "用户名用 2-20 位字母数字");
      if (input.password.length < 4) throw new HttpError(400, "密码至少 4 位");
      const id = run(db, "INSERT INTO user (username, password_hash, role, display_role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)", username, hashPassword(input.password), input.role, input.displayRole || (input.role === "child" ? "孩子" : "家长"), nowIso()).id;
      if (input.role === "child") {
        run(db, "INSERT INTO child_profile (user_id, nickname, outfit_id) VALUES (?, ?, 'rocket')", id, (input.nickname || input.displayRole || username).slice(0, 12));
        run(db, "INSERT INTO pity (child_id, counter) VALUES (?, 0)", id);
      }
      logAction(parentId, "create_user", "user", String(id), { username, role: input.role });
      return this.users();
    },
    updateUser(parentId: number, id: number, input: { password?: string; status?: string; displayRole?: string }) {
      if (input.password) {
        if (input.password.length < 4) throw new HttpError(400, "密码至少 4 位");
        run(db, "UPDATE user SET password_hash = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?", hashPassword(input.password), id);
        const username = one<{ username: string }>(db, "SELECT username FROM user WHERE id = ?", id)?.username;
        for (const key of [...loginFailures.keys()]) if (username && key.startsWith("account:") && key.endsWith(`:${username}`)) loginFailures.delete(key);
      }
      if (input.status) run(db, "UPDATE user SET status = ? WHERE id = ?", input.status, id);
      if (input.displayRole) run(db, "UPDATE user SET display_role = ? WHERE id = ?", input.displayRole, id);
      logAction(parentId, "update_user", "user", String(id), { status: input.status, resetPassword: Boolean(input.password) });
      return this.users();
    },
    runJobs() {
      ensureCurrentWeeks();
      const stamp = nowIso();
      const eco = economy();
      const pending = many<TaskRow>(db, "SELECT * FROM task_instance WHERE status = 'pending'");
      for (const period of pending) {
        if (period.task_code === "swim") {
          const autoAt = atShanghai(period.period_start, eco.swimAuto);
          if (stamp >= autoAt) {
            tx(db, () => finishTask(period.id, { completedAt: stamp, via: "auto", parentId: null }));
          }
          continue;
        }
        const end = `${period.period_end}T23:59:59+08:00`;
        if (stamp > end) run(db, "UPDATE task_instance SET status = 'missed', qualified = 0 WHERE id = ? AND status = 'pending'", period.id);
      }
    },
    activePeriodToday(task: "school_hw" | "houhai_hw" | "swim") {
      return activePeriod(task, dateKeyOf(clock.now()), economy());
    },
    addDays,
  };
}

export type Service = ReturnType<typeof createService>;
