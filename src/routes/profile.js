function registerProfileRoutes(app, deps) {
  const {
    API_MIN_COMMANDS,
    CONTROL_LINK_THEME_OPTIONS,
    CUSTOM_CONTROL_URL_MAX_LEN,
    CUSTOM_CONTROL_URL_MIN_COMMANDS,
    CUSTOM_CONTROL_URL_MIN_LEN,
    MAX_USER_STRIKES,
    PAIR_CODE_RESET_COOLDOWN_MS,
    WHITELIST_SEARCH_MIN_LEN,
    WebSocket,
    buildCustomControlUrl,
    canChangeCustomControlUrl,
    clearQueuedCommandsForUser,
    clientPairingCredentials,
    createNotificationsForUsers,
    db,
    ensurePairCode,
    ensureUserApiKeyExists,
    formatDateTimeLabel,
    gen6,
    genApiKey,
    getAboutMe,
    getApiKeyMeta,
    getCatalogItems,
    getCommandsSentTotal,
    getPairCodeResetNextAllowedAt,
    getPairCodeResetState,
    getProfileFlash,
    getUserPresenceState,
    getUserSelections,
    getUserStrikeState,
    getWhitelist,
    getPreferredDisplayName,
    hashApiKey,
    hmac,
    isDiscordId,
    isDeviceOnline,
    isValidCustomControlSlug,
    listUserStrikeHistory,
    logEvent,
    normalizeControlLinkDisplayName,
    normalizeControlLinkTheme,
    normalizeCustomControlSlug,
    normalizeWhitelistSearchQuery,
    renderWithLayout,
    requireDiscord,
    requireNotBanned,
    searchWhitelistUsers,
    siteAvatarUrl,
    setAboutMe,
    setUserItem,
    unpairAllDevicesForUser,
    wantsJson,
    wsByDeviceId,
  } = deps;

function getActorUser(req) {
  return req.actorUser || req.viewUser || req.user || null;
}

function getActorUserId(req) {
  return String(getActorUser(req)?.discord_id || "").trim();
}

function getEffectiveUserId(req) {
  return String(req.user?.discord_id || "").trim();
}

function getFriendPair(userId, friendId) {
  const a = String(userId || "").trim();
  const b = String(friendId || "").trim();
  if (!a || !b || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

function getUserDisplayName(userLike) {
  return String(
    userLike?.global_name ||
      userLike?.globalName ||
      userLike?.username ||
      userLike?.discord_id ||
      userLike?.discordId ||
      "",
  ).trim();
}

function notifyUsers(opts) {
  if (typeof createNotificationsForUsers !== "function") return;
  try {
    createNotificationsForUsers(opts);
  } catch (e) {
    console.warn("[friends] notification failed:", e?.message || e);
  }
}

function normalizeFriendUserItem(userLike, viewerId) {
  const discordId = String(
    userLike?.discord_id || userLike?.friend_id || userLike?.sub_user_id || "",
  ).trim();
  if (!discordId) return null;

  const displayName = getUserDisplayName(userLike) || discordId;
  const status = String(userLike?.status || "").trim();
  const requestedBy = String(userLike?.requested_by || "").trim();

  return {
    discordId,
    username: String(userLike?.username || "").trim(),
    globalName: String(userLike?.global_name || "").trim(),
    displayName,
    avatarUrl: siteAvatarUrl
      ? siteAvatarUrl({ discord_id: discordId }, 64)
      : "/default-avatar.svg",
    status,
    requestedBy,
    incoming: status === "pending" && requestedBy && requestedBy !== viewerId,
    outgoing: status === "pending" && requestedBy === viewerId,
    friends: status === "accepted",
    leashGivenToThem: !!Number(userLike?.leash_given_to_them || 0),
    leashGivenToMe: !!Number(userLike?.leash_given_to_me || 0),
    canControl: !!Number(userLike?.leash_given_to_me || 0),
    createdAt: Number(userLike?.created_at || 0) || 0,
    updatedAt: Number(userLike?.updated_at || 0) || 0,
  };
}

function listFriendItems(userId) {
  const safeUserId = String(userId || "").trim();
  if (!safeUserId) return [];

  return db
    .prepare(
      `
        SELECT
          CASE WHEN f.user_a_id = @userId THEN f.user_b_id ELSE f.user_a_id END AS discord_id,
          u.username,
          u.global_name,
          f.status,
          f.requested_by,
          f.created_at,
          f.updated_at,
          CASE
            WHEN ld_out.sub_user_id IS NOT NULL THEN 1
            ELSE 0
          END AS leash_given_to_them,
          CASE
            WHEN ld_in.sub_user_id IS NOT NULL THEN 1
            ELSE 0
          END AS leash_given_to_me
        FROM friendships f
        JOIN users u ON u.discord_id = CASE
          WHEN f.user_a_id = @userId THEN f.user_b_id
          ELSE f.user_a_id
        END
        LEFT JOIN leash_delegations ld_out
          ON ld_out.sub_user_id = @userId
          AND ld_out.dom_user_id = u.discord_id
        LEFT JOIN leash_delegations ld_in
          ON ld_in.sub_user_id = u.discord_id
          AND ld_in.dom_user_id = @userId
        WHERE f.user_a_id = @userId OR f.user_b_id = @userId
        ORDER BY
          CASE
            WHEN f.status = 'pending' AND f.requested_by != @userId THEN 0
            WHEN f.status = 'accepted' THEN 1
            ELSE 2
          END ASC,
          f.updated_at DESC
      `,
    )
    .all({ userId: safeUserId })
    .map((row) => normalizeFriendUserItem(row, safeUserId))
    .filter(Boolean);
}

function searchFriendUsers(userId, rawQuery) {
  const query = normalizeWhitelistSearchQuery(rawQuery);
  if (query.length < WHITELIST_SEARCH_MIN_LEN) return [];

  const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
  const like = `%${escapedQuery}%`;
  const starts = `${escapedQuery}%`;

  return db
    .prepare(
      `
        SELECT
          u.discord_id,
          u.username,
          u.global_name,
          f.status,
          f.requested_by
        FROM users u
        LEFT JOIN friendships f
          ON (
            f.user_a_id = CASE WHEN @userId < u.discord_id THEN @userId ELSE u.discord_id END
            AND f.user_b_id = CASE WHEN @userId < u.discord_id THEN u.discord_id ELSE @userId END
          )
        WHERE u.discord_id != @userId
          AND (
            u.discord_id LIKE @like ESCAPE '\\'
            OR IFNULL(u.username, '') LIKE @like ESCAPE '\\'
            OR IFNULL(u.global_name, '') LIKE @like ESCAPE '\\'
          )
        ORDER BY
          CASE
            WHEN u.discord_id = @exact THEN 0
            WHEN LOWER(IFNULL(u.username, '')) = LOWER(@exact) THEN 1
            WHEN LOWER(IFNULL(u.global_name, '')) = LOWER(@exact) THEN 2
            WHEN LOWER(IFNULL(u.username, '')) LIKE LOWER(@starts) ESCAPE '\\' THEN 3
            WHEN LOWER(IFNULL(u.global_name, '')) LIKE LOWER(@starts) ESCAPE '\\' THEN 4
            ELSE 5
          END ASC,
          u.global_name COLLATE NOCASE ASC,
          u.username COLLATE NOCASE ASC
        LIMIT 8
      `,
    )
    .all({
      userId,
      like,
      starts,
      exact: escapedQuery,
    })
    .map((row) => normalizeFriendUserItem(row, userId))
    .filter(Boolean);
}

function areAcceptedFriends(userId, friendId) {
  const pair = getFriendPair(userId, friendId);
  if (!pair) return false;
  const row = db
    .prepare(
      `
        SELECT status
        FROM friendships
        WHERE user_a_id=? AND user_b_id=? AND status='accepted'
      `,
    )
    .get(pair[0], pair[1]);
  return !!row;
}

function getActiveLeashForSub(userId) {
  const safeUserId = String(userId || "").trim();
  if (!safeUserId) return null;
  return (
    db
      .prepare(
        `
          SELECT ld.sub_user_id, ld.dom_user_id, ld.created_at,
                 u.username, u.global_name
          FROM leash_delegations ld
          JOIN users u ON u.discord_id = ld.dom_user_id
          WHERE ld.sub_user_id=?
        `,
      )
      .get(safeUserId) || null
  );
}

function requireDirectProfileOwner(req, res, next) {
  if (!req.delegatedUser) return next();
  return res.status(403).json({
    ok: false,
    message: "Friend and control permissions can only be changed by the account owner.",
  });
}

app.get("/profile", requireDiscord, requireNotBanned, (req, res) => {
  const actorUser = getActorUser(req);
  const isDelegatedProfile = !!req.delegatedUser;
  const actorDisplayName = actorUser
    ? (getPreferredDisplayName
      ? getPreferredDisplayName(actorUser)
      : getUserDisplayName(actorUser))
    : "";

  res.locals.actorUser = actorUser;
  res.locals.isDelegatedProfile = isDelegatedProfile;
  res.locals.delegatedSubUser = req.delegatedUser || null;
  res.locals.delegatedActorDisplayName = actorDisplayName;
  res.locals.canManageAccountSecurity = !isDelegatedProfile;
  res.locals.canManageFriends = !isDelegatedProfile;
  res.locals.user = req.user;
  res.locals.displayName = getPreferredDisplayName
    ? getPreferredDisplayName(req.user)
    : getUserDisplayName(req.user);
  res.locals.avatarUrl = siteAvatarUrl
    ? siteAvatarUrl(req.user, 64)
    : "/default-avatar.svg";

  const code = ensurePairCode(req.user.discord_id);
  res.locals.code = code;
  res.locals.pairCode = code;
  res.locals.fullControlUrl = `https://playctrl.me/device/${code}`;
  res.locals.profileFlash = getProfileFlash(req.query);
  res.locals.profileFlashIsError = !!res.locals.profileFlash?.isError;

  res.locals.catalog = getCatalogItems();
  res.locals.selections = getUserSelections(req.user.discord_id);

  res.locals.isDiscoverOn = !!req.user.discoverable;

  const settingsRow = db
    .prepare(
      `
      SELECT
        whitelist_enabled,
        disable_custom_backgrounds,
        exclude_from_leaderboards,
        custom_control_slug,
        custom_control_slug_updated_at,
        away_enabled,
        last_online_at,
        control_link_theme,
        control_link_display_name,
        custom_banner_path,
        custom_banner_updated_at,
        custom_background_path,
        custom_background_updated_at,
        custom_avatar_path,
        custom_avatar_updated_at,
        avatar_cache_updated_at
      FROM users
      WHERE discord_id=?
    `,
    )
    .get(req.user.discord_id);
  const ownerUser = {
    ...(req.user || {}),
    ...(settingsRow || {}),
  };
  res.locals.ownerId = req.user.discord_id;
  res.locals.ownerUser = ownerUser;
  res.locals.controlLinkTheme = normalizeControlLinkTheme(
    ownerUser.control_link_theme,
  );
  res.locals.controlLinkThemeOptions = CONTROL_LINK_THEME_OPTIONS;
  res.locals.controlLinkCustomName =
    normalizeControlLinkDisplayName(ownerUser.control_link_display_name) || "";
  res.locals.controlLinkDisplayName =
    res.locals.controlLinkCustomName ||
    ownerUser.global_name ||
    ownerUser.username ||
    req.user.discord_id;
  res.locals.controlLinkHasCustomAvatar = !!String(
    ownerUser.custom_avatar_path || "",
  ).trim();
  res.locals.controlLinkAvatarVersion = Number(
    ownerUser.custom_avatar_updated_at ||
      ownerUser.avatar_cache_updated_at ||
      0,
  );
  res.locals.controlLinkHasCustomBanner = !!String(
    ownerUser.custom_banner_path || "",
  ).trim();
  res.locals.controlLinkBannerVersion = Number(
    ownerUser.custom_banner_updated_at || 0,
  );
  res.locals.controlLinkHasCustomBackground = !!String(
    ownerUser.custom_background_path || "",
  ).trim();
  res.locals.controlLinkBackgroundVersion = Number(
    ownerUser.custom_background_updated_at || 0,
  );

  const devices = db
    .prepare(
      `
      SELECT
        dp.device_id,
        dp.device_name,
        dp.auth_level,
        dp.verified_at,
        d.last_seen_at
      FROM device_pairs dp
      JOIN devices_v2 d ON d.device_id = dp.device_id
      WHERE dp.user_id = ?
      ORDER BY d.last_seen_at DESC
    `,
    )
    .all(req.user.discord_id);
  const presence = getUserPresenceState(req.user.discord_id, {
    deviceIds: devices.map((device) => device.device_id),
  });
  res.locals.anyOnline = !!presence.online;
  res.locals.currentPresenceStatus = presence.status;
  res.locals.awayModeEnabled = !!settingsRow?.away_enabled;
  res.locals.awayUntil = Number(presence.awayUntil || 0);
  res.locals.awayUntilLabel = presence.status !== "offline" && presence.awayUntil
    ? formatDateTimeLabel(presence.awayUntil)
    : "";

  res.locals.isWhitelistOn = !!settingsRow?.whitelist_enabled;
  res.locals.disableCustomBackgroundsOn =
    !!settingsRow?.disable_custom_backgrounds;
  res.locals.excludeFromLeaderboardsOn =
    !!settingsRow?.exclude_from_leaderboards;
  res.locals.wlList = getWhitelist(req.user.discord_id);
  res.locals.friendSearchMinLength = WHITELIST_SEARCH_MIN_LEN;
  res.locals.friendItems = listFriendItems(req.user.discord_id);
  res.locals.activeLeash = getActiveLeashForSub(req.user.discord_id);

  res.locals.aboutMe = getAboutMe(req.user.discord_id);
  const strikeState = getUserStrikeState(req.user.discord_id);
  res.locals.currentStrikeCount = strikeState.currentStrikeCount;
  res.locals.maxUserStrikes = MAX_USER_STRIKES;
  res.locals.nextStrikeDecayAt =
    strikeState.currentStrikeCount > 0 ? strikeState.nextDecayAt : 0;
  res.locals.nextStrikeDecayLabel =
    strikeState.currentStrikeCount > 0 && strikeState.nextDecayAt
      ? formatDateTimeLabel(strikeState.nextDecayAt)
      : "";

  const commandsSentTotal = Number(
    db
      .prepare(
        `SELECT IFNULL(commands_sent_total, 0) AS n FROM users WHERE discord_id=?`,
      )
      .get(req.user.discord_id)?.n || 0,
  );

  const apiEligible =
    commandsSentTotal >= 500 && !!res.locals.canManageAccountSecurity;
  res.locals.apiEligible = apiEligible;
  const pairCodeRow = db
    .prepare(
      `
      SELECT last_reset_at
      FROM pair_codes
      WHERE user_id=?
    `,
    )
    .get(req.user.discord_id);
  const pairCodeResetState = getPairCodeResetState(pairCodeRow?.last_reset_at);
  res.locals.pairCodeResetCooldownMinutes = Math.max(
    1,
    Math.round(PAIR_CODE_RESET_COOLDOWN_MS / (60 * 1000)),
  );
  res.locals.pairCodeCanResetNow = pairCodeResetState.canResetNow;
  res.locals.pairCodeNextResetAt = pairCodeResetState.nextAllowedAt || 0;
  res.locals.pairCodeNextResetLabel = pairCodeResetState.nextAllowedAt
    ? formatDateTimeLabel(pairCodeResetState.nextAllowedAt)
    : "";
  const clientCredentialMeta = clientPairingCredentials.getCredentialMeta(
    req.user.discord_id,
  );
  res.locals.clientCredentialMeta = clientCredentialMeta;
  res.locals.clientPairedDevices = devices.map((device) => ({
    deviceId: String(device.device_id || ""),
    deviceName: String(device.device_name || "").trim(),
    authLevel:
      String(device.auth_level || "legacy").trim() === "verified"
        ? "verified"
        : "legacy",
    lastSeenAt: Number(device.last_seen_at || 0),
  }));
  const customControlSlug = normalizeCustomControlSlug(
    settingsRow?.custom_control_slug,
  );
  const customControlUrlState = canChangeCustomControlUrl(
    settingsRow?.custom_control_slug_updated_at,
  );
  res.locals.customControlUrlMinCommands = CUSTOM_CONTROL_URL_MIN_COMMANDS;
  res.locals.customControlUrlMinLength = CUSTOM_CONTROL_URL_MIN_LEN;
  res.locals.customControlUrlMaxLength = CUSTOM_CONTROL_URL_MAX_LEN;
  res.locals.customControlUrlEligible =
    commandsSentTotal >= CUSTOM_CONTROL_URL_MIN_COMMANDS;
  res.locals.customControlSlug = customControlSlug;
  res.locals.customControlFullUrl = buildCustomControlUrl(customControlSlug);
  res.locals.customControlUrlCanChangeNow = customControlUrlState.canChangeNow;
  res.locals.customControlUrlNextChangeAt =
    customControlUrlState.nextChangeAt || 0;
  res.locals.customControlUrlNextChangeLabel =
    customControlUrlState.nextChangeAt
      ? formatDateTimeLabel(customControlUrlState.nextChangeAt)
      : "";

  let apiMeta = null;
  if (apiEligible) {
    ensureUserApiKeyExists(req.user.discord_id);
    apiMeta = getApiKeyMeta(req.user.discord_id);
  }

  res.locals.apiMeta = apiMeta;

  renderWithLayout(res, "pages/profile/pf_main", {
    title: "Profile",
  });
});

app.get("/profile/strikes", requireDiscord, requireNotBanned, (req, res) => {
  const strikeState = getUserStrikeState(req.user.discord_id);
  res.locals.currentStrikeCount = strikeState.currentStrikeCount;
  res.locals.maxUserStrikes = MAX_USER_STRIKES;
  res.locals.nextStrikeDecayAt =
    strikeState.currentStrikeCount > 0 ? strikeState.nextDecayAt : 0;
  res.locals.nextStrikeDecayLabel =
    strikeState.currentStrikeCount > 0 && strikeState.nextDecayAt
      ? formatDateTimeLabel(strikeState.nextDecayAt)
      : "";
  res.locals.profileStrikeHistoryItems = listUserStrikeHistory(req.user.discord_id);

  renderWithLayout(res, "pages/profile/strikes", {
    title: "Strike History",
  });
});

app.post(
  "/profile/custom-control-url",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const userId = String(req.user?.discord_id || "").trim();
    const requestedSlug = normalizeCustomControlSlug(req.body?.slug);
    const safeRequestedSlug = requestedSlug.slice(0, CUSTOM_CONTROL_URL_MAX_LEN);

    if (!isValidCustomControlSlug(safeRequestedSlug)) {
      const message = `Use ${CUSTOM_CONTROL_URL_MIN_LEN}-${CUSTOM_CONTROL_URL_MAX_LEN} letters or numbers only.`;
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message });
      }
      return res.status(400).type("html").send(message);
    }

    const row = db
      .prepare(
        `
          SELECT
            commands_sent_total,
            custom_control_slug,
            custom_control_slug_updated_at
          FROM users
          WHERE discord_id=?
          LIMIT 1
        `,
      )
      .get(userId);

    if (!row) {
      const message = "User not found.";
      if (wantsJson(req)) {
        return res.status(404).json({ ok: false, message });
      }
      return res.status(404).type("html").send(message);
    }

    const currentSlug = normalizeCustomControlSlug(row.custom_control_slug);
    if (currentSlug && safeRequestedSlug === currentSlug) {
      const nextChangeState = canChangeCustomControlUrl(
        row.custom_control_slug_updated_at,
      );
      const payload = {
        ok: true,
        changed: false,
        slug: currentSlug,
        url: buildCustomControlUrl(currentSlug),
        nextChangeAt: nextChangeState.nextChangeAt || 0,
        nextChangeLabel: nextChangeState.nextChangeAt
          ? formatDateTimeLabel(nextChangeState.nextChangeAt)
          : "",
        message: "Custom control URL unchanged.",
      };
      if (wantsJson(req)) return res.json(payload);
      return res.redirect("/profile");
    }

    const commandsSentTotal = Number(row?.commands_sent_total || 0);
    if (commandsSentTotal < CUSTOM_CONTROL_URL_MIN_COMMANDS) {
      const message = `Custom control URLs require ${CUSTOM_CONTROL_URL_MIN_COMMANDS}+ commands sent.`;
      if (wantsJson(req)) {
        return res.status(403).json({ ok: false, message });
      }
      return res.status(403).type("html").send(message);
    }

    const changeState = canChangeCustomControlUrl(row.custom_control_slug_updated_at);
    if (!changeState.canChangeNow) {
      const message = `You can change your custom control URL again after ${formatDateTimeLabel(changeState.nextChangeAt)}.`;
      if (wantsJson(req)) {
        return res.status(429).json({
          ok: false,
          message,
          nextChangeAt: changeState.nextChangeAt,
          nextChangeLabel: formatDateTimeLabel(changeState.nextChangeAt),
        });
      }
      return res.status(429).type("html").send(message);
    }

    const now = Date.now();

    try {
      db.prepare(
        `
          UPDATE users
          SET custom_control_slug=?, custom_control_slug_updated_at=?, updated_at=?
          WHERE discord_id=?
        `,
      ).run(safeRequestedSlug, now, now, userId);
    } catch (e) {
      if (String(e?.message || "").toLowerCase().includes("unique")) {
        const message = "That custom control URL is already taken.";
        if (wantsJson(req)) {
          return res.status(409).json({ ok: false, message });
        }
        return res.status(409).type("html").send(message);
      }
      console.warn("[profile] custom control url save failed:", e?.message || e);
      const message = "Could not save your custom control URL.";
      if (wantsJson(req)) {
        return res.status(500).json({ ok: false, message });
      }
      return res.status(500).type("html").send(message);
    }

    logEvent({
      type: "custom_control_url_updated",
      actorUserId: getActorUserId(req),
      targetUserId: userId,
      req,
      payload: {
        previousSlug: currentSlug || null,
        slug: safeRequestedSlug,
      },
    });

    const nextChangeAt = getCustomControlUrlNextChangeAt(now, now);
    const payload = {
      ok: true,
      changed: true,
      slug: safeRequestedSlug,
      url: buildCustomControlUrl(safeRequestedSlug),
      nextChangeAt,
      nextChangeLabel: formatDateTimeLabel(nextChangeAt),
      message: "Custom control URL saved.",
    };

    if (wantsJson(req)) return res.json(payload);
    return res.redirect("/profile");
  },
);

app.post("/profile/reset-code", requireDiscord, (req, res) => {
  const userId = getActorUserId(req);
  const existingPairCodeRow = db
    .prepare(
      `
      SELECT last_reset_at
      FROM pair_codes
      WHERE user_id=?
    `,
    )
    .get(userId);
  const now = Date.now();
  const resetState = getPairCodeResetState(existingPairCodeRow?.last_reset_at, now);

  if (!resetState.canResetNow) {
    const message = resetState.nextAllowedAt
      ? `You can reset your pairing code again after ${formatDateTimeLabel(resetState.nextAllowedAt)}.`
      : "You can only reset your pairing code once every 10 minutes.";
    if (wantsJson(req)) {
      return res.status(429).json({
        ok: false,
        message,
        nextResetAt: resetState.nextAllowedAt || 0,
        nextResetLabel: resetState.nextAllowedAt
          ? formatDateTimeLabel(resetState.nextAllowedAt)
          : "",
      });
    }

    const params = new URLSearchParams();
    params.set("flash", "pair_code_reset_cooldown");
    if (resetState.nextAllowedAt) {
      params.set("next_reset_at", String(resetState.nextAllowedAt));
    }
    return res.redirect(`/profile?${params.toString()}`);
  }

  const deviceIds = unpairAllDevicesForUser(userId);

  const code = gen6();
  db.prepare(
    `
    INSERT INTO pair_codes (user_id, code_hash, code_plain, updated_at, last_reset_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      code_hash=excluded.code_hash,
      code_plain=excluded.code_plain,
      updated_at=excluded.updated_at,
      last_reset_at=excluded.last_reset_at
  `,
  ).run(userId, hmac(code), code, now, now);

  for (const deviceId of deviceIds) {
    const ws = wsByDeviceId.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "unauthorized" }));
      } catch {}
      try {
        ws.close(1008, "pairing_reset");
      } catch {}
    }
    wsByDeviceId.delete(deviceId);
  }

  logEvent({
    type: "pair_code_reset",
    actorUserId: userId,
    targetUserId: userId,
    req,
    payload: { unpairedDeviceCount: deviceIds.length },
  });

  if (wantsJson(req)) {
    return res.json({
      ok: true,
      code,
      resetAt: now,
      nextResetAt: getPairCodeResetNextAllowedAt(now, now),
      nextResetLabel: formatDateTimeLabel(getPairCodeResetNextAllowedAt(now, now)),
    });
  }

  return res.redirect("/profile?flash=pair_code_reset");
});

function disconnectProfileDevices(deviceIds, reason) {
  for (const deviceId of Array.isArray(deviceIds) ? deviceIds : []) {
    const ws = wsByDeviceId.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "unauthorized", reason }));
      } catch {}
      try {
        ws.close(1008, reason);
      } catch {}
    }
    wsByDeviceId.delete(deviceId);
  }
}

function requireProfileSameOrigin(req, res, next) {
  const origin = String(req.get("Origin") || "").trim();
  if (!origin) return next();
  try {
    if (new URL(origin).host === String(req.get("host") || "")) return next();
  } catch {}
  return res.status(403).json({ ok: false, message: "Invalid request origin." });
}

app.post(
  "/profile/client-secret/generate",
  requireDiscord,
  requireNotBanned,
  requireProfileSameOrigin,
  (req, res) => {
    const userId = getActorUserId(req);
    const result = clientPairingCredentials.ensureCredential(userId);
    res.set("Cache-Control", "private, no-store, max-age=0");
    logEvent({
      type: result.created
        ? "client_pairing_secret_created"
        : "client_pairing_secret_generate_existing",
      actorUserId: userId,
      targetUserId: userId,
      req,
      payload: { version: Number(result.row?.secret_version || 1) },
    });
    return res.json({
      ok: true,
      created: !!result.created,
      required: !!result.row?.secret_required,
      message: result.created ? "Client secret created." : "Client secret already exists.",
    });
  },
);

app.post(
  "/profile/client-secret/reveal",
  requireDiscord,
  requireNotBanned,
  requireProfileSameOrigin,
  (req, res) => {
    const userId = getActorUserId(req);
    const result = clientPairingCredentials.revealSecret(userId);
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");
    logEvent({
      type: "client_pairing_secret_revealed",
      actorUserId: userId,
      targetUserId: userId,
      req,
      payload: { version: Number(result.row?.secret_version || 1) },
    });
    return res.json({
      ok: true,
      secret: result.secret,
      required: !!result.row?.secret_required,
      version: Number(result.row?.secret_version || 1),
    });
  },
);

app.post(
  "/profile/client-secret/reset",
  requireDiscord,
  requireNotBanned,
  requireProfileSameOrigin,
  (req, res) => {
    const userId = getActorUserId(req);
    const previous = clientPairingCredentials.getCredentialMeta(userId);
    const result = clientPairingCredentials.rotateSecret(userId);
    let revokedDeviceIds = [];

    if (previous.required) {
      revokedDeviceIds = db
        .prepare(`SELECT device_id FROM device_pairs WHERE user_id=?`)
        .all(userId)
        .map((row) => String(row.device_id || "").trim())
        .filter(Boolean);
      db.prepare(`DELETE FROM device_pairs WHERE user_id=?`).run(userId);
      disconnectProfileDevices(revokedDeviceIds, "client_secret_reset");
    }

    res.set("Cache-Control", "private, no-store, max-age=0");
    logEvent({
      type: "client_pairing_secret_reset",
      actorUserId: userId,
      targetUserId: userId,
      req,
      payload: {
        version: Number(result.row?.secret_version || 1),
        secretRequired: !!result.row?.secret_required,
        revokedDeviceCount: revokedDeviceIds.length,
      },
    });
    return res.json({
      ok: true,
      required: !!result.row?.secret_required,
      revokedDeviceCount: revokedDeviceIds.length,
      message: previous.required
        ? "Client secret reset. All devices must pair again."
        : "Client secret reset.",
    });
  },
);

app.post(
  "/profile/devices/:deviceId/revoke",
  requireDiscord,
  requireNotBanned,
  requireProfileSameOrigin,
  (req, res) => {
    const userId = getActorUserId(req);
    const deviceId = String(req.params.deviceId || "").trim();
    if (!deviceId) {
      return res.status(400).json({ ok: false, message: "Missing device." });
    }
    const info = db
      .prepare(`DELETE FROM device_pairs WHERE user_id=? AND device_id=?`)
      .run(userId, deviceId);
    if (!Number(info?.changes || 0)) {
      return res.status(404).json({ ok: false, message: "Device not found." });
    }
    disconnectProfileDevices([deviceId], "device_revoked");
    logEvent({
      type: "paired_device_revoked",
      actorUserId: userId,
      targetUserId: userId,
      deviceId,
      req,
      payload: {},
    });
    return res.json({ ok: true, message: "Device revoked." });
  },
);

app.post("/profile/discover", requireDiscord, (req, res) => {
  const enabled = String(req.body?.enabled || "0") === "1" ? 1 : 0;

  const wl = db
    .prepare(`SELECT whitelist_enabled FROM users WHERE discord_id=?`)
    .get(req.user.discord_id);
  if (wl?.whitelist_enabled && String(req.body?.enabled || "0") === "1") {
    if (wantsJson(req))
      return res
        .status(400)
        .json({ ok: false, message: "Disable whitelist to enable Discover." });
    return res
      .status(400)
      .type("html")
      .send("Disable whitelist to enable Discover.");
  }

  db.prepare(`UPDATE users SET discoverable=? WHERE discord_id=?`).run(
    enabled,
    req.user.discord_id,
  );

    logEvent({
      type: enabled ? "discover_enabled" : "discover_disabled",
      actorUserId: getActorUserId(req),
      targetUserId: req.user.discord_id,
    req,
    payload: {},
  });

  if (wantsJson(req)) {
    return res.json({
      ok: true,
      enabled,
      message: enabled ? "Enabled" : "Disabled",
    });
  }

  res.redirect("/profile");
});

app.post(
  "/profile/away-mode",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const userId = String(req.user?.discord_id || "").trim();
    const enabled = String(req.body?.enabled || "0") === "1" ? 1 : 0;
    const now = Date.now();
    const currentPresence = getUserPresenceState(userId);

    db.prepare(
      `
      UPDATE users
      SET away_enabled=?,
          last_online_at=CASE
            WHEN ? = 1 AND ? = 1 THEN ?
            ELSE last_online_at
          END,
          updated_at=?
      WHERE discord_id=?
    `,
    ).run(enabled, enabled, currentPresence.online ? 1 : 0, now, now, userId);

    const clearedCount = enabled ? 0 : clearQueuedCommandsForUser(userId);
    const presence = getUserPresenceState(userId);
    const awayUntil = Number(presence.awayUntil || 0);
    const awayUntilLabel =
      presence.status !== "offline" && awayUntil
        ? formatDateTimeLabel(awayUntil)
        : "";

    let message = "";
    if (enabled) {
      message = "Away mode enabled. Commands will queue for 24 hours.";
    } else if (clearedCount > 0) {
      message = `Away mode disabled. Cleared ${clearedCount} queued command${clearedCount === 1 ? "" : "s"}.`;
    } else {
      message = "Away mode disabled.";
    }

    logEvent({
      type: enabled ? "away_mode_enabled" : "away_mode_disabled",
      actorUserId: getActorUserId(req),
      targetUserId: userId,
      req,
      payload: {
        clearedCount,
        status: presence.status,
        awayUntil,
      },
    });

    if (wantsJson(req)) {
      return res.json({
        ok: true,
        enabled: !!enabled,
        status: presence.status,
        online: !!presence.online,
        away: !!presence.away,
        awayUntil,
        awayUntilLabel,
        clearedCount,
        message,
      });
    }

    return res.redirect("/profile");
  },
);

app.post(
  "/profile/disable-custom-backgrounds",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const enabled = String(req.body?.enabled || "0") === "1" ? 1 : 0;

    db.prepare(
      `UPDATE users SET disable_custom_backgrounds=? WHERE discord_id=?`,
    ).run(enabled, req.user.discord_id);

    logEvent({
      type: enabled
        ? "disable_custom_backgrounds_enabled"
        : "disable_custom_backgrounds_disabled",
      actorUserId: getActorUserId(req),
      targetUserId: req.user.discord_id,
      req,
      payload: {},
    });

    if (wantsJson(req)) {
      return res.json({
        ok: true,
        enabled,
        message: enabled ? "Enabled" : "Disabled",
      });
    }

    return res.redirect("/profile");
  },
);

app.post(
  "/profile/exclude-from-leaderboards",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const enabled = String(req.body?.enabled || "0") === "1" ? 1 : 0;

    db.prepare(
      `UPDATE users SET exclude_from_leaderboards=? WHERE discord_id=?`,
    ).run(enabled, req.user.discord_id);

    logEvent({
      type: enabled
        ? "leaderboard_opt_out_enabled"
        : "leaderboard_opt_out_disabled",
      actorUserId: getActorUserId(req),
      targetUserId: req.user.discord_id,
      req,
      payload: {},
    });

    if (wantsJson(req)) {
      return res.json({
        ok: true,
        enabled,
        message: enabled ? "Enabled" : "Disabled",
      });
    }

    return res.redirect("/profile");
  },
);

app.post("/profile/aboutme", requireDiscord, requireNotBanned, (req, res) => {
  const text = String(req.body?.text || "");
  const saved = setAboutMe(req.user.discord_id, text);

  logEvent({
    type: "about_me_updated",
    actorUserId: getActorUserId(req),
    targetUserId: req.user.discord_id,
    req,
    payload: { text: saved },
  });

  if (wantsJson(req)) return res.json({ ok: true, len: saved.length });
  return res.redirect("/profile");
});

app.post(
  "/profile/lists/toggle",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const listKey = String(req.body?.listKey || "").trim();
    const itemKey = String(req.body?.itemKey || "").trim();
    const enabled = String(req.body?.enabled || "0") === "1";

    try {
      setUserItem(req.user.discord_id, listKey, itemKey, enabled);

      if (wantsJson(req)) return res.json({ ok: true });
      return res.redirect("/profile");
    } catch (e) {
      const msg = e?.message || "Failed";
      if (wantsJson(req))
        return res.status(400).json({ ok: false, message: msg });
      return res.status(400).type("html").send(msg);
    }
  },
);

app.post(
  "/profile/whitelist/toggle",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const enabled = String(req.body?.enabled || "0") === "1" ? 1 : 0;

    const tx = db.transaction(() => {
      db.prepare(`UPDATE users SET whitelist_enabled=? WHERE discord_id=?`).run(
        enabled,
        req.user.discord_id,
      );

      if (enabled) {
        db.prepare(`UPDATE users SET discoverable=0 WHERE discord_id=?`).run(
          req.user.discord_id,
        );
      }
    });

    tx();

    logEvent({
      type: enabled ? "whitelist_enabled" : "whitelist_disabled",
      actorUserId: getActorUserId(req),
      targetUserId: req.user.discord_id,
      req,
      payload: {},
    });

    if (wantsJson(req)) return res.json({ ok: true, enabled });
    return res.redirect("/profile");
  },
);

app.get(
  "/profile/whitelist/search",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const q = normalizeWhitelistSearchQuery(req.query?.q);
    if (q.length < WHITELIST_SEARCH_MIN_LEN) {
      return res.status(400).json({
        ok: false,
        message: `Enter at least ${WHITELIST_SEARCH_MIN_LEN} characters to search.`,
      });
    }

    return res.json({
      ok: true,
      items: searchWhitelistUsers(req.user.discord_id, q),
    });
  },
);

app.post(
  "/profile/whitelist/add",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const allowedId = String(req.body?.discord_id || "").trim();

    if (!isDiscordId(allowedId)) {
      return wantsJson(req)
        ? res.status(400).json({ ok: false, message: "Bad Discord ID." })
        : res.status(400).type("html").send("Bad Discord ID.");
    }

    if (allowedId === req.user.discord_id) {
      return wantsJson(req)
        ? res
            .status(400)
            .json({ ok: false, message: "You can’t add yourself." })
        : res.status(400).type("html").send("You can’t add yourself.");
    }

    const exists = db
      .prepare(`SELECT discord_id FROM users WHERE discord_id=?`)
      .get(allowedId);
    if (!exists) {
      return wantsJson(req)
        ? res
            .status(400)
            .json({
              ok: false,
              message: "That user hasn’t logged in yet (no user record).",
            })
        : res.status(400).type("html").send("That user hasn’t logged in yet.");
    }

    const insertResult = db.prepare(
      `
    INSERT OR IGNORE INTO user_whitelist (owner_id, allowed_id, created_at)
    VALUES (?, ?, ?)
  `,
    ).run(req.user.discord_id, allowedId, Date.now());

    if (insertResult.changes > 0) {
      logEvent({
        type: "whitelist_added",
        actorUserId: getActorUserId(req),
        targetUserId: allowedId,
        req,
        payload: {},
      });
    }

    if (wantsJson(req)) {
      return res.json({
        ok: true,
        alreadyAdded: insertResult.changes === 0,
      });
    }
    return res.redirect("/profile");
  },
);

app.post(
  "/profile/whitelist/remove",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const allowedId = String(req.body?.discord_id || "").trim();

    const removeResult = db.prepare(
      `
    DELETE FROM user_whitelist
    WHERE owner_id=? AND allowed_id=?
  `,
    ).run(req.user.discord_id, allowedId);

    if (removeResult.changes > 0) {
      logEvent({
        type: "whitelist_removed",
        actorUserId: getActorUserId(req),
        targetUserId: allowedId,
        req,
        payload: {},
      });
    }

    if (wantsJson(req)) {
      return res.json({
        ok: true,
        removed: removeResult.changes > 0,
      });
    }
    return res.redirect("/profile");
  },
);

app.get(
  "/profile/friends/search",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const userId = getEffectiveUserId(req);
    const q = normalizeWhitelistSearchQuery(req.query?.q);
    if (q.length < WHITELIST_SEARCH_MIN_LEN) {
      return res.status(400).json({
        ok: false,
        message: `Enter at least ${WHITELIST_SEARCH_MIN_LEN} characters to search.`,
      });
    }

    return res.json({
      ok: true,
      items: searchFriendUsers(userId, q),
    });
  },
);

app.post(
  "/profile/friends/request",
  requireDiscord,
  requireNotBanned,
  requireDirectProfileOwner,
  (req, res) => {
    const userId = getEffectiveUserId(req);
    const friendId = String(req.body?.discord_id || "").trim();
    const pair = getFriendPair(userId, friendId);

    if (!pair || !isDiscordId(friendId)) {
      return res.status(400).json({ ok: false, message: "Choose a valid user." });
    }

    const friend = db
      .prepare(`SELECT discord_id, username, global_name FROM users WHERE discord_id=?`)
      .get(friendId);
    if (!friend) {
      return res.status(404).json({ ok: false, message: "User not found." });
    }

    const existing = db
      .prepare(
        `
          SELECT status, requested_by
          FROM friendships
          WHERE user_a_id=? AND user_b_id=?
        `,
      )
      .get(pair[0], pair[1]);
    const now = Date.now();

    if (existing?.status === "accepted") {
      return res.json({ ok: true, status: "accepted", message: "Already friends." });
    }

    if (existing?.status === "pending" && existing.requested_by !== userId) {
      db.prepare(
        `
          UPDATE friendships
          SET status='accepted', updated_at=?
          WHERE user_a_id=? AND user_b_id=?
        `,
      ).run(now, pair[0], pair[1]);

      notifyUsers({
        userIds: [friendId],
        kind: "friend_request_accepted",
        title: "Friend request accepted",
        message: `${getUserDisplayName(req.user) || "Someone"} accepted your friend request.`,
        actionUrl: "/profile",
        actionLabel: "Open Profile",
        createdBy: userId,
        sourceType: "friendship",
        sourceId: pair.join(":"),
      });

      logEvent({
        type: "friend_request_accepted",
        actorUserId: userId,
        targetUserId: friendId,
        req,
        payload: {},
      });

      return res.json({ ok: true, status: "accepted", message: "Friend added." });
    }

    if (!existing) {
      db.prepare(
        `
          INSERT INTO friendships (
            user_a_id, user_b_id, requested_by, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, ?)
        `,
      ).run(pair[0], pair[1], userId, now, now);

      notifyUsers({
        userIds: [friendId],
        kind: "friend_request",
        title: "New friend request",
        message: `${getUserDisplayName(req.user) || "Someone"} sent you a friend request.`,
        actionUrl: "/profile",
        actionLabel: "Review",
        createdBy: userId,
        sourceType: "friendship",
        sourceId: pair.join(":"),
      });

      logEvent({
        type: "friend_request_sent",
        actorUserId: userId,
        targetUserId: friendId,
        req,
        payload: {},
      });
    }

    return res.json({ ok: true, status: "pending", message: "Friend request sent." });
  },
);

app.post(
  "/profile/friends/accept",
  requireDiscord,
  requireNotBanned,
  requireDirectProfileOwner,
  (req, res) => {
    const userId = getEffectiveUserId(req);
    const friendId = String(req.body?.discord_id || "").trim();
    const pair = getFriendPair(userId, friendId);
    if (!pair || !isDiscordId(friendId)) {
      return res.status(400).json({ ok: false, message: "Choose a valid request." });
    }

    const now = Date.now();
    const result = db
      .prepare(
        `
          UPDATE friendships
          SET status='accepted', updated_at=?
          WHERE user_a_id=?
            AND user_b_id=?
            AND status='pending'
            AND requested_by != ?
        `,
      )
      .run(now, pair[0], pair[1], userId);

    if (!Number(result?.changes || 0)) {
      return res.status(404).json({ ok: false, message: "Friend request not found." });
    }

    notifyUsers({
      userIds: [friendId],
      kind: "friend_request_accepted",
      title: "Friend request accepted",
      message: `${getUserDisplayName(req.user) || "Someone"} accepted your friend request.`,
      actionUrl: "/profile",
      actionLabel: "Open Profile",
      createdBy: userId,
      sourceType: "friendship",
      sourceId: pair.join(":"),
    });

    logEvent({
      type: "friend_request_accepted",
      actorUserId: userId,
      targetUserId: friendId,
      req,
      payload: {},
    });

    return res.json({ ok: true, message: "Friend added." });
  },
);

app.post(
  "/profile/friends/remove",
  requireDiscord,
  requireNotBanned,
  requireDirectProfileOwner,
  (req, res) => {
    const userId = getEffectiveUserId(req);
    const friendId = String(req.body?.discord_id || "").trim();
    const pair = getFriendPair(userId, friendId);
    if (!pair || !isDiscordId(friendId)) {
      return res.status(400).json({ ok: false, message: "Choose a valid friend." });
    }

    const tx = db.transaction(() => {
      const deleted = db
        .prepare(`DELETE FROM friendships WHERE user_a_id=? AND user_b_id=?`)
        .run(pair[0], pair[1]);
      db.prepare(
        `
          DELETE FROM leash_delegations
          WHERE (sub_user_id=? AND dom_user_id=?)
             OR (sub_user_id=? AND dom_user_id=?)
        `,
      ).run(userId, friendId, friendId, userId);
      return deleted;
    });
    const result = tx();

    if (req.delegatedUser && friendId === getActorUserId(req)) {
      res.clearCookie("delegated_sub_id", { path: "/" });
    }

    if (Number(result?.changes || 0)) {
      logEvent({
        type: "friend_removed",
        actorUserId: userId,
        targetUserId: friendId,
        req,
        payload: {},
      });
    }

    return res.json({
      ok: true,
      removed: Number(result?.changes || 0) > 0,
      message: "Friend removed.",
    });
  },
);

app.post(
  "/profile/leash/give",
  requireDiscord,
  requireNotBanned,
  requireDirectProfileOwner,
  (req, res) => {
    const subUserId = getEffectiveUserId(req);
    const domUserId = String(req.body?.discord_id || "").trim();
    if (!isDiscordId(domUserId) || domUserId === subUserId) {
      return res.status(400).json({ ok: false, message: "Choose a valid friend." });
    }
    if (!areAcceptedFriends(subUserId, domUserId)) {
      return res.status(403).json({ ok: false, message: "You can only give control to a friend." });
    }

    const activeLeash = getActiveLeashForSub(subUserId);
    if (activeLeash && String(activeLeash.dom_user_id || "") !== domUserId) {
      return res.status(409).json({
        ok: false,
        message: "Control is already granted. The current friend must release you, or you must remove them as a friend.",
      });
    }

    const now = Date.now();
    db.prepare(
      `
        INSERT INTO leash_delegations (sub_user_id, dom_user_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(sub_user_id) DO UPDATE SET
          dom_user_id=excluded.dom_user_id,
          created_at=excluded.created_at
      `,
    ).run(subUserId, domUserId, now);

    notifyUsers({
      userIds: [domUserId],
      kind: "leash_given",
      title: "Control granted",
      message: `${getUserDisplayName(req.user) || "A friend"} gave you control of their profile settings.`,
      actionUrl: "/profile",
      actionLabel: "Open Profile",
      createdBy: subUserId,
      sourceType: "leash",
      sourceId: subUserId,
    });

    logEvent({
      type: "leash_given",
      actorUserId: subUserId,
      targetUserId: domUserId,
      req,
      payload: {},
    });

    return res.json({ ok: true, message: "Control granted." });
  },
);

app.post(
  "/profile/leash/release",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const domUserId = getActorUserId(req);
    const subUserId = String(req.body?.sub_id || req.delegatedUser?.discord_id || "").trim();
    if (!isDiscordId(subUserId) || !domUserId) {
      return res.status(400).json({ ok: false, message: "Choose a valid delegated user." });
    }

    const result = db
      .prepare(`DELETE FROM leash_delegations WHERE sub_user_id=? AND dom_user_id=?`)
      .run(subUserId, domUserId);

    if (req.delegatedUser?.discord_id === subUserId) {
      res.clearCookie("delegated_sub_id", { path: "/" });
    }

    if (Number(result?.changes || 0)) {
      notifyUsers({
        userIds: [subUserId],
        kind: "leash_released",
        title: "Control released",
        message: `${getUserDisplayName(getActorUser(req)) || "Your friend"} released your delegated control.`,
        actionUrl: "/profile",
        actionLabel: "Open Profile",
        createdBy: domUserId,
        sourceType: "leash",
        sourceId: subUserId,
      });
      logEvent({
        type: "leash_released",
        actorUserId: domUserId,
        targetUserId: subUserId,
        req,
        payload: {},
      });
    }

    return res.json({ ok: true, released: Number(result?.changes || 0) > 0, message: "Control released." });
  },
);

app.post(
  "/profile/leash/control",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const domUserId = getActorUserId(req);
    const subUserId = String(req.body?.sub_id || "").trim();
    if (!isDiscordId(subUserId) || !domUserId || subUserId === domUserId) {
      return res.status(400).json({ ok: false, message: "Choose a valid delegated user." });
    }

    const row = db
      .prepare(
        `
          SELECT sub_user_id
          FROM leash_delegations
          WHERE sub_user_id=? AND dom_user_id=?
        `,
      )
      .get(subUserId, domUserId);
    if (!row) {
      return res.status(403).json({ ok: false, message: "Delegated control is not active." });
    }

    res.cookie("delegated_sub_id", subUserId, {
      httpOnly: true,
      sameSite: "lax",
      secure: !!req.secure,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    logEvent({
      type: "leash_control_started",
      actorUserId: domUserId,
      targetUserId: subUserId,
      req,
      payload: {},
    });

    return res.json({ ok: true, redirect: "/profile", message: "Opening delegated profile." });
  },
);

app.post(
  "/profile/leash/return",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    res.clearCookie("delegated_sub_id", { path: "/" });
    if (wantsJson(req)) {
      return res.json({ ok: true, redirect: "/profile", message: "Returned to your profile." });
    }
    return res.redirect("/profile");
  },
);

app.post(
  "/profile/api_key/reset",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const raw = genApiKey();
    const key_hash = hashApiKey(raw);
    const now = Date.now();
    const userId = getActorUserId(req);
    const sent = getCommandsSentTotal(userId);

    if (sent < API_MIN_COMMANDS) {
      return res.status(403).type("html").send("Not eligible.");
    }

    db.prepare(
      `
    INSERT INTO api_keys (user_id, key_hash, created_at, last_reset_at)
    VALUES (?, ?, COALESCE((SELECT created_at FROM api_keys WHERE user_id=?), ?), ?)
    ON CONFLICT(user_id) DO UPDATE SET
      key_hash=excluded.key_hash,
      last_reset_at=excluded.last_reset_at
  `,
    ).run(userId, key_hash, userId, now, now);

    return res.json({
      ok: true,
      api_key: raw,
      last_reset_at: now,
    });
  },
);
}

module.exports = { registerProfileRoutes };
