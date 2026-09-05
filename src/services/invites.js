const USER_WEEKLY_INVITE_LIMIT = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function getUtcWeekStart(now = Date.now()) {
  const date = new Date(Number(now) || Date.now());
  const dayFromMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - dayFromMonday,
  );
}

function createInviteService({
  db,
  crypto,
  genInviteCode,
  inviteHash,
  getUserStrikeCount,
  insertUserStrikeEntry,
  createStrikeNotification,
  ensureUserBannedForStrikes,
  maxUserStrikes = 3,
}) {
  const insertInvite = db.prepare(`
    INSERT INTO invite_codes (
      code_hash, code_plain, source, created_at, created_by
    ) VALUES (?, ?, ?, ?, ?)
  `);

  function getUserInviteAllowance(userId, { now = Date.now() } = {}) {
    const id = String(userId || "").trim();
    const weekStart = getUtcWeekStart(now);
    const weekEnd = weekStart + WEEK_MS;
    const strikeCount = id ? Math.max(0, Number(getUserStrikeCount(id) || 0)) : 0;
    const generatedThisWeek = id
      ? Number(
          db
            .prepare(
              `
                SELECT COUNT(*) AS n
                FROM invite_codes
                WHERE created_by=?
                  AND source='user'
                  AND created_at>=?
                  AND created_at<?
              `,
            )
            .get(id, weekStart, weekEnd)?.n || 0,
        )
      : 0;
    const remaining = strikeCount > 0
      ? 0
      : Math.max(0, USER_WEEKLY_INVITE_LIMIT - generatedThisWeek);

    return {
      eligible: !!id && strikeCount === 0 && remaining > 0,
      strikeCount,
      generatedThisWeek,
      remaining,
      weeklyLimit: USER_WEEKLY_INVITE_LIMIT,
      weekStart,
      weekEnd,
    };
  }

  function createCodes({
    createdBy,
    count = 1,
    source = "admin",
    enforceUserAllowance = false,
    now = Date.now(),
  }) {
    const creatorId = String(createdBy || "").trim();
    const safeSource = source === "user" ? "user" : "admin";
    let safeCount = Math.max(1, Math.min(50, Math.floor(Number(count) || 1)));
    let allowance = null;

    if (!creatorId) throw new Error("Invite creator is required.");
    if (enforceUserAllowance) {
      allowance = getUserInviteAllowance(creatorId, { now });
      if (allowance.strikeCount > 0) {
        const error = new Error("You cannot generate invites while you have active strikes.");
        error.code = "INVITES_STRIKES";
        throw error;
      }
      if (allowance.remaining <= 0) {
        const error = new Error("You have used all 3 invites for this week.");
        error.code = "INVITES_LIMIT";
        throw error;
      }
      safeCount = Math.min(safeCount, allowance.remaining);
    }

    const codes = [];
    const tx = db.transaction(() => {
      if (enforceUserAllowance) {
        const current = getUserInviteAllowance(creatorId, { now });
        if (current.strikeCount > 0 || current.remaining < safeCount) {
          const error = new Error(
            current.strikeCount > 0
              ? "You cannot generate invites while you have active strikes."
              : "Your weekly invite allowance has already been used.",
          );
          error.code = current.strikeCount > 0 ? "INVITES_STRIKES" : "INVITES_LIMIT";
          throw error;
        }
      }

      for (let index = 0; index < safeCount; index += 1) {
        let inserted = false;
        for (let tries = 0; tries < 10 && !inserted; tries += 1) {
          const code = genInviteCode();
          try {
            insertInvite.run(inviteHash(code), code, safeSource, now, creatorId);
            codes.push(code);
            inserted = true;
          } catch (error) {
            if (!String(error?.message || "").includes("UNIQUE")) throw error;
          }
        }
        if (!inserted) throw new Error("Could not generate a unique invite code.");
      }
    });
    tx();

    return { codes, allowance: getUserInviteAllowance(creatorId, { now }) };
  }

  function revokeOutstandingInvitesForUser(
    userId,
    { reason = "Creator received an active strike.", now = Date.now() } = {},
  ) {
    const id = String(userId || "").trim();
    if (!id) return 0;
    const result = db
      .prepare(
        `
          UPDATE invite_codes
          SET revoked_at=?, revoked_reason=?
          WHERE created_by=?
            AND source='user'
            AND used_at IS NULL
            AND revoked_at IS NULL
            AND deleted_at IS NULL
        `,
      )
      .run(now, String(reason || "").slice(0, 200), id);
    return Number(result.changes || 0);
  }

  function deleteUnclaimedInvite(codeHash, deletedBy, { now = Date.now() } = {}) {
    const hash = String(codeHash || "").trim();
    const actorId = String(deletedBy || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(hash) || !actorId) return false;
    const result = db
      .prepare(
        `
          UPDATE invite_codes
          SET deleted_at=?, deleted_by=?
          WHERE code_hash=?
            AND used_at IS NULL
            AND deleted_at IS NULL
        `,
      )
      .run(now, actorId, hash);
    return Number(result.changes || 0) === 1;
  }

  function penalizeInviterForBannedInvitee(
    bannedUserId,
    bannedByUserId,
    { req = null, now = Date.now() } = {},
  ) {
    const bannedId = String(bannedUserId || "").trim();
    if (!bannedId) return { applied: false, reason: "missing_user" };

    const referral = db
      .prepare(
        `
          SELECT code_hash, created_by
          FROM invite_codes
          WHERE used_by=? AND used_at IS NOT NULL
          ORDER BY used_at ASC
          LIMIT 1
        `,
      )
      .get(bannedId);
    const inviterId = String(referral?.created_by || "").trim();
    if (!referral || !inviterId || inviterId === bannedId) {
      return { applied: false, reason: "no_referrer" };
    }

    const inviterExists = !!db
      .prepare(`SELECT discord_id FROM users WHERE discord_id=? LIMIT 1`)
      .get(inviterId);
    if (!inviterExists) return { applied: false, reason: "missing_referrer" };

    const previousStrikeCount = Math.max(0, Number(getUserStrikeCount(inviterId) || 0));
    let strikeEntry = null;
    let insertedPenalty = false;

    const tx = db.transaction(() => {
      const penalty = db
        .prepare(
          `
            INSERT INTO invite_referral_penalties (
              banned_user_id, inviter_user_id, invite_code_hash, strike_id, created_at
            ) VALUES (?, ?, ?, NULL, ?)
            ON CONFLICT(banned_user_id) DO NOTHING
          `,
        )
        .run(bannedId, inviterId, referral.code_hash, now);
      if (Number(penalty.changes || 0) !== 1) return;
      insertedPenalty = true;

      if (previousStrikeCount >= maxUserStrikes) return;
      strikeEntry = insertUserStrikeEntry({
        userId: inviterId,
        strikeDelta: 1,
        reasonLabel: "A user you invited was banned",
        sourceLabel: "Invite referral enforcement",
        details: "You received a strike because an account that claimed one of your invites was banned.",
        sourceType: "invitee_banned",
        sourceId: bannedId,
        createdByUserId: String(bannedByUserId || "").trim() || null,
        meta: { bannedInviteeUserId: bannedId },
      });
      if (strikeEntry?.id) {
        db.prepare(
          `UPDATE invite_referral_penalties SET strike_id=? WHERE banned_user_id=?`,
        ).run(strikeEntry.id, bannedId);
      }

      const finalStrikeCount = Math.min(maxUserStrikes, previousStrikeCount + 1);
      createStrikeNotification({
        userId: inviterId,
        strikeDelta: 1,
        finalStrikeCount,
        reasonLabel: "A user you invited was banned",
        createdByUserId: String(bannedByUserId || "").trim() || null,
        sourceType: "invitee_banned",
        sourceId: bannedId,
      });

      if (finalStrikeCount >= maxUserStrikes) {
        ensureUserBannedForStrikes(inviterId, bannedByUserId, {
          req,
          strikeCount: finalStrikeCount,
        });
      }
    });
    tx();

    return {
      applied: insertedPenalty,
      inviterId,
      strikeId: strikeEntry?.id || null,
      previousStrikeCount,
      finalStrikeCount: strikeEntry
        ? Math.min(maxUserStrikes, previousStrikeCount + 1)
        : previousStrikeCount,
    };
  }

  function listUserInvites(userId, limit = 50) {
    return db
      .prepare(
        `
          SELECT i.code_hash, i.code_plain, i.created_at, i.used_at, i.used_by,
                 i.revoked_at, i.revoked_reason, i.deleted_at,
                 claimant.username AS claimant_username,
                 claimant.global_name AS claimant_global_name
          FROM invite_codes i
          LEFT JOIN users claimant ON claimant.discord_id=i.used_by
          WHERE i.created_by=? AND i.source='user'
          ORDER BY i.created_at DESC
          LIMIT ?
        `,
      )
      .all(String(userId || "").trim(), Math.max(1, Math.min(100, Number(limit) || 50)));
  }

  return {
    createCodes,
    deleteUnclaimedInvite,
    getUserInviteAllowance,
    listUserInvites,
    penalizeInviterForBannedInvitee,
    revokeOutstandingInvitesForUser,
  };
}

module.exports = {
  USER_WEEKLY_INVITE_LIMIT,
  WEEK_MS,
  createInviteService,
  getUtcWeekStart,
};
