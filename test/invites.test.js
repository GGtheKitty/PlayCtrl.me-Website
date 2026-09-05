const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const {
  USER_WEEKLY_INVITE_LIMIT,
  createInviteService,
  getUtcWeekStart,
} = require("../src/services/invites");

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users (discord_id TEXT PRIMARY KEY);
    CREATE TABLE invite_codes (
      code_hash TEXT PRIMARY KEY,
      code_plain TEXT,
      source TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL,
      created_by TEXT,
      used_at INTEGER,
      used_by TEXT,
      revoked_at INTEGER,
      revoked_reason TEXT,
      deleted_at INTEGER,
      deleted_by TEXT
    );
    CREATE TABLE invite_referral_penalties (
      banned_user_id TEXT PRIMARY KEY,
      inviter_user_id TEXT NOT NULL,
      invite_code_hash TEXT NOT NULL,
      strike_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  for (const id of ["100000000000", "200000000000", "300000000000"]) {
    db.prepare(`INSERT INTO users (discord_id) VALUES (?)`).run(id);
  }

  const strikes = new Map();
  const notifications = [];
  const bans = [];
  let sequence = 0;
  const service = createInviteService({
    db,
    crypto,
    genInviteCode: () => `CODE${String(++sequence).padStart(8, "0")}`,
    inviteHash: (code) => crypto.createHash("sha256").update(code).digest("hex"),
    getUserStrikeCount: (id) => strikes.get(id) || 0,
    insertUserStrikeEntry: ({ userId }) => {
      strikes.set(userId, (strikes.get(userId) || 0) + 1);
      return { id: crypto.randomUUID() };
    },
    createStrikeNotification: (notification) => notifications.push(notification),
    ensureUserBannedForStrikes: (userId) => bans.push(userId),
    maxUserStrikes: 3,
  });
  return { db, service, strikes, notifications, bans };
}

test("weekly member invites are limited to three and reset Monday UTC", () => {
  const { service } = fixture();
  const userId = "100000000000";
  const wednesday = Date.UTC(2026, 8, 2, 12);
  assert.equal(getUtcWeekStart(wednesday), Date.UTC(2026, 7, 31));

  const result = service.createCodes({
    createdBy: userId,
    count: USER_WEEKLY_INVITE_LIMIT,
    source: "user",
    enforceUserAllowance: true,
    now: wednesday,
  });
  assert.equal(result.codes.length, 3);
  assert.equal(result.allowance.remaining, 0);
  assert.throws(
    () => service.createCodes({
      createdBy: userId,
      source: "user",
      enforceUserAllowance: true,
      now: wednesday,
    }),
    (error) => error.code === "INVITES_LIMIT",
  );
  assert.equal(
    service.getUserInviteAllowance(userId, { now: Date.UTC(2026, 8, 7) }).remaining,
    3,
  );
});

test("active strikes block generation and revoke every outstanding member invite", () => {
  const { db, service, strikes } = fixture();
  const userId = "100000000000";
  service.createCodes({
    createdBy: userId,
    count: 2,
    source: "user",
    enforceUserAllowance: true,
  });
  strikes.set(userId, 1);

  assert.equal(service.revokeOutstandingInvitesForUser(userId), 2);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM invite_codes WHERE revoked_at IS NOT NULL`).get().n,
    2,
  );
  assert.throws(
    () => service.createCodes({
      createdBy: userId,
      source: "user",
      enforceUserAllowance: true,
    }),
    (error) => error.code === "INVITES_STRIKES",
  );
});

test("an invitee ban gives its inviter exactly one strike", () => {
  const { db, service, strikes, notifications } = fixture();
  const inviterId = "100000000000";
  const inviteeId = "200000000000";
  const { codes } = service.createCodes({ createdBy: inviterId, source: "user" });
  const hash = crypto.createHash("sha256").update(codes[0]).digest("hex");
  db.prepare(`UPDATE invite_codes SET used_at=?, used_by=? WHERE code_hash=?`).run(
    Date.now(),
    inviteeId,
    hash,
  );

  const first = service.penalizeInviterForBannedInvitee(inviteeId, "300000000000");
  const second = service.penalizeInviterForBannedInvitee(inviteeId, "300000000000");
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(strikes.get(inviterId), 1);
  assert.equal(notifications.length, 1);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM invite_referral_penalties`).get().n,
    1,
  );
});

test("admins can delete only unclaimed invites", () => {
  const { db, service } = fixture();
  const adminId = "300000000000";
  const open = service.createCodes({ createdBy: adminId, source: "admin" }).codes[0];
  const used = service.createCodes({ createdBy: adminId, source: "admin" }).codes[0];
  const hash = (code) => crypto.createHash("sha256").update(code).digest("hex");
  db.prepare(`UPDATE invite_codes SET used_at=?, used_by=? WHERE code_hash=?`).run(
    Date.now(),
    "200000000000",
    hash(used),
  );

  assert.equal(service.deleteUnclaimedInvite(hash(open), adminId), true);
  assert.equal(service.deleteUnclaimedInvite(hash(open), adminId), false);
  assert.equal(service.deleteUnclaimedInvite(hash(used), adminId), false);
});
