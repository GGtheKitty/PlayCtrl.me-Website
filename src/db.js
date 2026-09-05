// db.js
const path = require("path");
const Database = require("better-sqlite3");
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, "ggbot.db");
const db = new Database(DB_PATH);
db.DB_PATH = DB_PATH;

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
    is_bootstrap INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS bans (
    discord_id TEXT PRIMARY KEY,
    reason TEXT,
    banned_by TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(discord_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(banned_by) REFERENCES users(discord_id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS pair_codes (
    user_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    code_plain TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    last_reset_at INTEGER,
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

  CREATE TABLE IF NOT EXISTS client_pairing_credentials (
    user_id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    secret_ciphertext TEXT NOT NULL,
    secret_iv TEXT NOT NULL,
    secret_tag TEXT NOT NULL,
    secret_version INTEGER NOT NULL DEFAULT 1,
    secret_required INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    activated_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    code_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    used_at INTEGER,
    used_by TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_invite_created_at
    ON invite_codes(created_at);
  CREATE INDEX IF NOT EXISTS idx_invite_codes_used_at
    ON invite_codes(used_at);
  CREATE INDEX IF NOT EXISTS idx_invite_used_by
    ON invite_codes(used_by);

  CREATE TABLE IF NOT EXISTS invite_referral_penalties (
    banned_user_id TEXT PRIMARY KEY,
    inviter_user_id TEXT NOT NULL,
    invite_code_hash TEXT NOT NULL,
    strike_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(banned_user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(inviter_user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(invite_code_hash) REFERENCES invite_codes(code_hash) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_invite_referral_penalties_inviter
    ON invite_referral_penalties(inviter_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS api_keys (
    user_id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_reset_at INTEGER NOT NULL,
    requests_today INTEGER NOT NULL DEFAULT 0,
    reset_unix INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_whitelist (
    owner_id TEXT NOT NULL,
    allowed_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, allowed_id),
    FOREIGN KEY(owner_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(allowed_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_whitelist_owner
    ON user_whitelist(owner_id);

  CREATE TABLE IF NOT EXISTS friendships (
    user_a_id TEXT NOT NULL,
    user_b_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_a_id, user_b_id),
    CHECK (user_a_id < user_b_id),
    CHECK (status IN ('pending', 'accepted')),
    FOREIGN KEY(user_a_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(user_b_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(requested_by) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_friendships_user_a_status
    ON friendships(user_a_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_friendships_user_b_status
    ON friendships(user_b_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_friendships_requested_by
    ON friendships(requested_by, updated_at DESC);

  CREATE TABLE IF NOT EXISTS leash_delegations (
    sub_user_id TEXT PRIMARY KEY,
    dom_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(sub_user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(dom_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_leash_delegations_dom
    ON leash_delegations(dom_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS favorites (
    user_id TEXT NOT NULL,
    favorite_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (user_id, favorite_user_id),
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(favorite_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_favorites_user_created
    ON favorites(user_id, created_at);

  CREATE TABLE IF NOT EXISTS list_items (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_list_items (
    user_id TEXT NOT NULL,
    list_key TEXT NOT NULL,
    item_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, list_key, item_key),
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(item_key) REFERENCES list_items(key) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_list_items_user
    ON user_list_items(user_id, list_key);

  CREATE TABLE IF NOT EXISTS url_verification_queue (
    host TEXT PRIMARY KEY,
    sample_url TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    decided TEXT,
    decided_by TEXT,
    decided_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS media_url_resolver_sites (
    host TEXT PRIMARY KEY,
    resolver_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_message_board (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(owner_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS command_send_counts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    actor_user_id TEXT NOT NULL,
    target_user_id TEXT,
    source_event_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_device_message_board_owner_created
    ON device_message_board(owner_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS group_message_board (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_key TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(author_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_group_message_board_group_created
    ON group_message_board(group_key, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_group_message_board_author_created
    ON group_message_board(author_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS web_cmd_cooldowns (
    user_id TEXT PRIMARY KEY,
    next_allowed_at_ms INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS group_memberships (
    group_key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_key, user_id),
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_group_memberships_user
    ON group_memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_group_memberships_group
    ON group_memberships(group_key);

  CREATE TABLE IF NOT EXISTS community_groups (
    group_key TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_public INTEGER NOT NULL DEFAULT 0,
    custom_avatar_path TEXT,
    custom_avatar_mime TEXT,
    custom_avatar_updated_at INTEGER,
    custom_banner_path TEXT,
    custom_banner_mime TEXT,
    custom_banner_updated_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(owner_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_community_groups_owner
    ON community_groups(owner_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_community_groups_public
    ON community_groups(is_public, updated_at DESC, created_at DESC);

  CREATE TABLE IF NOT EXISTS community_group_invites (
    code TEXT PRIMARY KEY,
    group_key TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    FOREIGN KEY(group_key) REFERENCES community_groups(group_key) ON DELETE CASCADE,
    FOREIGN KEY(created_by_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_community_group_invites_group
    ON community_group_invites(group_key, created_at DESC);

  CREATE TABLE IF NOT EXISTS community_group_command_prefs (
    group_key TEXT PRIMARY KEY,
    allow_popup INTEGER NOT NULL DEFAULT 1,
    allow_open_url INTEGER NOT NULL DEFAULT 1,
    allow_image_popup INTEGER NOT NULL DEFAULT 1,
    allow_fullscreen_popup INTEGER NOT NULL DEFAULT 1,
    allow_spiral_overlay INTEGER NOT NULL DEFAULT 1,
    allow_set_wallpaper INTEGER NOT NULL DEFAULT 1,
    allow_play_sound INTEGER NOT NULL DEFAULT 1,
    allow_write_for_me INTEGER NOT NULL DEFAULT 1,
    allow_subliminal_message INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(group_key) REFERENCES community_groups(group_key) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS heavy_cooldowns (
    actor_id TEXT PRIMARY KEY,
    last_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_responses (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    owner_user_id TEXT NOT NULL,
    actor_user_id TEXT,
    device_id TEXT,
    command_id TEXT,
    response_type TEXT NOT NULL,
    mime TEXT NOT NULL,
    file_path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    monitors INTEGER,
    FOREIGN KEY(owner_user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(actor_user_id) REFERENCES users(discord_id) ON DELETE SET NULL,
    FOREIGN KEY(device_id) REFERENCES devices_v2(device_id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_device_responses_owner_created
    ON device_responses(owner_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_device_responses_actor
    ON device_responses(actor_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_device_responses_created
    ON device_responses(created_at DESC);

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    action_url TEXT,
    action_label TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    created_by TEXT,
    source_type TEXT,
    source_id TEXT,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_read
    ON notifications(user_id, read_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_created_by
    ON notifications(created_by, created_at DESC);

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_pair_code TEXT,
    subject_display_name TEXT,
    reporter_user_id TEXT NOT NULL,
    reporter_display_name TEXT,
    reason_key TEXT NOT NULL,
    reason_label TEXT NOT NULL,
    details TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    strike_count INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER,
    resolved_by TEXT,
    FOREIGN KEY(reporter_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_reports_created
    ON reports(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_subject
    ON reports(subject_type, subject_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_reporter
    ON reports(reporter_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_resolved
    ON reports(resolved_at, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS user_strikes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    strike_delta INTEGER NOT NULL,
    reason_label TEXT NOT NULL,
    source_label TEXT,
    details TEXT,
    source_type TEXT NOT NULL,
    source_id TEXT,
    report_id TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    created_by TEXT,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(discord_id) ON DELETE SET NULL,
    FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_strikes_user_created
    ON user_strikes(user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_user_strikes_report
    ON user_strikes(report_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS report_media_backups (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL UNIQUE,
    backup_kind TEXT NOT NULL,
    source_url TEXT,
    original_name TEXT,
    stored_name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_report_media_backups_created
    ON report_media_backups(created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS command_sender_blocks (
    owner_user_id TEXT NOT NULL,
    blocked_user_id TEXT NOT NULL,
    source_event_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_user_id, blocked_user_id),
    FOREIGN KEY(owner_user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(blocked_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_command_sender_blocks_owner_created
    ON command_sender_blocks(owner_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_command_sender_blocks_blocked_created
    ON command_sender_blocks(blocked_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS command_history_likes (
    event_id TEXT PRIMARY KEY,
    liked_user_id TEXT NOT NULL,
    liker_user_id TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'direct',
    source_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(liked_user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
    FOREIGN KEY(liker_user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_command_history_likes_liked_created
    ON command_history_likes(liked_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_command_history_likes_liker_created
    ON command_history_likes(liker_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_command_history_likes_source
    ON command_history_likes(source_kind, source_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS uploaded_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    original_name TEXT,
    stored_name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    preview_kind TEXT NOT NULL,
    media_group TEXT NOT NULL,
    wallpaper_compatible INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    protected_until INTEGER,
    delete_after_queue INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_top_favorites (
    user_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_key),
    FOREIGN KEY(user_id) REFERENCES users(discord_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_top_favorites_user_created
    ON user_top_favorites(user_id, created_at DESC);

  -- Create events table in its minimal form if missing
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL
  );
`);

// 2) Migrate events table columns (if your table already existed)
addColumnIfMissing("users", "avatar_cache_path", "TEXT");
addColumnIfMissing("users", "avatar_cache_mime", "TEXT");
addColumnIfMissing("users", "avatar_cache_updated_at", "INTEGER");
addColumnIfMissing("users", "custom_avatar_path", "TEXT");
addColumnIfMissing("users", "custom_avatar_mime", "TEXT");
addColumnIfMissing("users", "custom_avatar_updated_at", "INTEGER");
addColumnIfMissing("users", "custom_banner_path", "TEXT");
addColumnIfMissing("users", "custom_banner_mime", "TEXT");
addColumnIfMissing("users", "custom_banner_updated_at", "INTEGER");
addColumnIfMissing("users", "custom_background_path", "TEXT");
addColumnIfMissing("users", "custom_background_mime", "TEXT");
addColumnIfMissing("users", "custom_background_updated_at", "INTEGER");
addColumnIfMissing("users", "has_supporter_badge", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "discoverable", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "invited_at", "INTEGER");
addColumnIfMissing("invite_codes", "code_plain", "TEXT");
addColumnIfMissing("invite_codes", "source", "TEXT NOT NULL DEFAULT 'admin'");
addColumnIfMissing("invite_codes", "revoked_at", "INTEGER");
addColumnIfMissing("invite_codes", "revoked_reason", "TEXT");
addColumnIfMissing("invite_codes", "deleted_at", "INTEGER");
addColumnIfMissing("invite_codes", "deleted_by", "TEXT");
addColumnIfMissing("users", "allow_toast", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("users", "allow_popup", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("users", "allow_open_url", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("users", "allow_image_popup", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("users", "allow_fullscreen_popup", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("users", "allow_spiral_overlay", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("users", "allow_set_wallpaper", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("users", "allow_screenshot", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "allow_webcam_capture", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "allow_play_sound", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing(
  "users",
  "allow_subliminal_message",
  "INTEGER NOT NULL DEFAULT 1",
);
addColumnIfMissing(
  "users",
  "disable_custom_backgrounds",
  "INTEGER NOT NULL DEFAULT 0",
);
addColumnIfMissing(
  "users",
  "exclude_from_leaderboards",
  "INTEGER NOT NULL DEFAULT 0",
);
addColumnIfMissing(
  "users",
  "control_link_theme",
  "TEXT NOT NULL DEFAULT 'purple'",
);
addColumnIfMissing("users", "control_link_display_name", "TEXT");
addColumnIfMissing("users", "custom_control_slug", "TEXT");
addColumnIfMissing("users", "custom_control_slug_updated_at", "INTEGER");
addColumnIfMissing("users", "about_me", "TEXT");
addColumnIfMissing("users", "whitelist_enabled", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "api_key", "TEXT");
addColumnIfMissing("users", "commands_sent_total", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "enrolled_at", "INTEGER");
addColumnIfMissing("users", "api_rate_limit", "INTEGER");
addColumnIfMissing("users", "command_likes_total", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "away_enabled", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "last_online_at", "INTEGER");
addColumnIfMissing("admins", "is_bootstrap", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("pair_codes", "last_reset_at", "INTEGER");
addColumnIfMissing(
  "device_pairs",
  "auth_level",
  "TEXT NOT NULL DEFAULT 'legacy'",
);
addColumnIfMissing("device_pairs", "secret_version", "INTEGER");
addColumnIfMissing("device_pairs", "verified_at", "INTEGER");
addColumnIfMissing("device_pairs", "device_name", "TEXT");
addColumnIfMissing("devices_v2", "reported_capabilities_json", "TEXT");
addColumnIfMissing("devices_v2", "reported_capabilities_whitelisted_json", "TEXT");
addColumnIfMissing("devices_v2", "reported_capabilities_updated_at", "INTEGER");
addColumnIfMissing("uploaded_files", "protected_until", "INTEGER");
addColumnIfMissing("uploaded_files", "delete_after_queue", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("device_responses", "actor_user_id", "TEXT");
addColumnIfMissing("api_keys", "requests_today", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("api_keys", "reset_unix", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("reports", "resolved_at", "INTEGER");
addColumnIfMissing("reports", "resolved_by", "TEXT");
addColumnIfMissing("reports", "strike_count", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("command_send_counts", "source_event_id", "TEXT");
addColumnIfMissing("community_groups", "custom_avatar_path", "TEXT");
addColumnIfMissing("community_groups", "custom_avatar_mime", "TEXT");
addColumnIfMissing("community_groups", "custom_avatar_updated_at", "INTEGER");
addColumnIfMissing("community_groups", "custom_banner_path", "TEXT");
addColumnIfMissing("community_groups", "custom_banner_mime", "TEXT");
addColumnIfMissing("community_groups", "custom_banner_updated_at", "INTEGER");
addColumnIfMissing(
  "community_group_command_prefs",
  "allow_spiral_overlay",
  "INTEGER NOT NULL DEFAULT 1",
);

addColumnIfMissing("events", "actor_user_id", "TEXT");
addColumnIfMissing("events", "target_user_id", "TEXT");
addColumnIfMissing("events", "pair_code", "TEXT");
addColumnIfMissing("events", "device_id", "TEXT");
addColumnIfMissing("events", "ip", "TEXT");
addColumnIfMissing("events", "ua", "TEXT");

// If payload existed, leave it. If it somehow didn't, add it.
// (Your minimal create includes it, so usually not needed.)
if (!hasColumn("events", "payload")) {
  addColumnIfMissing("events", "payload", "TEXT NOT NULL DEFAULT '{}'");
}

// 3) Indexes (wrap in try-catch so a partial bad state doesn't kill startup)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queued_commands (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      actor_user_id TEXT,
      source_kind TEXT NOT NULL DEFAULT 'direct',
      source_id TEXT,
      command_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(owner_user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
      FOREIGN KEY(actor_user_id) REFERENCES users(discord_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS queued_command_upload_refs (
      queue_id TEXT NOT NULL,
      upload_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (queue_id, upload_id),
      FOREIGN KEY(queue_id) REFERENCES queued_commands(id) ON DELETE CASCADE,
      FOREIGN KEY(upload_id) REFERENCES uploaded_files(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_queued_commands_owner_created
      ON queued_commands(owner_user_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_queued_commands_created
      ON queued_commands(created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_queued_command_upload_refs_upload
      ON queued_command_upload_refs(upload_id, queue_id);
    CREATE INDEX IF NOT EXISTS idx_uploaded_files_user_created
      ON uploaded_files(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_uploaded_files_expires
      ON uploaded_files(expires_at, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_uploaded_files_created
      ON uploaded_files(created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_uploaded_files_protected_until
      ON uploaded_files(protected_until ASC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_users_away_enabled
      ON users(away_enabled, last_online_at);
    CREATE INDEX IF NOT EXISTS idx_users_discover_live
      ON users(discoverable, whitelist_enabled, away_enabled, last_online_at);
    CREATE INDEX IF NOT EXISTS idx_command_send_counts_created
      ON command_send_counts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_command_send_counts_actor_created
      ON command_send_counts(actor_user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_command_send_counts_source_event
      ON command_send_counts(source_event_id)
      WHERE source_event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_media_url_resolver_sites_enabled
      ON media_url_resolver_sites(enabled, host);
    CREATE INDEX IF NOT EXISTS idx_command_history_likes_liked_created
      ON command_history_likes(liked_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_command_history_likes_liker_created
      ON command_history_likes(liker_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_command_history_likes_source
      ON command_history_likes(source_kind, source_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_user_id);
    CREATE INDEX IF NOT EXISTS idx_bans_created_at ON bans(created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_custom_control_slug_unique
      ON users(custom_control_slug)
      WHERE custom_control_slug IS NOT NULL AND custom_control_slug != '';
  `);
} catch (e) {
  console.error("[db] index create warning:", e.message);
}

try {
  db.exec(`
    INSERT OR IGNORE INTO command_send_counts (
      created_at,
      actor_user_id,
      target_user_id,
      source_event_id
    )
    SELECT
      e.created_at,
      e.actor_user_id,
      e.target_user_id,
      e.id
    FROM events e
    WHERE e.type = 'commands_sent_counted'
      AND IFNULL(TRIM(e.actor_user_id), '') != '';
  `);
} catch (e) {
  console.error("[db] command_send_counts backfill warning:", e.message);
}

module.exports = db;
