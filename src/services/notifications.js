function createNotificationService({
  db,
  crypto,
  tryJson,
  normalizeControlLinkDisplayName,
  logEvent,
  constants,
}) {
  const {
    ADMIN_REPORT_QUEUE_KIND,
    ADMIN_REPORT_QUEUE_SOURCE_ID,
    ADMIN_REPORT_QUEUE_SOURCE_TYPE,
    ALL_REPORT_REASON_BY_KEY,
    MAX_USER_STRIKES,
    NOTIFICATION_ACTION_LABEL_MAX_LEN,
    NOTIFICATION_KIND_MAX_LEN,
    NOTIFICATION_MENU_LIMIT,
    NOTIFICATION_MESSAGE_MAX_LEN,
    NOTIFICATION_PAGE_LIMIT,
    NOTIFICATION_TITLE_MAX_LEN,
    PROFILE_STRIKE_HISTORY_LIMIT,
    REPORT_DETAILS_MAX_LEN,
    REPORT_SUBJECT_TYPE_MAX_LEN,
  } = constants;

  const insertUserStrikeRow = db.prepare(
    `
      INSERT INTO user_strikes (
        id,
        user_id,
        strike_delta,
        reason_label,
        source_label,
        details,
        source_type,
        source_id,
        report_id,
        meta_json,
        created_at,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const insertNotificationRow = db.prepare(
    `
      INSERT INTO notifications (
        id, user_id, kind, title, message,
        action_url, action_label, meta_json,
        created_at, read_at, created_by, source_type, source_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `,
  );
  const selectUnreadAdminQueueRows = db.prepare(
    `
      SELECT id, meta_json
      FROM notifications
      WHERE user_id=?
        AND kind=?
        AND source_type=?
        AND source_id=?
        AND read_at IS NULL
      ORDER BY created_at DESC, id DESC
    `,
  );
  const selectUnreadNotificationRowsBySource = db.prepare(
    `
      SELECT id, meta_json
      FROM notifications
      WHERE user_id=?
        AND kind=?
        AND source_type=?
        AND source_id=?
        AND read_at IS NULL
      ORDER BY created_at DESC, id DESC
    `,
  );
  const deleteNotificationById = db.prepare(
    `DELETE FROM notifications WHERE id=?`,
  );
  const updateNotificationRow = db.prepare(
    `
      UPDATE notifications
      SET
        title=?,
        message=?,
        action_url=?,
        action_label=?,
        meta_json=?,
        created_at=?,
        created_by=?
      WHERE id=?
    `,
  );

  function normalizeNotificationKind(value) {
    const kind = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, "_")
      .slice(0, NOTIFICATION_KIND_MAX_LEN);
    return kind || "system";
  }

  function normalizeNotificationTitle(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NOTIFICATION_TITLE_MAX_LEN);
  }

  function normalizeNotificationMessage(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .trim()
      .slice(0, NOTIFICATION_MESSAGE_MAX_LEN);
  }

  function normalizeNotificationActionUrl(value) {
    const url = String(value || "").trim();
    if (!url) return null;
    if (url.startsWith("/")) return url.slice(0, 500);
    if (/^https?:\/\//i.test(url)) return url.slice(0, 500);
    return null;
  }

  function normalizeNotificationActionLabel(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NOTIFICATION_ACTION_LABEL_MAX_LEN);
  }

  function normalizeReportSubjectType(value) {
    const subjectType = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, "_")
      .slice(0, REPORT_SUBJECT_TYPE_MAX_LEN);
    return subjectType || "control_link";
  }

  function normalizeReportDetails(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .trim()
      .slice(0, REPORT_DETAILS_MAX_LEN);
  }

  function getReportReasonOption(key, reasonMap = ALL_REPORT_REASON_BY_KEY) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    return reasonMap.get(normalizedKey) || null;
  }

  function serializeNotificationMeta(value) {
    try {
      return JSON.stringify(value ?? {});
    } catch {
      return "{}";
    }
  }

  function formatNotificationTimeLabel(value) {
    const ts = Number(value || 0);
    if (!Number.isFinite(ts) || ts <= 0) return "";

    const diff = Math.max(0, Date.now() - ts);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diff < 45 * 1000) return "Just now";
    if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m ago`;
    if (diff < day) return `${Math.max(1, Math.floor(diff / hour))}h ago`;
    if (diff < 7 * day) return `${Math.max(1, Math.floor(diff / day))}d ago`;

    const date = new Date(ts);
    const includeYear = date.getUTCFullYear() !== new Date().getUTCFullYear();
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" } : {}),
    });
  }

  function formatCountLabel(value, singular, plural = `${singular}s`) {
    const n = Math.abs(Math.floor(Number(value || 0)));
    return `${n} ${n === 1 ? singular : plural}`;
  }

  function normalizeStrikeCount(value, { min = 0, max = MAX_USER_STRIKES } = {}) {
    const n = Number.parseInt(String(value ?? "").trim(), 10);
    if (!Number.isFinite(n)) return null;
    if (n < min || n > max) return null;
    return n;
  }

  const STRIKE_DECAY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

  function normalizeStrikeTimestamp(value) {
    const ts = Math.floor(Number(value || 0));
    if (!Number.isFinite(ts) || ts <= 0) return 0;
    return ts;
  }

  function createEmptyUserStrikeState() {
    return {
      currentStrikeCount: 0,
      mostRecentStrikeAt: 0,
      nextDecayAt: 0,
      evaluatedAt: 0,
    };
  }

  function advanceUserStrikeState(state, targetTime) {
    const baseState =
      state && typeof state === "object" ? state : createEmptyUserStrikeState();
    const targetTs = Math.max(
      normalizeStrikeTimestamp(baseState.evaluatedAt),
      normalizeStrikeTimestamp(targetTime),
    );
    let currentStrikeCount = Math.max(
      0,
      Math.trunc(Number(baseState.currentStrikeCount || 0)),
    );
    const mostRecentStrikeAt = normalizeStrikeTimestamp(baseState.mostRecentStrikeAt);
    let nextDecayAt = normalizeStrikeTimestamp(baseState.nextDecayAt);

    if (currentStrikeCount > 0 && !nextDecayAt && mostRecentStrikeAt) {
      nextDecayAt = mostRecentStrikeAt + STRIKE_DECAY_INTERVAL_MS;
    }

    while (currentStrikeCount > 0 && nextDecayAt > 0 && nextDecayAt <= targetTs) {
      currentStrikeCount -= 1;
      if (currentStrikeCount <= 0) {
        currentStrikeCount = 0;
        nextDecayAt = 0;
        break;
      }
      nextDecayAt += STRIKE_DECAY_INTERVAL_MS;
    }

    return {
      currentStrikeCount,
      mostRecentStrikeAt,
      nextDecayAt: currentStrikeCount > 0 ? nextDecayAt : 0,
      evaluatedAt: targetTs,
    };
  }

  function applyStrikeDeltaToState(state, strikeDelta, createdAt) {
    const delta = Math.trunc(Number(strikeDelta || 0));
    const normalizedCreatedAt = normalizeStrikeTimestamp(createdAt);
    let nextState = advanceUserStrikeState(state, normalizedCreatedAt);

    if (!Number.isFinite(delta) || delta === 0) {
      return nextState;
    }

    const effectiveCreatedAt =
      normalizedCreatedAt || nextState.evaluatedAt || Date.now();

    if (delta > 0) {
      nextState = {
        ...nextState,
        currentStrikeCount: Math.max(0, nextState.currentStrikeCount + delta),
        mostRecentStrikeAt: effectiveCreatedAt,
        nextDecayAt: effectiveCreatedAt + STRIKE_DECAY_INTERVAL_MS,
        evaluatedAt: Math.max(nextState.evaluatedAt, effectiveCreatedAt),
      };
      return nextState;
    }

    nextState = {
      ...nextState,
      currentStrikeCount: Math.max(0, nextState.currentStrikeCount + delta),
      evaluatedAt: Math.max(nextState.evaluatedAt, effectiveCreatedAt),
    };

    if (nextState.currentStrikeCount <= 0) {
      nextState.nextDecayAt = 0;
    }

    return nextState;
  }

  function getUserStrikeState(userId, { now = Date.now() } = {}) {
    const id = String(userId || "").trim();
    const safeNow = normalizeStrikeTimestamp(now) || Date.now();
    if (!id) {
      return {
        ...createEmptyUserStrikeState(),
        evaluatedAt: safeNow,
      };
    }

    const rows = db
      .prepare(
        `
          SELECT strike_delta, created_at, id
          FROM user_strikes
          WHERE user_id=?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(id);

    let state = createEmptyUserStrikeState();
    for (const row of rows) {
      state = applyStrikeDeltaToState(state, row?.strike_delta, row?.created_at);
    }

    return advanceUserStrikeState(state, safeNow);
  }

  function getUserStrikeStatesByUserIds(userIds, { now = Date.now() } = {}) {
    const ids = Array.from(
      new Set(
        (Array.isArray(userIds) ? userIds : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    );
    const safeNow = normalizeStrikeTimestamp(now) || Date.now();
    const states = new Map();

    for (const id of ids) {
      states.set(id, createEmptyUserStrikeState());
    }

    if (!ids.length) {
      return states;
    }

    const chunkSize = 400;
    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `
            SELECT user_id, strike_delta, created_at, id
            FROM user_strikes
            WHERE user_id IN (${placeholders})
            ORDER BY user_id ASC, created_at ASC, id ASC
          `,
        )
        .all(...chunk);

      for (const row of rows) {
        const rowUserId = String(row?.user_id || "").trim();
        states.set(
          rowUserId,
          applyStrikeDeltaToState(
            states.get(rowUserId),
            row?.strike_delta,
            row?.created_at,
          ),
        );
      }
    }

    for (const [id, state] of states.entries()) {
      states.set(id, advanceUserStrikeState(state, safeNow));
    }

    return states;
  }

  function getUserStrikeCount(userId) {
    return Math.max(0, Number(getUserStrikeState(userId)?.currentStrikeCount || 0));
  }

  function getStrikeSourceLabelForReport(report) {
    const meta = tryJson(report?.meta_json) || report?.meta || {};
    return meta?.source === "command_history"
      ? "Command history report"
      : "Control link report";
  }

  function filterExistingNotificationUserIds(userIds) {
    const ids = Array.from(
      new Set(
        (Array.isArray(userIds) ? userIds : [])
          .map((id) => String(id || "").trim())
          .filter(Boolean),
      ),
    );

    if (!ids.length) return [];

    const chunkSize = 400;
    const existing = new Set();

    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT discord_id FROM users WHERE discord_id IN (${placeholders})`)
        .all(...chunk);

      for (const row of rows) {
        existing.add(String(row.discord_id || "").trim());
      }
    }

    return ids.filter((id) => existing.has(id));
  }

  function createNotificationsForUsers({
    userIds,
    kind = "system",
    title,
    message,
    actionUrl = null,
    actionLabel = null,
    meta = {},
    createdBy = null,
    sourceType = null,
    sourceId = null,
  }) {
    const recipients = filterExistingNotificationUserIds(userIds);
    const normalizedTitle = normalizeNotificationTitle(title);
    const normalizedMessage = normalizeNotificationMessage(message);
    const normalizedActionUrl = normalizeNotificationActionUrl(actionUrl);
    const normalizedActionLabel = normalizeNotificationActionLabel(actionLabel);

    if (!normalizedTitle) {
      throw new Error("Notification title is required.");
    }
    if (!normalizedMessage) {
      throw new Error("Notification message is required.");
    }
    if (!recipients.length) {
      return { count: 0, recipients: [] };
    }

    const now = Date.now();
    const safeKind = normalizeNotificationKind(kind);
    const safeCreatedBy = String(createdBy || "").trim() || null;
    const safeSourceType = String(sourceType || "").trim() || null;
    const safeSourceId = String(sourceId || "").trim() || null;
    const safeMetaJson = serializeNotificationMeta(meta);
    const safeActionLabel = normalizedActionUrl
      ? normalizedActionLabel || "Open"
      : null;

    const tx = db.transaction((ids) => {
      for (const uid of ids) {
        insertNotificationRow.run(
          crypto.randomUUID(),
          uid,
          safeKind,
          normalizedTitle,
          normalizedMessage,
          normalizedActionUrl,
          safeActionLabel,
          safeMetaJson,
          now,
          safeCreatedBy,
          safeSourceType,
          safeSourceId,
        );
      }
    });

    tx(recipients);

    return { count: recipients.length, recipients };
  }

  function createStrikeNotification({
    userId,
    strikeDelta,
    finalStrikeCount,
    reasonLabel = "",
    createdByUserId = null,
    sourceType = "user_strike",
    sourceId = null,
    reportId = null,
  }) {
    const targetUserId = String(userId || "").trim();
    const delta = Math.trunc(Number(strikeDelta || 0));
    if (!targetUserId || !Number.isFinite(delta) || delta <= 0) {
      return { count: 0, recipients: [] };
    }

    const safeFinalStrikeCount = Math.max(
      0,
      Math.trunc(Number(finalStrikeCount || 0)),
    );
    const safeReasonLabel = String(reasonLabel || "").trim();
    let message = `You received ${formatCountLabel(delta, "strike")}.`;

    message += ` You now have ${safeFinalStrikeCount}/${MAX_USER_STRIKES} strikes.`;
    if (safeReasonLabel) {
      message += ` Reason: ${safeReasonLabel}.`;
    }
    if (safeFinalStrikeCount >= MAX_USER_STRIKES) {
      message += ` This reached the ${MAX_USER_STRIKES}-strike limit.`;
    }

    return createNotificationsForUsers({
      userIds: [targetUserId],
      kind: "strike",
      title: delta === 1 ? "Strike received" : "Strikes received",
      message,
      actionUrl: "/profile/strikes",
      actionLabel: "View details",
      meta: {
        strikeDelta: delta,
        finalStrikeCount: safeFinalStrikeCount,
        maxUserStrikes: MAX_USER_STRIKES,
        reasonLabel: safeReasonLabel || null,
        reportId: String(reportId || "").trim() || null,
      },
      createdBy: String(createdByUserId || "").trim() || null,
      sourceType: String(sourceType || "").trim() || "user_strike",
      sourceId: String(sourceId || "").trim() || null,
    });
  }

  function formatCommandLikeTitle({ sourceKind, likeCount }) {
    const count = Math.max(1, Number(likeCount || 1) || 1);
    if (sourceKind === "group") {
      return `You received ${count} ${count === 1 ? "like" : "likes"}!`;
    }
    return count === 1 ? "Command liked" : "Commands liked";
  }

  function formatCommandLikeMessage({
    sourceKind,
    likeCount,
    likerDisplayName,
    groupLabel,
  }) {
    const count = Math.max(1, Number(likeCount || 1) || 1);
    if (sourceKind === "group") {
      return `You received ${count} ${count === 1 ? "like" : "likes"}!`;
    }

    const displayName = normalizeControlLinkDisplayName(likerDisplayName) ||
      String(likerDisplayName || "").trim() ||
      "Someone";
    return count === 1
      ? `${displayName} liked your command!`
      : `${displayName} liked ${count} commands!`;
  }

  function upsertCommandLikeNotification({
    likedUserId,
    likerUserId,
    likerDisplayName = "",
    sourceKind = "direct",
    sourceId = null,
    groupLabel = "",
    actionUrl = null,
    eventId = null,
  } = {}) {
    const targetUserId = String(likedUserId || "").trim();
    if (!targetUserId) return { count: 0, recipients: [] };
    const recipients = filterExistingNotificationUserIds([targetUserId]);
    if (!recipients.length) return { count: 0, recipients: [] };

    const safeSourceKind =
      String(sourceKind || "").trim() === "group" ? "group" : "direct";
    const safeSourceId = String(sourceId || "").trim() ||
      (safeSourceKind === "group" ? "unknown_group" : String(likerUserId || "").trim());
    const sourceType = safeSourceKind === "group"
      ? "command_like_group"
      : "command_like_direct";
    const sourceIdForNotification = safeSourceId || "unknown";
    const kind = "command_like";
    const now = Date.now();
    const createdBy = String(likerUserId || "").trim() || null;
    const normalizedActionUrl = normalizeNotificationActionUrl(actionUrl);
    const actionLabel = normalizedActionUrl
      ? safeSourceKind === "group"
        ? "Open group"
        : "Open control link"
      : null;

    const rows = selectUnreadNotificationRowsBySource.all(
      targetUserId,
      kind,
      sourceType,
      sourceIdForNotification,
    );
    const existing = rows[0] || null;
    const existingMeta = existing ? tryJson(existing.meta_json) || {} : {};
    const nextLikeCount =
      Math.max(0, Number(existingMeta.likeCount || existingMeta.count || 0) || 0) + 1;
    const meta = {
      source: "command_history_like",
      sourceKind: safeSourceKind,
      likeCount: nextLikeCount,
      likerUserId: String(likerUserId || "").trim() || null,
      likerDisplayName: String(likerDisplayName || "").trim() || null,
      groupKey: safeSourceKind === "group" ? safeSourceId : null,
      groupLabel: String(groupLabel || "").trim() || null,
      latestEventId: String(eventId || "").trim() || null,
    };
    const title = formatCommandLikeTitle({
      sourceKind: safeSourceKind,
      likeCount: nextLikeCount,
    });
    const message = formatCommandLikeMessage({
      sourceKind: safeSourceKind,
      likeCount: nextLikeCount,
      likerDisplayName,
      groupLabel,
    });

    if (existing) {
      for (let index = 1; index < rows.length; index += 1) {
        deleteNotificationById.run(rows[index].id);
      }

      updateNotificationRow.run(
        normalizeNotificationTitle(title),
        normalizeNotificationMessage(message),
        normalizedActionUrl,
        actionLabel,
        serializeNotificationMeta(meta),
        now,
        createdBy,
        existing.id,
      );

      return {
        count: 1,
        recipients,
        notificationId: existing.id,
        likeCount: nextLikeCount,
      };
    }

    const notificationId = crypto.randomUUID();
    insertNotificationRow.run(
      notificationId,
      targetUserId,
      kind,
      normalizeNotificationTitle(title),
      normalizeNotificationMessage(message),
      normalizedActionUrl,
      actionLabel,
      serializeNotificationMeta(meta),
      now,
      createdBy,
      sourceType,
      sourceIdForNotification,
    );

    return {
      count: 1,
      recipients,
      notificationId,
      likeCount: nextLikeCount,
    };
  }

  function insertUserStrikeEntry({
    userId,
    strikeDelta,
    reasonLabel,
    sourceLabel = "",
    details = "",
    sourceType = "manual_adjustment",
    sourceId = null,
    reportId = null,
    createdByUserId = null,
    meta = {},
  }) {
    const targetUserId = String(userId || "").trim();
    const delta = Number(strikeDelta || 0);
    if (!targetUserId || !Number.isFinite(delta) || delta === 0) {
      return null;
    }

    const row = {
      id: crypto.randomUUID(),
      userId: targetUserId,
      strikeDelta: Math.trunc(delta),
      reasonLabel: String(reasonLabel || "").trim() || "Moderation update",
      sourceLabel: String(sourceLabel || "").trim() || null,
      details: normalizeReportDetails(details),
      sourceType: String(sourceType || "").trim() || "manual_adjustment",
      sourceId: String(sourceId || "").trim() || null,
      reportId: String(reportId || "").trim() || null,
      meta: meta || {},
      createdAt: Date.now(),
      createdByUserId: String(createdByUserId || "").trim() || null,
    };

    insertUserStrikeRow.run(
      row.id,
      row.userId,
      row.strikeDelta,
      row.reasonLabel,
      row.sourceLabel,
      row.details || null,
      row.sourceType,
      row.sourceId,
      row.reportId,
      serializeNotificationMeta(row.meta),
      row.createdAt,
      row.createdByUserId,
    );

    return row;
  }

  function ensureUserBannedForStrikes(
    targetUserId,
    bannedByUserId,
    { req = null, strikeCount = MAX_USER_STRIKES } = {},
  ) {
    const userId = String(targetUserId || "").trim();
    if (!userId) return { ok: false, banned: false };

    const existing = db
      .prepare(`SELECT discord_id FROM bans WHERE discord_id=? LIMIT 1`)
      .get(userId);
    if (existing) {
      return { ok: true, banned: false, alreadyBanned: true };
    }

    const reason = `Reached ${MAX_USER_STRIKES} strikes.`;
    const actorUserId = String(bannedByUserId || "").trim() || "system";
    const createdAt = Date.now();

    db.prepare(
      `
        INSERT INTO bans (discord_id, reason, banned_by, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET
          reason=excluded.reason,
          banned_by=excluded.banned_by,
          created_at=excluded.created_at
      `,
    ).run(userId, reason, actorUserId, createdAt);

    logEvent({
      type: "user_banned",
      actorUserId,
      targetUserId: userId,
      req,
      payload: {
        reason,
        auto: true,
        byStrikes: true,
        strikeCount: Number(strikeCount || MAX_USER_STRIKES),
      },
    });

    return {
      ok: true,
      banned: true,
      alreadyBanned: false,
      reason,
      bannedAt: createdAt,
    };
  }

  function setUserStrikeCountByAdmin(
    targetUserId,
    targetStrikeCount,
    actorUserId,
    { req = null } = {},
  ) {
    const userId = String(targetUserId || "").trim();
    const adminUserId = String(actorUserId || "").trim();
    const desiredStrikeCount = normalizeStrikeCount(targetStrikeCount);

    if (!userId) {
      return { ok: false, code: "not_found", message: "User not found." };
    }
    if (!adminUserId) {
      return { ok: false, code: "not_allowed", message: "Admin required." };
    }
    if (desiredStrikeCount === null) {
      return {
        ok: false,
        code: "bad_strike_count",
        message: `Strike count must be between 0 and ${MAX_USER_STRIKES}.`,
      };
    }

    const userRow = db
      .prepare(`SELECT discord_id FROM users WHERE discord_id=? LIMIT 1`)
      .get(userId);
    if (!userRow) {
      return { ok: false, code: "not_found", message: "User not found." };
    }

    const previousStrikeCount = getUserStrikeCount(userId);
    const strikeDelta = desiredStrikeCount - previousStrikeCount;
    let banResult = { banned: false, alreadyBanned: false };

    const tx = db.transaction(() => {
      if (strikeDelta !== 0) {
        insertUserStrikeEntry({
          userId,
          strikeDelta,
          reasonLabel: "Admin adjustment",
          sourceLabel:
            strikeDelta > 0
              ? "Manual moderation increase"
              : "Manual moderation reduction",
          details:
            strikeDelta > 0
              ? "An admin increased your strike total."
              : "An admin reduced your strike total.",
          sourceType: "admin_adjustment",
          sourceId: crypto.randomUUID(),
          createdByUserId: adminUserId,
          meta: {
            previousStrikeCount,
            finalStrikeCount: desiredStrikeCount,
          },
        });

        if (strikeDelta > 0) {
          createStrikeNotification({
            userId,
            strikeDelta,
            finalStrikeCount: desiredStrikeCount,
            reasonLabel: "Admin adjustment",
            createdByUserId: adminUserId,
            sourceType: "admin_adjustment",
          });
        }
      }

      if (desiredStrikeCount >= MAX_USER_STRIKES) {
        banResult = ensureUserBannedForStrikes(userId, adminUserId, {
          req,
          strikeCount: desiredStrikeCount,
        });
      }
    });

    try {
      tx();
    } catch (err) {
      console.warn("[strikes] admin set failed:", err?.message || err);
      return {
        ok: false,
        code: "save_failed",
        message: "Could not update strikes.",
      };
    }

    logEvent({
      type: "admin_set_user_strikes",
      actorUserId: adminUserId,
      targetUserId: userId,
      req,
      payload: {
        previousStrikeCount,
        finalStrikeCount: desiredStrikeCount,
        strikeDelta,
        autoBanned: !!banResult?.banned,
      },
    });

    return {
      ok: true,
      previousStrikeCount,
      finalStrikeCount: desiredStrikeCount,
      strikeDelta,
      changed: strikeDelta !== 0,
      didBan: !!banResult?.banned,
      alreadyBanned: !!banResult?.alreadyBanned,
    };
  }

  function serializeUserStrikeRow(row) {
    const createdAt = Number(row?.created_at || 0);
    const strikeDelta = Number(row?.strike_delta || 0);
    const createdByUserId = String(row?.created_by || "").trim();
    const createdByDisplayName =
      normalizeControlLinkDisplayName(row?.created_by_control_link_display_name) ||
      String(row?.created_by_global_name || "").trim() ||
      String(row?.created_by_username || "").trim() ||
      createdByUserId ||
      "";

    return {
      id: String(row?.id || "").trim(),
      strikeDelta,
      strikeDeltaLabel:
        strikeDelta > 0 ? `+${strikeDelta}` : strikeDelta < 0 ? `${strikeDelta}` : "0",
      strikeDeltaSummary:
        strikeDelta > 0
          ? `${formatCountLabel(strikeDelta, "strike")} added`
          : strikeDelta < 0
            ? `${formatCountLabel(Math.abs(strikeDelta), "strike")} removed`
            : "No strike change",
      reasonLabel: String(row?.reason_label || "").trim() || "Moderation update",
      sourceLabel: String(row?.source_label || "").trim(),
      details: String(row?.details || "").trim(),
      sourceType: String(row?.source_type || "").trim(),
      sourceId: String(row?.source_id || "").trim(),
      reportId: String(row?.report_id || "").trim(),
      meta: tryJson(row?.meta_json) || {},
      createdAt,
      createdIso: createdAt ? new Date(createdAt).toISOString() : "",
      createdLabel: formatNotificationTimeLabel(createdAt),
      createdByUserId,
      createdByDisplayName,
    };
  }

  function listUserStrikeHistory(userId, limit = PROFILE_STRIKE_HISTORY_LIMIT) {
    const id = String(userId || "").trim();
    if (!id) return [];

    const rows = db
      .prepare(
        `
          SELECT
            s.id,
            s.strike_delta,
            s.reason_label,
            s.source_label,
            s.details,
            s.source_type,
            s.source_id,
            s.report_id,
            s.meta_json,
            s.created_at,
            s.created_by,
            creator.username AS created_by_username,
            creator.global_name AS created_by_global_name,
            creator.control_link_display_name AS created_by_control_link_display_name
          FROM user_strikes s
          LEFT JOIN users creator
            ON creator.discord_id = s.created_by
          WHERE s.user_id=?
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ?
        `,
      )
      .all(
        id,
        Math.max(
          1,
          Math.min(
            Number(limit || 0) || PROFILE_STRIKE_HISTORY_LIMIT,
            PROFILE_STRIKE_HISTORY_LIMIT,
          ),
        ),
      );

    return rows.map(serializeUserStrikeRow);
  }

  function serializeNotificationRow(row) {
    const createdAt = Number(row?.created_at || 0);
    const readAt = Number(row?.read_at || 0);
    return {
      id: String(row?.id || "").trim(),
      userId: String(row?.user_id || "").trim(),
      kind: normalizeNotificationKind(row?.kind),
      title: String(row?.title || "").trim(),
      message: String(row?.message || "").trim(),
      actionUrl: normalizeNotificationActionUrl(row?.action_url),
      actionLabel: normalizeNotificationActionLabel(row?.action_label),
      meta: tryJson(row?.meta_json) || {},
      createdAt,
      createdIso: createdAt ? new Date(createdAt).toISOString() : "",
      createdLabel: formatNotificationTimeLabel(createdAt),
      readAt: readAt || null,
      isUnread: !readAt,
    };
  }

  function listNotificationsForUser(
    userId,
    { limit = NOTIFICATION_PAGE_LIMIT } = {},
  ) {
    const uid = String(userId || "").trim();
    const max = Math.max(
      1,
      Math.min(Number(limit || 0) || NOTIFICATION_PAGE_LIMIT, 500),
    );
    if (!uid) return [];

    const rows = db
      .prepare(
        `
          SELECT
            id, user_id, kind, title, message,
            action_url, action_label, meta_json,
            created_at, read_at
          FROM notifications
          WHERE user_id=?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
      )
      .all(uid, max);

    return rows.map(serializeNotificationRow);
  }

  function countNotificationsForUser(userId) {
    const uid = String(userId || "").trim();
    if (!uid) return 0;

    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id=?`)
      .get(uid);
    return Number(row?.n || 0);
  }

  function countUnreadNotificationsForUser(userId) {
    const uid = String(userId || "").trim();
    if (!uid) return 0;

    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL`,
      )
      .get(uid);
    return Number(row?.n || 0);
  }

  function getNotificationSummaryForUser(
    userId,
    { limit = NOTIFICATION_MENU_LIMIT } = {},
  ) {
    return {
      items: listNotificationsForUser(userId, { limit }),
      unreadCount: countUnreadNotificationsForUser(userId),
      totalCount: countNotificationsForUser(userId),
    };
  }

  function broadcastNotificationToAllUsers(input) {
    const recipients = db
      .prepare(`SELECT discord_id FROM users ORDER BY created_at DESC, discord_id ASC`)
      .all()
      .map((row) => String(row.discord_id || "").trim())
      .filter(Boolean);

    return createNotificationsForUsers({
      ...input,
      userIds: recipients,
    });
  }

  function markAllNotificationsReadForUser(userId) {
    const uid = String(userId || "").trim();
    if (!uid) return 0;

    const info = db
      .prepare(
        `UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL`,
      )
      .run(Date.now(), uid);
    return Number(info?.changes || 0);
  }

  function clearNotificationForUser(userId, notificationId) {
    const uid = String(userId || "").trim();
    const id = String(notificationId || "").trim();
    if (!uid || !id) return 0;

    const info = db
      .prepare(`DELETE FROM notifications WHERE user_id=? AND id=?`)
      .run(uid, id);
    return Number(info?.changes || 0);
  }

  function clearAllNotificationsForUser(userId) {
    const uid = String(userId || "").trim();
    if (!uid) return 0;

    const info = db.prepare(`DELETE FROM notifications WHERE user_id=?`).run(uid);
    return Number(info?.changes || 0);
  }

  function listAdminUserIds() {
    return db
      .prepare(`SELECT discord_id FROM admins ORDER BY created_at ASC, discord_id ASC`)
      .all()
      .map((row) => String(row.discord_id || "").trim())
      .filter(Boolean);
  }

  function formatAdminReportQueueTitle(reportCount) {
    const count = Math.max(1, Number(reportCount || 1) || 1);
    return count === 1 ? "New report" : "New reports";
  }

  function formatAdminReportQueueMessage(reportCount) {
    const count = Math.max(1, Number(reportCount || 1) || 1);
    return count === 1
      ? "There is 1 new report to review."
      : `There are ${count} new reports to review.`;
  }

  function markAdminReportQueueNotificationsReadForUser(userId) {
    const uid = String(userId || "").trim();
    if (!uid) return 0;

    const info = db
      .prepare(
        `
          UPDATE notifications
          SET read_at=?
          WHERE user_id=?
            AND kind=?
            AND source_type=?
            AND source_id=?
            AND read_at IS NULL
        `,
      )
      .run(
        Date.now(),
        uid,
        ADMIN_REPORT_QUEUE_KIND,
        ADMIN_REPORT_QUEUE_SOURCE_TYPE,
        ADMIN_REPORT_QUEUE_SOURCE_ID,
      );

    return Number(info?.changes || 0);
  }

  function deliverReportViaAdminNotifications(report) {
    const recipients = filterExistingNotificationUserIds(listAdminUserIds());
    if (!recipients.length) {
      return { channel: "admin_notifications", count: 0, recipients: [] };
    }

    const now = Date.now();
    const safeCreatedBy = String(report?.reporterUserId || "").trim() || null;
    const actionUrl = "/admin/reports";
    const actionLabel = "Review";

    const tx = db.transaction((userIds) => {
      for (const userId of userIds) {
        const rows = selectUnreadAdminQueueRows.all(
          userId,
          ADMIN_REPORT_QUEUE_KIND,
          ADMIN_REPORT_QUEUE_SOURCE_TYPE,
          ADMIN_REPORT_QUEUE_SOURCE_ID,
        );

        const existing = rows[0] || null;
        const existingMeta = existing ? tryJson(existing.meta_json) || {} : {};
        const nextReportCount = Math.max(
          1,
          Number(existingMeta.reportCount || existingMeta.count || 1) || 1,
        ) + (existing ? 1 : 0);
        const meta = {
          reportCount: nextReportCount,
          latestReportId: String(report?.id || "").trim() || null,
          lastReporterUserId: safeCreatedBy,
          source: "control_link_reports",
        };

        if (existing) {
          for (let index = 1; index < rows.length; index += 1) {
            deleteNotificationById.run(rows[index].id);
          }

          updateNotificationRow.run(
            formatAdminReportQueueTitle(nextReportCount),
            formatAdminReportQueueMessage(nextReportCount),
            actionUrl,
            actionLabel,
            serializeNotificationMeta(meta),
            now,
            safeCreatedBy,
            existing.id,
          );
          continue;
        }

        insertNotificationRow.run(
          crypto.randomUUID(),
          userId,
          ADMIN_REPORT_QUEUE_KIND,
          formatAdminReportQueueTitle(1),
          formatAdminReportQueueMessage(1),
          actionUrl,
          actionLabel,
          serializeNotificationMeta(meta),
          now,
          safeCreatedBy,
          ADMIN_REPORT_QUEUE_SOURCE_TYPE,
          ADMIN_REPORT_QUEUE_SOURCE_ID,
        );
      }
    });

    tx(recipients);

    return {
      channel: "admin_notifications",
      count: recipients.length,
      recipients,
    };
  }

  function dispatchReport(report) {
    return [deliverReportViaAdminNotifications(report)];
  }

  return {
    broadcastNotificationToAllUsers,
    clearAllNotificationsForUser,
    clearNotificationForUser,
    countNotificationsForUser,
    countUnreadNotificationsForUser,
    createNotificationsForUsers,
    createStrikeNotification,
    dispatchReport,
    ensureUserBannedForStrikes,
    formatCountLabel,
    formatNotificationTimeLabel,
    getNotificationSummaryForUser,
    getReportReasonOption,
    getStrikeSourceLabelForReport,
    getUserStrikeCount,
    getUserStrikeState,
    getUserStrikeStatesByUserIds,
    listNotificationsForUser,
    listUserStrikeHistory,
    markAdminReportQueueNotificationsReadForUser,
    markAllNotificationsReadForUser,
    normalizeNotificationActionLabel,
    normalizeNotificationActionUrl,
    normalizeNotificationMessage,
    normalizeNotificationKind,
    normalizeNotificationTitle,
    normalizeReportDetails,
    normalizeReportSubjectType,
    normalizeStrikeCount,
    serializeNotificationMeta,
    setUserStrikeCountByAdmin,
    upsertCommandLikeNotification,
    insertUserStrikeEntry,
  };
}

module.exports = {
  createNotificationService,
};
