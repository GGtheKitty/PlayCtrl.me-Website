function registerControlLinkRoutes(app, deps) {
  const {
    COMMAND_HISTORY_REPORT_REASON_OPTIONS,
    CONTROL_LINK_REPORT_REASON_BY_KEY,
    CONTROL_LINK_REPORT_REASON_OPTIONS,
    CONTROL_LINK_THEME_OPTIONS,
    TOP_FAVORITES_LIMIT,
    createControlLinkReport,
    db,
    ensurePairCode,
    getBoardMessages,
    getCatalogItems,
    getCommandPrefsForUser,
    getCommandsSentMilestoneBadge,
    getResolvedEnabledCommandsForActor,
    getUserPresenceState,
    getRecentUploadsByContextForUser,
    getReportReasonOption,
    getSupporterBadge,
    getTopFavoriteKeys,
    getUserSelections,
    hmac,
    isCommandEnabled,
    isDeviceOnline,
    isValidCustomControlSlug,
    normalizeControlLinkDisplayName,
    normalizeControlLinkTheme,
    normalizeCustomControlSlug,
    normalizeReportDetails,
    orderFavoriteKeys,
    orderSelectionKeysByCatalog,
    ownerHasReportedCapabilityForActor,
    renderWithLayout,
    requestLooksLikeLinkPreview,
    requireDiscord,
    requireNotBanned,
  } = deps;

function renderLockedControlLinkPage(req, res, nextUrl) {
  if (requestLooksLikeLinkPreview(req)) {
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set(
      "X-Robots-Tag",
      "noindex, nofollow, noarchive, nosnippet, noimageindex",
    );
    return res.status(204).end();
  }

  res.locals.layoutBodyClass = "page-control-link page-control-link-locked";
  res.locals.layoutBodyDataControlTheme = "purple";
  res.locals.controlLinkLoginUrl = `/auth/discord?next=${encodeURIComponent(nextUrl || req.originalUrl || "/")}`;

  return renderWithLayout(res, "pages/control_links/con_locked", {
    title: "Login required",
    meta: {
      ogTitle: "PlayCtrl.me Control Link",
      ogDesc: "Login to view this control page.",
    },
  });
}

function renderNotFoundPage(res) {
  res.status(404);
  return renderWithLayout(res, "pages/404", {
    title: "Page Not Found",
  });
}

function resolveOwnerIdByPairCode(pairCode) {
  const safePairCode = String(pairCode || "").trim();
  if (!/^\d{6}$/.test(safePairCode)) return null;

  const row = db
    .prepare(
      `
        SELECT pc.user_id
        FROM pair_codes pc
        LEFT JOIN bans b ON b.discord_id = pc.user_id
        WHERE pc.code_hash=?
          AND b.discord_id IS NULL
      `,
    )
    .get(hmac(safePairCode));
  return String(row?.user_id || "").trim() || null;
}

function resolveOwnerIdByCustomControlSlug(slug) {
  const normalizedSlug = normalizeCustomControlSlug(slug);
  if (!isValidCustomControlSlug(normalizedSlug)) return null;

  const row = db
    .prepare(
      `
        SELECT discord_id
        FROM users
        WHERE custom_control_slug=?
          AND NOT EXISTS (
            SELECT 1
            FROM bans b
            WHERE b.discord_id = users.discord_id
          )
        LIMIT 1
      `,
    )
    .get(normalizedSlug);

  return String(row?.discord_id || "").trim() || null;
}

function renderResolvedControlLinkPage(req, res, { pairCode, ownerId }) {
  const safePairCode = String(pairCode || "").trim();
  const safeOwnerId = String(ownerId || "").trim();
  if (!safePairCode || !safeOwnerId || !req.viewUser) {
    return renderNotFoundPage(res);
  }

  const viewerId = String(req.viewUser.discord_id);
  const me = viewerId;
  const viewerDisablesCustomBackgrounds = !!Number(
    req.viewUser.disable_custom_backgrounds || 0,
  );

  res.locals.pairCode = safePairCode;
  res.locals.ownerId = safeOwnerId;

  const ownerUser = db
    .prepare(
      `
    SELECT
      discord_id,
      username,
      global_name,
      avatar,
      about_me,
      commands_sent_total,
      has_supporter_badge,
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
    .get(safeOwnerId);
  res.locals.ownerUser = ownerUser;
  res.locals.controlLinkTheme = normalizeControlLinkTheme(
    ownerUser?.control_link_theme,
  );
  res.locals.controlLinkCustomName = normalizeControlLinkDisplayName(
    ownerUser?.control_link_display_name,
  ) || "";
  res.locals.controlLinkDisplayName =
    res.locals.controlLinkCustomName ||
    ownerUser?.global_name ||
    ownerUser?.username ||
    safeOwnerId;
  res.locals.ownerCommandsSentTotal = Number(
    ownerUser?.commands_sent_total || 0,
  );
  res.locals.controlLinkBadges = [];
  {
    const commandsMilestoneBadge = getCommandsSentMilestoneBadge(
      res.locals.ownerCommandsSentTotal,
    );
    if (commandsMilestoneBadge) {
      res.locals.controlLinkBadges.push(commandsMilestoneBadge);
    }
    const supporterBadge = getSupporterBadge(
      !!Number(ownerUser?.has_supporter_badge || 0),
    );
    if (supporterBadge) {
      res.locals.controlLinkBadges.push(supporterBadge);
    }
  }
  res.locals.controlLinkHasCustomAvatar = !!String(
    ownerUser?.custom_avatar_path || "",
  ).trim();
  res.locals.controlLinkAvatarVersion = Number(
    ownerUser?.custom_avatar_updated_at ||
      ownerUser?.avatar_cache_updated_at ||
      0,
  );
  res.locals.controlLinkHasCustomBanner = !!String(
    ownerUser?.custom_banner_path || "",
  ).trim();
  res.locals.controlLinkBannerVersion = Number(
    ownerUser?.custom_banner_updated_at || 0,
  );
  res.locals.controlLinkHasCustomBackground = !!String(
    ownerUser?.custom_background_path || "",
  ).trim();
  res.locals.controlLinkShouldLoadCustomBackground =
    res.locals.controlLinkHasCustomBackground &&
    !viewerDisablesCustomBackgrounds;
  res.locals.controlLinkBackgroundVersion = Number(
    ownerUser?.custom_background_updated_at || 0,
  );
  res.locals.viewerDisablesCustomBackgrounds =
    viewerDisablesCustomBackgrounds;
  res.locals.controlLinkThemeOptions = CONTROL_LINK_THEME_OPTIONS;
  res.locals.controlLinkReportReasonOptions = CONTROL_LINK_REPORT_REASON_OPTIONS;
  res.locals.commandHistoryReportReasonOptions =
    COMMAND_HISTORY_REPORT_REASON_OPTIONS;
  res.locals.canReportControlLink = viewerId !== safeOwnerId;
  res.locals.layoutBodyClass = "page-control-link";
  res.locals.layoutBodyDataControlTheme = res.locals.controlLinkTheme;

  const viewerRow = db
    .prepare(
      `
    SELECT commands_sent_total
    FROM users
    WHERE discord_id=?
  `,
    )
    .get(viewerId);
  const viewerCommandsSentTotal = Number(viewerRow?.commands_sent_total || 0);
  res.locals.cooldownApplies = viewerCommandsSentTotal < 100;

  res.locals.viewerIsOwner = viewerId === safeOwnerId;
  res.locals.boardMsgs = getBoardMessages(safeOwnerId, 10);

  const ownerSelections = getUserSelections(safeOwnerId);
  const catalog = getCatalogItems();
  const topFavKeys = getTopFavoriteKeys(safeOwnerId);

  res.locals.aboutMe = String(ownerUser?.about_me || "");

  res.locals.labelByKey = new Map(catalog.map((it) => [it.key, it.label]));
  res.locals.topFavKeys = topFavKeys;
  res.locals.topFavKeySet = new Set(topFavKeys);
  res.locals.topFavoritesLimit = TOP_FAVORITES_LIMIT;
  res.locals.favKeys = orderFavoriteKeys(
    Array.from(ownerSelections.favorites || []),
    catalog,
    topFavKeys,
  );
  res.locals.disKeys = orderSelectionKeysByCatalog(
    Array.from(ownerSelections.dislikes || []),
    catalog,
  );

  const devices = db
    .prepare(
      `
    SELECT dp.device_id, d.last_seen_at
    FROM device_pairs dp
    JOIN devices_v2 d ON d.device_id = dp.device_id
    WHERE dp.user_id = ?
    ORDER BY d.last_seen_at DESC
  `,
    )
    .all(safeOwnerId);

  const presence = getUserPresenceState(safeOwnerId, {
    deviceIds: devices.map((device) => device.device_id),
  });
  res.locals.anyOnline = !!presence.online;
  res.locals.presenceStatus = presence.status;
  res.locals.presenceAway = !!presence.away;
  res.locals.liveOnlyCommandsDisabled = presence.status === "away";

  const ownerPrefs = getCommandPrefsForUser(safeOwnerId);
  const STANDARD_COMMAND_PREVIEW_ACTOR_ID = "__standard_command_preview__";
  function buildCommandDisplay(actorIdForCapabilities = null) {
    const enabledSet = getResolvedEnabledCommandsForActor(
      safeOwnerId,
      actorIdForCapabilities,
    );

    function isEnabledForDisplay(cmdKey) {
      if (enabledSet) return enabledSet.has(cmdKey);
      if (
        cmdKey === "play_sound_url" ||
        cmdKey === "play_sound_loop" ||
        cmdKey === "play_sound_loop_url"
      ) return false;
      return isCommandEnabled(ownerPrefs, cmdKey);
    }

    const canPopup = isEnabledForDisplay("popup");
    const canSendSubliminalMessage = isEnabledForDisplay(
      "subliminal_message",
    );
    const canOpenUrl = isEnabledForDisplay("open_url");
    const canImage = isEnabledForDisplay("image_popup");
    const canFullscreenPopup = isEnabledForDisplay("fullscreen_popup");
    const canSpiralOverlay = isEnabledForDisplay("spiral_overlay");
    const canSetWallpaper = isEnabledForDisplay("set_wallpaper");
    const canSetWallpaperMedia = ownerHasReportedCapabilityForActor(
      safeOwnerId,
      actorIdForCapabilities,
      "set_wallpaper_media",
    );
    const canScreenshot = isEnabledForDisplay("screenshot");
    const canWebcamCapture = isEnabledForDisplay("webcam_capture");
    const canPlaySound = isEnabledForDisplay("play_sound");
    const canPlaySoundUrl = isEnabledForDisplay("play_sound_url");
    const canPlaySoundLoop = isEnabledForDisplay("play_sound_loop");
    const canPlaySoundLoopUrl = isEnabledForDisplay("play_sound_loop_url");
    const canWriteForMe = isEnabledForDisplay("write_for_me");

    return {
      canPopup,
      canSendSubliminalMessage,
      canOpenUrl,
      canImage,
      canFullscreenPopup,
      canSpiralOverlay,
      canSetWallpaper,
      canSetWallpaperMedia,
      setWallpaperUploadContext: canSetWallpaperMedia
        ? "set_wallpaper_media"
        : "set_wallpaper",
      canScreenshot,
      canWebcamCapture,
      canPlaySound,
      canPlaySoundUrl,
      canPlaySoundLoop,
      canPlaySoundLoopUrl,
      canWriteForMe,
      anyCommandsEnabled:
        canPopup ||
        canSendSubliminalMessage ||
        canOpenUrl ||
        canImage ||
        canFullscreenPopup ||
        canSpiralOverlay ||
        canSetWallpaper ||
        canScreenshot ||
        canWebcamCapture ||
        canPlaySound ||
        canPlaySoundLoop ||
        canWriteForMe,
    };
  }

  const viewerCommandDisplay = buildCommandDisplay(viewerId);
  const standardCommandDisplay = res.locals.viewerIsOwner
    ? buildCommandDisplay(STANDARD_COMMAND_PREVIEW_ACTOR_ID)
    : null;
  const whitelistedCommandDisplay = res.locals.viewerIsOwner
    ? buildCommandDisplay(safeOwnerId)
    : null;

  res.locals.canPopup = viewerCommandDisplay.canPopup;
  res.locals.canSendSubliminalMessage =
    viewerCommandDisplay.canSendSubliminalMessage;
  res.locals.canOpenUrl = viewerCommandDisplay.canOpenUrl;
  res.locals.canImage = viewerCommandDisplay.canImage;
  res.locals.canFullscreenPopup = viewerCommandDisplay.canFullscreenPopup;
  res.locals.canSpiralOverlay = viewerCommandDisplay.canSpiralOverlay;
  res.locals.canSetWallpaper = viewerCommandDisplay.canSetWallpaper;
  res.locals.canSetWallpaperMedia = viewerCommandDisplay.canSetWallpaperMedia;
  res.locals.setWallpaperUploadContext =
    viewerCommandDisplay.setWallpaperUploadContext;
  res.locals.canScreenshot = viewerCommandDisplay.canScreenshot;
  res.locals.canWebcamCapture = viewerCommandDisplay.canWebcamCapture;
  res.locals.canPlaySound = viewerCommandDisplay.canPlaySound;
  res.locals.canPlaySoundUrl = viewerCommandDisplay.canPlaySoundUrl;
  res.locals.canPlaySoundLoop = viewerCommandDisplay.canPlaySoundLoop;
  res.locals.canPlaySoundLoopUrl = viewerCommandDisplay.canPlaySoundLoopUrl;
  res.locals.canWriteForMe = viewerCommandDisplay.canWriteForMe;
  res.locals.commandPreviewToggleEnabled = !!res.locals.viewerIsOwner;
  res.locals.commandPreviewDefaultMode = res.locals.viewerIsOwner
    ? "standard"
    : "current";
  res.locals.commandPreviewStandard = standardCommandDisplay;
  res.locals.commandPreviewWhitelisted = whitelistedCommandDisplay;
  res.locals.uploadRecentItemsByContext = getRecentUploadsByContextForUser(
    req,
    viewerId,
  );

  res.locals.anyCommandsEnabled = res.locals.viewerIsOwner
    ? !!(
        standardCommandDisplay?.anyCommandsEnabled ||
        whitelistedCommandDisplay?.anyCommandsEnabled
      )
    : viewerCommandDisplay.anyCommandsEnabled;

  let isFavorited = false;
  if (me) {
    isFavorited = !!db
      .prepare(
        `
      SELECT 1 FROM favorites
      WHERE user_id = ? AND favorite_user_id = ?
    `,
      )
      .get(me, safeOwnerId);
  }
  res.locals.isFavorited = isFavorited;

  const controlPageTitle = `Control ${res.locals.controlLinkDisplayName || "User"}'s device!`;

  return renderWithLayout(res, "pages/control_links/con_main", {
    title: controlPageTitle,
    meta: {
      ogTitle: controlPageTitle,
      ogDesc: "Open this control page to send commands.",
    },
  });
}

app.get("/device/:pairCode", requireNotBanned, (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();
  if (!/^\d{6}$/.test(pairCode)) {
    return renderNotFoundPage(res);
  }

  if (!req.viewUser) {
    return renderLockedControlLinkPage(
      req,
      res,
      req.originalUrl || `/device/${pairCode}`,
    );
  }

  const ownerId = resolveOwnerIdByPairCode(pairCode);
  if (!ownerId) {
    return renderNotFoundPage(res);
  }

  return renderResolvedControlLinkPage(req, res, { pairCode, ownerId });
});

app.get("/c/:slug", requireNotBanned, (req, res) => {
  const slug = normalizeCustomControlSlug(req.params.slug);

  if (!isValidCustomControlSlug(slug)) {
    return renderNotFoundPage(res);
  }

  if (!req.viewUser) {
    return renderLockedControlLinkPage(
      req,
      res,
      req.originalUrl || `/c/${slug}`,
    );
  }

  const ownerId = resolveOwnerIdByCustomControlSlug(slug);
  if (!ownerId) return renderNotFoundPage(res);

  const pairCode = ensurePairCode(ownerId);
  return renderResolvedControlLinkPage(req, res, { pairCode, ownerId });
});

app.post(
  "/api/device/:pairCode/report",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode)) {
      return res.status(400).json({
        ok: false,
        message: "Bad device code.",
      });
    }

    const codeHash = hmac(pairCode);
    const pairRow = db
      .prepare(`SELECT user_id FROM pair_codes WHERE code_hash=?`)
      .get(codeHash);

    if (!pairRow?.user_id) {
      return res.status(404).json({
        ok: false,
        message: "Unknown control link.",
      });
    }

    const ownerId = String(pairRow.user_id || "").trim();
    const reporterUser = req.viewUser || req.user || null;
    const reporterUserId = String(reporterUser?.discord_id || "").trim();
    const reasonKey = String(
      req.body?.reason || req.body?.reason_key || "",
    ).trim();
    const details = normalizeReportDetails(req.body?.details);

    if (!getReportReasonOption(reasonKey, CONTROL_LINK_REPORT_REASON_BY_KEY)) {
      return res.status(400).json({
        ok: false,
        message: "Please choose a reason for the report.",
      });
    }

    if (!reporterUserId) {
      return res.status(403).json({
        ok: false,
        message: "You must be signed in to report a control link.",
      });
    }

    if (reporterUserId === ownerId) {
      return res.status(400).json({
        ok: false,
        message: "You can't report your own control link.",
      });
    }

    const ownerUser =
      db
        .prepare(
          `
          SELECT discord_id, username, global_name, control_link_display_name
          FROM users
          WHERE discord_id=?
        `,
        )
        .get(ownerId) || { discord_id: ownerId };

    try {
      createControlLinkReport({
        ownerUserId: ownerId,
        ownerUser,
        pairCode,
        reporterUser,
        reasonKey,
        reasonMap: CONTROL_LINK_REPORT_REASON_BY_KEY,
        details,
        req,
      });

      return res.json({
        ok: true,
        message: "Report sent. Thank you.",
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        message: err?.message || "Could not send that report.",
      });
    }
  },
);
}

module.exports = { registerControlLinkRoutes };
