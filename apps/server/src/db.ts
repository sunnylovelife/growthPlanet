import { DatabaseSync } from "node:sqlite";

export function openDatabase(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    /* memory databases */
  }
  db.exec("PRAGMA busy_timeout = 3000");
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_role TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS child_profile (
      user_id INTEGER PRIMARY KEY,
      nickname TEXT NOT NULL,
      outfit_id TEXT NOT NULL DEFAULT 'rocket',
      FOREIGN KEY(user_id) REFERENCES user(id)
    );
    CREATE TABLE IF NOT EXISTS session (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      device TEXT,
      ip TEXT
    );
    CREATE TABLE IF NOT EXISTS task_instance (
      id INTEGER PRIMARY KEY,
      child_id INTEGER NOT NULL,
      task_code TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      week_start TEXT NOT NULL,
      deadline_at TEXT,
      status TEXT NOT NULL,
      completed_at TEXT,
      completed_via TEXT,
      confirmed_by INTEGER,
      photo_path TEXT,
      photo_hash TEXT,
      qualified INTEGER,
      base_reward INTEGER,
      streak_bonus INTEGER,
      reward_amount INTEGER,
      UNIQUE(child_id, task_code, period_start)
    );
    CREATE TABLE IF NOT EXISTS reward_claim (
      id INTEGER PRIMARY KEY,
      child_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      title TEXT NOT NULL,
      card_draws INTEGER NOT NULL DEFAULT 1,
      breakdown_json TEXT,
      perfect_week INTEGER NOT NULL DEFAULT 0,
      week_start TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      UNIQUE(source_type, source_id)
    );
    CREATE TABLE IF NOT EXISTS ledger_entry (
      id INTEGER PRIMARY KEY,
      child_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      type TEXT NOT NULL,
      ref_type TEXT,
      ref_id TEXT,
      title TEXT NOT NULL,
      created_by INTEGER,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pity (
      child_id INTEGER PRIMARY KEY,
      counter INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS child_card (
      child_id INTEGER NOT NULL,
      card_id TEXT NOT NULL,
      count INTEGER NOT NULL,
      first_obtained_at TEXT NOT NULL,
      PRIMARY KEY(child_id, card_id)
    );
    CREATE TABLE IF NOT EXISTS card_draw (
      id INTEGER PRIMARY KEY,
      child_id INTEGER NOT NULL,
      reward_claim_id INTEGER NOT NULL,
      card_id TEXT NOT NULL,
      rarity TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video (
      id INTEGER PRIMARY KEY,
      source_url TEXT,
      share_text TEXT,
      title TEXT NOT NULL,
      file_path TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_purchase (
      id INTEGER PRIMARY KEY,
      child_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      purchase_date TEXT NOT NULL,
      daily_index INTEGER NOT NULL,
      price INTEGER NOT NULL,
      plays_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(child_id, purchase_date, daily_index)
    );
    CREATE TABLE IF NOT EXISTS video_watch (
      id INTEGER PRIMARY KEY,
      purchase_id INTEGER,
      child_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      play_no INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      idempotency_key TEXT UNIQUE,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      ended_at TEXT,
      watched_seconds INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      end_reason TEXT,
      token_expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY,
      client_event_id TEXT UNIQUE,
      user_id INTEGER,
      type TEXT NOT NULL,
      page TEXT,
      props_json TEXT,
      source TEXT NOT NULL,
      client_ts TEXT,
      server_ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS parent_action_log (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notice (
      id INTEGER PRIMARY KEY,
      child_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS setting (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_log (
      id INTEGER PRIMARY KEY,
      username TEXT,
      user_id INTEGER,
      success INTEGER NOT NULL,
      ip TEXT,
      device TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let version = current; version < MIGRATIONS.length; version++) {
    tx(db, () => {
      MIGRATIONS[version](db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

// 表结构变更只能追加到末尾；已上线的条目不要修改或删除
export const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  (db) => {
    db.exec("CREATE INDEX IF NOT EXISTS idx_event_log_user_ts ON event_log(user_id, server_ts)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_login_log_created ON login_log(created_at)");
  },
];

export function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const exists = many<{ name: string }>(db, `PRAGMA table_info(${table})`).some((col) => col.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function one<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function many<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(db: DatabaseSync, sql: string, ...params: unknown[]): { changes: number; id: number } {
  const info = db.prepare(sql).run(...(params as never[]));
  return { changes: Number(info.changes), id: Number(info.lastInsertRowid) };
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}
