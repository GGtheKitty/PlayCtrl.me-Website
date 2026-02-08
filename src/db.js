// db.js
const Database = require("better-sqlite3");
const db = new Database("ggbot.db");

db.pragma("foreign_keys = ON");

// Helper: check if column exists
function hasColumn(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

function addColumnIfMissing(table, column, sqlTypeAndDefault) {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlTypeAndDefault}`);
  }
}

// 1) Base tables (safe)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    global_name TEXT,
    avatar TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS admins (
    discord_id TEXT PRIMARY KEY,
    added_by TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pair_codes (
    user_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    code_plain TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS devices_v2 (
    device_id TEXT PRIMARY KEY,
    device_token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS device_pairs (
    device_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    paired_at INTEGER NOT NULL,
    FOREIGN KEY(device_id) REFERENCES devices_v2(device_id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_device_pairs_user ON device_pairs(user_id);

  -- Create events table in its minimal form if missing
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL
  );
`);

// 2) Migrate events table columns (if your table already existed)
addColumnIfMissing("events", "actor_user_id", "TEXT");
addColumnIfMissing("events", "target_user_id", "TEXT");
addColumnIfMissing("events", "pair_code", "TEXT");
addColumnIfMissing("events", "device_id", "TEXT");
addColumnIfMissing("events", "ip", "TEXT");
addColumnIfMissing("events", "ua", "TEXT");

// If payload existed, leave it. If it somehow didn’t, add it.
// (Your minimal create includes it, so usually not needed.)
if (!hasColumn("events", "payload")) {
  addColumnIfMissing("events", "payload", "TEXT NOT NULL DEFAULT '{}'");
}

// 3) Indexes (wrap in try-catch so a partial bad state doesn’t kill startup)
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_user_id);
  `);
} catch (e) {
  console.error("[db] index create warning:", e.message);
}

module.exports = db;
