const fs = require("fs");
const path = require("path");

function registerAdminRoutes(app, deps) {
  const {
    ALLOWLIST_PATH,
    ADMIN_ACTIVITY_RANGE_24H,
    ADMIN_ACTIVITY_RANGE_7D,
    BLOCKLIST_PATH,
    CONTROL_LINK_COMMAND_HISTORY_TYPE_KEYS,
    MAX_USER_STRIKES,
    NOTIFICATION_MENU_LIMIT,
    RESPONSES_DIR,
    REPORT_MEDIA_BACKUPS_DIR,
    appendHostToFile,
    broadcastNotificationToAllUsers,
    clearCustomSiteAvatar,
    clearCustomSiteBackground,
    clearCustomSiteBanner,
    clearCustomCommunityGroupAvatar,
    clearCustomCommunityGroupBanner,
    countCommandSenderBlocks,
    countReports,
    db,
    deleteUploadedFiles,
    escapeHtml,
    formatBytesCompact,
    formatCountLabel,
    genInviteCode,
    getAdminCommandActivityDatasets,
    getAllowSet,
    getBlockSet,
    getNotificationSummaryForUser,
    getPreferredDisplayName,
    getUserStrikeStatesByUserIds,
    inviteHash,
    isEnrollmentOpen,
    isManagedPathInDir,
    listAllUploadedFilesForAdmin,
    listControlLinkAssetsForAdmin,
    listRecentAdminNotificationEvents,
    listRecentReports,
    loadGroupsCatalog,
    logEvent,
    markAdminReportQueueNotificationsReadForUser,
    normalizeNotificationActionLabel,
    normalizeNotificationActionUrl,
    normalizeNotificationMessage,
    normalizeNotificationTitle,
    normalizeStoredMime,
    normalizeStrikeCount,
    parseIntSafe,
    removeHostFromFile,
    renderWithLayout,
    requireAdmin,
    requireBootstrapAdmin,
    requireDiscord,
    requireNotBanned,
    deleteMediaUrlResolverSite,
    listMediaUrlResolverSites,
    listSupportedMediaUrlResolvers,
    resolveReportForAdmin,
    groupAvatarUrl,
    groupBannerUrl,
    resolveStoredSiteAvatarPath,
    saveMediaUrlResolverSite,
    setSetting,
    setUserStrikeCountByAdmin,
    siteAvatarUrl,
    tryJson,
    wantsJson,
  } = deps;

  function renderGeneratedInviteCodesPage(res, codes) {
    const items = (Array.isArray(codes) ? codes : [])
      .map((code) => "<li><code>" + escapeHtml(code) + "</code></li>")
      .join("");

    return res.status(200).type("html").send(
      '<!doctype html>' +
        '<html lang="en">' +
        '<head>' +
        '<meta charset="utf-8" />' +
        '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
        '<title>Invites Generated</title>' +
        '<link rel="stylesheet" href="/css/main.css" />' +
        '</head>' +
        '<body>' +
        '<div class="wrap">' +
        '<main class="content">' +
        '<div class="card">' +
        '<div class="cardHd">Invite Codes Generated</div>' +
        '<div class="cardBd">' +
        '<p>Copy these now. You will not be able to view them again.</p>' +
        '<ol>' + items + '</ol>' +
        '<p><a class="link" href="/admin/invites">Back to Invites</a></p>' +
        '</div>' +
        '</div>' +
        '</main>' +
        '</div>' +
        '</body>' +
        '</html>',
    );
  }

  function getMediaResolverFlash(req) {
    const errorKey = String(req.query?.error || "").trim().toLowerCase();
    if (errorKey === "host") {
      return { text: "Enter a valid host or URL.", isError: true };
    }
    if (errorKey === "unsupported") {
      return {
        text: "That host does not match a supported media resolver yet.",
        isError: true,
      };
    }
    if (errorKey === "resolver") {
      return { text: "Choose a supported resolver type.", isError: true };
    }
    if (errorKey === "save") {
      return { text: "Could not save that resolver site.", isError: true };
    }
    if (errorKey === "delete") {
      return { text: "Could not delete that resolver site.", isError: true };
    }
    if (String(req.query?.saved || "") === "1") {
      return { text: "Resolver site saved.", isError: false };
    }
    if (String(req.query?.deleted || "") === "1") {
      return { text: "Resolver site deleted.", isError: false };
    }
    return { text: "", isError: false };
  }

  const RESPONSE_STORE_IMAGE_EXTS = new Set([
    ".avif",
    ".bmp",
    ".gif",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".webp",
  ]);

  function isResponseStoreImagePath(filePath) {
    const ext = path.extname(String(filePath || "")).trim().toLowerCase();
    return RESPONSE_STORE_IMAGE_EXTS.has(ext);
  }

  function listResponseStoreImagesForAdmin() {
    const baseDir = path.resolve(RESPONSES_DIR);
    if (!fs.existsSync(baseDir)) return [];

    const items = [];
    const stack = [{ absDir: baseDir, relDir: "" }];

    while (stack.length) {
      const current = stack.pop();
      let entries = [];

      try {
        entries = fs.readdirSync(current.absDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const relPath = current.relDir
          ? path.posix.join(current.relDir, entry.name)
          : entry.name;
        const absPath = path.resolve(current.absDir, entry.name);

        if (!isManagedPathInDir(absPath, baseDir)) continue;

        if (entry.isDirectory()) {
          stack.push({ absDir: absPath, relDir: relPath });
          continue;
        }

        if (!entry.isFile() || !isResponseStoreImagePath(entry.name)) continue;

        let stats = null;
        try {
          stats = fs.statSync(absPath);
        } catch {
          continue;
        }

        if (!stats.isFile()) continue;

        const modifiedAt = Number(stats.mtimeMs || stats.ctimeMs || Date.now());
        const bytes = Number(stats.size || 0);

        items.push({
          bytes,
          filename: relPath,
          modifiedAt,
          sizeLabel: formatBytesCompact(bytes),
          url: `/admin/screenshots/file?name=${encodeURIComponent(relPath)}`,
        });
      }
    }

    items.sort(
      (a, b) =>
        Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0) ||
        String(a.filename || "").localeCompare(String(b.filename || "")),
    );

    return items;
  }

app.get("/admin", requireDiscord, requireAdmin, (req, res) => {
  renderWithLayout(res, "pages/admin/admin_main", {
    title: "Admin Panel",
  });
});

app.get("/admin/media-resolvers", requireDiscord, requireAdmin, (req, res) => {
  const flash = getMediaResolverFlash(req);

  res.locals.adminMediaResolverSites = listMediaUrlResolverSites();
  res.locals.adminMediaResolverSupported = listSupportedMediaUrlResolvers();
  res.locals.adminMediaResolverFlash = flash.text;
  res.locals.adminMediaResolverFlashIsError = flash.isError;

  renderWithLayout(res, "pages/admin/media_resolvers/mr_main", {
    title: "Media URL Resolvers",
  });
});

app.post(
  "/admin/media-resolvers/site/save",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const host = String(req.body?.host || "").trim();
    const resolverKey = String(req.body?.resolverKey || "").trim();
    const enabledValue = String(req.body?.enabled || "").trim().toLowerCase();
    const enabled =
      enabledValue === ""
        ? true
        : !["0", "false", "off", "no"].includes(enabledValue);

    const result = saveMediaUrlResolverSite({
      host,
      resolverKey,
      enabled,
    });

    if (!result.ok) {
      const message = String(result.message || "").toLowerCase();
      if (message.includes("unsupported host")) {
        return res.redirect("/admin/media-resolvers?error=unsupported");
      }
      if (message.includes("host")) {
        return res.redirect("/admin/media-resolvers?error=host");
      }
      if (message.includes("resolver")) {
        return res.redirect("/admin/media-resolvers?error=resolver");
      }
      return res.redirect("/admin/media-resolvers?error=save");
    }

    logEvent({
      type: "admin_media_url_resolver_saved",
      actorUserId: req.user.discord_id,
      targetUserId: null,
      req,
      payload: {
        host: result.host,
        resolverKey: result.resolverKey,
        enabled: result.enabled,
      },
    });

    return res.redirect("/admin/media-resolvers?saved=1");
  },
);

app.post(
  "/admin/media-resolvers/site/delete",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const host = String(req.body?.host || "").trim();
    const result = deleteMediaUrlResolverSite({ host });
    if (!result.ok) {
      return res.redirect("/admin/media-resolvers?error=delete");
    }

    logEvent({
      type: "admin_media_url_resolver_deleted",
      actorUserId: req.user.discord_id,
      targetUserId: null,
      req,
      payload: {
        host: result.host,
      },
    });

    return res.redirect("/admin/media-resolvers?deleted=1");
  },
);

app.get("/admin/screenshots", requireDiscord, requireAdmin, (req, res) => {
  const screenshots = listResponseStoreImagesForAdmin();
  const totalBytes = screenshots.reduce(
    (sum, item) => sum + Number(item.bytes || 0),
    0,
  );

  res.locals.adminScreenshots = screenshots;
  res.locals.adminScreenshotsStats = {
    count: screenshots.length,
    totalBytes,
    totalBytesLabel: formatBytesCompact(totalBytes),
  };

  renderWithLayout(res, "pages/admin/screenshots/ss_main", {
    title: "Admin Screenshots",
  });
});

app.get(
  "/admin/screenshots/file",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const requestedName = String(req.query?.name || "").trim();
    const normalizedName = requestedName
      .split("\\")
      .join("/")
      .replace(/^\/+/, "");

    if (!normalizedName) {
      return res.status(404).type("text/plain").send("Screenshot not found.");
    }

    const baseDir = path.resolve(RESPONSES_DIR);
    const absPath = path.resolve(baseDir, normalizedName);

    if (
      !isManagedPathInDir(absPath, baseDir) ||
      !isResponseStoreImagePath(absPath) ||
      !fs.existsSync(absPath)
    ) {
      return res.status(404).type("text/plain").send("Screenshot not found.");
    }

    let stats = null;
    try {
      stats = fs.statSync(absPath);
    } catch {
      return res.status(404).type("text/plain").send("Screenshot not found.");
    }

    if (!stats.isFile()) {
      return res.status(404).type("text/plain").send("Screenshot not found.");
    }

    res.set("Cache-Control", "private, max-age=3600");
    res.set("X-Content-Type-Options", "nosniff");
    return res.sendFile(absPath);
  },
);

app.get("/admin/activity", requireDiscord, requireAdmin, (req, res) => {
  const requestedRange = String(req.query?.range || "").trim().toLowerCase();
  const range =
    requestedRange === ADMIN_ACTIVITY_RANGE_7D
      ? ADMIN_ACTIVITY_RANGE_7D
      : ADMIN_ACTIVITY_RANGE_24H;

  const datasets = getAdminCommandActivityDatasets();
  const selected =
    range === ADMIN_ACTIVITY_RANGE_7D ? datasets.daily : datasets.hourly;

  res.locals.adminActivityRange = range;
  res.locals.adminActivitySelected = selected;
  res.locals.adminActivityIncludesLabel =
    "Includes direct commands, group commands, and API commands.";

  renderWithLayout(res, "pages/admin/activity/act_main", {
    title: "Admin Activity",
  });
});

app.get("/admin/queues", requireDiscord, requireAdmin, (req, res) => {
  const queueState = listQueuedCommandsForAdmin(req, {
    q: req.query?.q,
    groupBy: req.query?.groupBy,
    page: req.query?.page,
  });

  res.locals.adminQueueQuery = queueState.query;
  res.locals.adminQueueGroupBy = queueState.groupBy;
  res.locals.adminQueueGroups = queueState.groups;
  res.locals.adminQueueItems = queueState.items;
  res.locals.adminQueueTotalCount = queueState.totalCount;
  res.locals.adminQueueSenderCount = queueState.uniqueSenderCount;
  res.locals.adminQueueReceiverCount = queueState.uniqueReceiverCount;
  setAdminQueuePageLocals(res, queueState);
  res.locals.adminQueueReceiverHref = buildAdminQueueHref({
    groupBy: "receiver",
    q: queueState.query,
    page: queueState.currentPage,
  });
  res.locals.adminQueueSenderHref = buildAdminQueueHref({
    groupBy: "sender",
    q: queueState.query,
    page: queueState.currentPage,
  });

  renderWithLayout(res, "pages/admin/queues/que_main", {
    title: "Queued Commands",
  });
});

app.post(
  "/admin/queues/:queueId/delete",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const deleted = deleteQueuedCommandByIdForAdmin(req.params.queueId);
    if (!deleted) {
      return res
        .status(404)
        .json({ ok: false, message: "Queued command not found." });
    }

    logEvent({
      type: "admin_queued_command_deleted",
      actorUserId: req.user.discord_id,
      targetUserId: String(deleted.owner_user_id || "").trim() || null,
      req,
      payload: {
        queue_id: String(deleted.id || "").trim(),
        owner_user_id: String(deleted.owner_user_id || "").trim() || null,
        actor_user_id: String(deleted.actor_user_id || "").trim() || null,
        source_kind: String(deleted.source_kind || "").trim() || null,
        source_id: String(deleted.source_id || "").trim() || null,
        command_type: String(deleted.command_type || "").trim() || null,
        created_at: Number(deleted.created_at || 0) || null,
      },
    });

    return res.json({
      ok: true,
      queueId: String(deleted.id || "").trim(),
      ownerUserId: String(deleted.owner_user_id || "").trim() || null,
    });
  },
);

app.post("/admin/queues/clear-all", requireDiscord, requireAdmin, (req, res) => {
  const result = clearAllQueuedCommandsForAdmin();

  logEvent({
    type: "admin_queued_commands_cleared_all",
    actorUserId: req.user.discord_id,
    targetUserId: null,
    req,
    payload: {
      cleared_count: Number(result.clearedCount || 0),
      receiver_count: Number(result.receiverCount || 0),
      sender_count: Number(result.senderCount || 0),
    },
  });

  return res.json({
    ok: true,
    clearedCount: Number(result.clearedCount || 0),
    receiverCount: Number(result.receiverCount || 0),
    senderCount: Number(result.senderCount || 0),
  });
});

app.get("/admin/notifications", requireDiscord, requireAdmin, (req, res) => {
  const userCountRow = db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
  const flashKey = req.query?.sent
    ? "sent"
    : String(req.query?.error || "").trim();
  const flashMap = {
    sent: { text: "Notification sent to all users.", isError: false },
    title: { text: "Title is required.", isError: true },
    message: { text: "Message is required.", isError: true },
    url: { text: "Action URL must start with / or http(s)://", isError: true },
    send: { text: "Could not send notifications.", isError: true },
  };

  res.locals.adminNotificationAudienceCount = Number(userCountRow?.n || 0);
  res.locals.adminNotificationEvents = listRecentAdminNotificationEvents(12);
  res.locals.adminNotificationFlash = flashMap[flashKey]?.text || "";
  res.locals.adminNotificationFlashIsError = !!flashMap[flashKey]?.isError;

  renderWithLayout(res, "pages/admin/notifications/noti_admin_main", {
    title: "PlayCtrl.me",
  });
});

app.get(
  "/admin/reports/:reportId/media-backup/:backupId",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const reportId = String(req.params.reportId || "").trim();
    const backupId = String(req.params.backupId || "").trim();
    if (!reportId || !backupId) {
      return res.status(404).type("html").send("Media backup not found.");
    }

    const row = db
      .prepare(
        `
        SELECT
          id,
          report_id,
          original_name,
          stored_name,
          file_path,
          mime
        FROM report_media_backups
        WHERE report_id=? AND id=?
        LIMIT 1
      `,
      )
      .get(reportId, backupId);

    if (!row) {
      return res.status(404).type("html").send("Media backup not found.");
    }

    const abs = path.resolve(String(row.file_path || ""));
    if (!isManagedPathInDir(abs, REPORT_MEDIA_BACKUPS_DIR) || !fs.existsSync(abs)) {
      return res.status(404).type("html").send("Media backup not found.");
    }

    const filename = path.basename(
      String(row.original_name || row.stored_name || "report-backup"),
    );
    const mime = normalizeStoredMime(row.mime, "application/octet-stream");
    res.type(mime);
    res.set(
      "Content-Disposition",
      `inline; filename="${filename.replace(/"/g, "")}"`,
    );
    return res.sendFile(abs);
  },
);

function getAdminReportFlash(query) {
  const flashKey = String(query?.flash || query?.error || "").trim();
  if (flashKey === "resolved") {
    const appliedStrikeCount = Math.max(
      0,
      Number(normalizeStrikeCount(query?.applied_strikes) ?? 0),
    );
    const strikeText =
      appliedStrikeCount > 0
        ? `${formatCountLabel(appliedStrikeCount, "strike")} issued.`
        : "No strikes issued.";
    const cappedText = String(query?.capped || "").trim() === "1"
      ? appliedStrikeCount > 0
        ? ` Only ${formatCountLabel(appliedStrikeCount, "strike")} could be applied before the ${MAX_USER_STRIKES}-strike maximum was reached.`
        : ` No additional strikes could be applied because the ${MAX_USER_STRIKES}-strike maximum was already reached.`
      : "";
    const autoBannedText = String(query?.auto_banned || "").trim() === "1"
      ? ` The user reached ${MAX_USER_STRIKES} strikes and was banned.`
      : "";
    return {
      text: `Report resolved and moved to history. ${strikeText}${cappedText}${autoBannedText}`.trim(),
      isError: false,
    };
  }

  const flashMap = {
    not_found: {
      text: "That report could not be found.",
      isError: true,
    },
    already_resolved: {
      text: "That report is already in history.",
      isError: true,
    },
    bad_strike_count: {
      text: `Strike count must be between 0 and ${MAX_USER_STRIKES}.`,
      isError: true,
    },
    resolve_failed: {
      text: "Could not resolve that report.",
      isError: true,
    },
  };

  return flashMap[flashKey] || { text: "", isError: false };
}

function setAdminNotificationSummaryLocals(res, viewerId) {
  const summary = getNotificationSummaryForUser(viewerId, {
    limit: NOTIFICATION_MENU_LIMIT,
  });
  res.locals.notificationMenuItems = summary.items;
  res.locals.notificationUnreadCount = summary.unreadCount;
  res.locals.notificationTotalCount = summary.totalCount;
}

function normalizePageNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function normalizeAdminQueueGroupBy(value) {
  return String(value || "").trim().toLowerCase() === "sender"
    ? "sender"
    : "receiver";
}

const ADMIN_QUEUE_GROUPS_PAGE_SIZE = 10;
const ADMIN_REPORTS_PAGE_SIZE = 10;
const ADMIN_BUILT_IN_GROUPS_PAGE_SIZE = 12;
const ADMIN_COMMUNITY_GROUPS_PAGE_SIZE = 12;

function formatQueueAgeLabel(createdAt) {
  const ts = Number(createdAt || 0);
  if (!Number.isFinite(ts) || ts <= 0) return "Unknown age";

  const deltaMs = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(deltaMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMinutes = minutes % 60;
    return remMinutes > 0 ? `${hours}h ${remMinutes}m ago` : `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`;
}

function humanizeCommandType(commandType) {
  const safeType = String(commandType || "").trim();
  if (!safeType) return "Unknown command";

  return safeType
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncateInlineText(value, max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function buildQueuedCommandSummary(row, payloadObj) {
  const type = String(row?.command_type || "").trim();
  const payload = payloadObj && typeof payloadObj === "object" ? payloadObj : null;
  if (!payload) return "";

  if (type === "subliminal_message") {
    const messages = (Array.isArray(payload.messages) ? payload.messages : [])
      .map((value) => truncateInlineText(value || "", 80))
      .filter(Boolean);
    if (!messages.length) return "";
    const preview = messages.slice(0, 3).join(" • ");
    return messages.length > 3
      ? `${preview} • +${messages.length - 3} more`
      : preview;
  }

  if (type === "popup" || type === "write_for_me") {
    const message = truncateInlineText(payload.message || "", 180);
    const times = Number(payload.times || 0);
    const bits = [];
    if (message) bits.push(message);
    if (type === "write_for_me" && Number.isFinite(times) && times > 1) {
      bits.push(`times=${times}`);
    }
    return bits.join(" • ");
  }

  if (
    type === "open_url" ||
    type === "image_popup" ||
    type === "fullscreen_popup" ||
    type === "spiral_overlay" ||
    type === "set_wallpaper"
  ) {
    return truncateInlineText(payload.url || "", 180);
  }

  if (type === "play_sound" || type === "play_sound_loop") {
    if (String(payload.kind || "").trim() === "tone") {
      return `baseHz=${Number(payload.baseHz)} • beatHz=${Number(payload.beatHz)}`;
    }
    if (String(payload.kind || "").trim() === "builtin") {
      return truncateInlineText(payload.name || "", 120);
    }
    return truncateInlineText(payload.url || "", 180);
  }

  return truncateInlineText(JSON.stringify(payload), 180);
}

function getQueueMediaPreviewKindFromUrl(url) {
  const safeUrl = String(url || "").trim().toLowerCase();
  if (!safeUrl) return "";

  const cleanUrl = safeUrl.split("#")[0].split("?")[0];
  if (
    cleanUrl.endsWith(".mp3") ||
    cleanUrl.endsWith(".wav") ||
    cleanUrl.endsWith(".ogg") ||
    cleanUrl.endsWith(".oga") ||
    cleanUrl.endsWith(".m4a") ||
    cleanUrl.endsWith(".aac") ||
    cleanUrl.endsWith(".flac")
  ) {
    return "audio";
  }

  if (
    cleanUrl.endsWith(".webm") ||
    cleanUrl.endsWith(".ogv") ||
    cleanUrl.endsWith(".mp4") ||
    cleanUrl.endsWith(".mov") ||
    cleanUrl.endsWith(".m4v")
  ) {
    return "video";
  }

  if (
    cleanUrl.endsWith(".png") ||
    cleanUrl.endsWith(".jpg") ||
    cleanUrl.endsWith(".jpeg") ||
    cleanUrl.endsWith(".webp") ||
    cleanUrl.endsWith(".gif") ||
    cleanUrl.endsWith(".bmp") ||
    cleanUrl.endsWith(".svg")
  ) {
    return "image";
  }

  return "";
}

function isSafeQueuePreviewUrl(req, rawUrl) {
  const safeUrl = String(rawUrl || "").trim();
  if (!safeUrl) return false;

  try {
    const parsed = new URL(safeUrl);
    return (
      parsed.origin === `${req.protocol}://${req.get("host")}` &&
      String(parsed.pathname || "").startsWith("/uploads/")
    );
  } catch {
    return safeUrl.startsWith("/uploads/");
  }
}

function buildQueuePayloadPreview(req, row, payloadObj) {
  const type = String(row?.command_type || "").trim();
  const payload = payloadObj && typeof payloadObj === "object" ? payloadObj : null;
  const safeUrl = String(payload?.url || "").trim();
  if (!payload || !safeUrl || !isSafeQueuePreviewUrl(req, safeUrl)) return [];

  let previewKind = "";
  if (type === "image_popup" || type === "fullscreen_popup") {
    previewKind = "image";
  } else if (type === "play_sound" || type === "play_sound_loop") {
    previewKind =
      String(payload.kind || "").trim() === "url"
        ? "audio"
        : "";
  } else if (type === "set_wallpaper") {
    previewKind = getQueueMediaPreviewKindFromUrl(safeUrl);
  }

  if (!previewKind) return [];

  return [
    {
      id: "",
      originalName: "",
      storedName: "",
      mime: "",
      ext: "",
      bytes: 0,
      previewKind,
      mediaGroup: previewKind === "audio" ? "audio" : "visual",
      url: safeUrl,
    },
  ];
}

function buildQueuedCommandSourceLabel(row) {
  const sourceKind = String(row?.source_kind || "").trim() || "direct";
  const sourceId = String(row?.source_id || "").trim();

  if (sourceKind === "group") {
    return sourceId ? `Group: ${sourceId}` : "Group command";
  }
  if (sourceKind === "api") {
    return sourceId ? `API via ${sourceId}` : "API command";
  }
  return sourceId ? `Direct via ${sourceId}` : "Direct command";
}

function buildAdminQueueHref({ groupBy = "receiver", q = "", page = 1 } = {}) {
  const params = new URLSearchParams();
  const safeGroupBy = normalizeAdminQueueGroupBy(groupBy);
  const safePage = normalizePageNumber(page);
  if (safeGroupBy !== "receiver") params.set("groupBy", safeGroupBy);
  const safeQuery = String(q || "").trim();
  if (safeQuery) params.set("q", safeQuery);
  if (safePage > 1) params.set("page", String(safePage));
  const qs = params.toString();
  return qs ? `/admin/queues?${qs}` : "/admin/queues";
}

function getQueuedCommandRowById(queueId) {
  const id = String(queueId || "").trim();
  if (!id) return null;
  return (
    db
      .prepare(
        `
        SELECT
          id,
          owner_user_id,
          actor_user_id,
          source_kind,
          source_id,
          command_type,
          payload_json,
          created_at
        FROM queued_commands
        WHERE id=?
        LIMIT 1
      `,
      )
      .get(id) || null
  );
}

function deleteQueuedCommandByIdForAdmin(queueId) {
  const id = String(queueId || "").trim();
  if (!id) return null;

  const tx = db.transaction(() => {
    const row = getQueuedCommandRowById(id);
    if (!row) return null;
    const info = db.prepare(`DELETE FROM queued_commands WHERE id=?`).run(id);
    if (!Number(info?.changes || 0)) return null;
    return row;
  });

  return tx();
}

function clearQueuedCommandsForOwnerForAdmin(ownerUserId) {
  const ownerId = String(ownerUserId || "").trim();
  if (!ownerId) return { clearedCount: 0 };

  const info = db
    .prepare(`DELETE FROM queued_commands WHERE owner_user_id=?`)
    .run(ownerId);

  return {
    ownerUserId: ownerId,
    clearedCount: Number(info?.changes || 0),
  };
}

function clearQueuedCommandsForActorForAdmin(actorUserId) {
  const actorId = String(actorUserId || "").trim();
  if (!actorId) return { clearedCount: 0 };

  const info = db
    .prepare(`DELETE FROM queued_commands WHERE actor_user_id=?`)
    .run(actorId);

  return {
    actorUserId: actorId,
    clearedCount: Number(info?.changes || 0),
  };
}

function clearAllQueuedCommandsForAdmin() {
  const counts = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total_count,
        COUNT(DISTINCT owner_user_id) AS receiver_count,
        COUNT(DISTINCT actor_user_id) AS sender_count
      FROM queued_commands
    `,
    )
    .get();

  const info = db.prepare(`DELETE FROM queued_commands`).run();

  return {
    clearedCount: Number(info?.changes || 0),
    receiverCount: Number(counts?.receiver_count || 0),
    senderCount: Number(counts?.sender_count || 0),
  };
}

function listQueuedCommandsForAdmin(
  req,
  { q = "", groupBy = "receiver", page = 1 } = {},
) {
  const safeGroupBy = normalizeAdminQueueGroupBy(groupBy);
  const safeQuery = String(q || "").trim();
  const requestedPage = normalizePageNumber(page);
  const where = [];
  const args = {};

  if (safeQuery) {
    where.push(`
      (
        qc.id LIKE @q OR
        qc.owner_user_id LIKE @q OR
        IFNULL(qc.actor_user_id, '') LIKE @q OR
        qc.command_type LIKE @q OR
        IFNULL(qc.source_kind, '') LIKE @q OR
        IFNULL(qc.source_id, '') LIKE @q OR
        IFNULL(qc.payload_json, '') LIKE @q OR
        IFNULL(owner.username, '') LIKE @q OR
        IFNULL(owner.global_name, '') LIKE @q OR
        IFNULL(actor.username, '') LIKE @q OR
        IFNULL(actor.global_name, '') LIKE @q OR
        IFNULL(pc.code_plain, '') LIKE @q
      )
    `);
    args.q = `%${safeQuery}%`;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy =
    safeGroupBy === "sender"
      ? `
          LOWER(COALESCE(actor.global_name, actor.username, qc.actor_user_id, 'zzz-system')) ASC,
          LOWER(COALESCE(owner.global_name, owner.username, qc.owner_user_id, '')) ASC,
          qc.created_at ASC,
          qc.id ASC
        `
      : `
          LOWER(COALESCE(owner.global_name, owner.username, qc.owner_user_id, 'zzz-unknown')) ASC,
          LOWER(COALESCE(actor.global_name, actor.username, qc.actor_user_id, '')) ASC,
          qc.created_at ASC,
          qc.id ASC
        `;

  const rows = db
    .prepare(
      `
      SELECT
        qc.id,
        qc.owner_user_id,
        qc.actor_user_id,
        qc.source_kind,
        qc.source_id,
        qc.command_type,
        qc.payload_json,
        qc.created_at,
        pc.code_plain AS owner_pair_code,
        owner.discord_id AS owner_id,
        owner.username AS owner_username,
        owner.global_name AS owner_global_name,
        owner.avatar AS owner_avatar,
        actor.discord_id AS actor_id,
        actor.username AS actor_username,
        actor.global_name AS actor_global_name,
        actor.avatar AS actor_avatar
      FROM queued_commands qc
      LEFT JOIN users owner ON owner.discord_id = qc.owner_user_id
      LEFT JOIN users actor ON actor.discord_id = qc.actor_user_id
      LEFT JOIN pair_codes pc
        ON pc.rowid = (
          SELECT MAX(rowid) FROM pair_codes WHERE user_id = qc.owner_user_id
        )
      ${whereSql}
      ORDER BY ${orderBy}
    `,
    )
    .all(args);

  const queueIds = rows
    .map((row) => String(row?.id || "").trim())
    .filter(Boolean);
  const uploadRowsByQueueId = new Map();

  if (queueIds.length) {
    const placeholders = queueIds.map(() => "?").join(", ");
    const uploadRows = db
      .prepare(
        `
        SELECT
          qcur.queue_id,
          uf.id AS upload_id,
          uf.original_name,
          uf.stored_name,
          uf.mime,
          uf.ext,
          uf.bytes,
          uf.preview_kind,
          uf.media_group
        FROM queued_command_upload_refs qcur
        JOIN uploaded_files uf ON uf.id = qcur.upload_id
        WHERE qcur.queue_id IN (${placeholders})
        ORDER BY qcur.created_at ASC, uf.created_at ASC, uf.id ASC
      `,
      )
      .all(queueIds);

    for (const uploadRow of uploadRows) {
      const queueId = String(uploadRow?.queue_id || "").trim();
      if (!queueId) continue;
      const items = uploadRowsByQueueId.get(queueId) || [];
      items.push({
        id: String(uploadRow?.upload_id || "").trim(),
        originalName: String(uploadRow?.original_name || "").trim(),
        storedName: String(uploadRow?.stored_name || "").trim(),
        mime: String(uploadRow?.mime || "").trim(),
        ext: String(uploadRow?.ext || "").trim().toLowerCase(),
        bytes: Number(uploadRow?.bytes || 0),
        previewKind: String(uploadRow?.preview_kind || "").trim() || "image",
        mediaGroup: String(uploadRow?.media_group || "").trim() || "visual",
        url: `/uploads/${encodeURIComponent(String(uploadRow?.stored_name || "").trim())}`,
      });
      uploadRowsByQueueId.set(queueId, items);
    }
  }

  const items = rows.map((row) => {
    const payloadObj = tryJson(row.payload_json);
    const queueId = String(row.id || "").trim();
    const actorId = String(row.actor_id || row.actor_user_id || "").trim() || null;
    const ownerId = String(row.owner_id || row.owner_user_id || "").trim() || null;
    const actorDisplayName = actorId
      ? getPreferredDisplayName({
          discord_id: actorId,
          username: row.actor_username,
          global_name: row.actor_global_name,
        }) || actorId
      : "System / Unknown";
    const ownerDisplayName = ownerId
      ? getPreferredDisplayName({
          discord_id: ownerId,
          username: row.owner_username,
          global_name: row.owner_global_name,
        }) || ownerId
      : "Unknown recipient";
    const mediaPreviews =
      uploadRowsByQueueId.get(queueId) || buildQueuePayloadPreview(req, row, payloadObj);

    return {
      id: queueId,
      commandType: String(row.command_type || "").trim(),
      commandTypeLabel: humanizeCommandType(row.command_type),
      sourceKind: String(row.source_kind || "").trim() || "direct",
      sourceId: String(row.source_id || "").trim(),
      sourceLabel: buildQueuedCommandSourceLabel(row),
      createdAt: Number(row.created_at || 0),
      createdAtLabel: Number(row.created_at || 0)
        ? new Date(Number(row.created_at)).toLocaleString()
        : "Unknown time",
      ageLabel: formatQueueAgeLabel(row.created_at),
      summary: buildQueuedCommandSummary(row, payloadObj),
      mediaPreviews,
      prettyPayload:
        payloadObj && typeof payloadObj === "object"
          ? JSON.stringify(payloadObj, null, 2)
          : String(row.payload_json || ""),
      actor: {
        id: actorId,
        displayName: actorDisplayName,
        username: String(row.actor_username || "").trim(),
        avatarUrl: actorId ? siteAvatarUrl({ discord_id: actorId }, 64) : "",
        adminUrl: actorId ? `/admin/users?q=${encodeURIComponent(actorId)}` : "",
      },
      owner: {
        id: ownerId,
        displayName: ownerDisplayName,
        username: String(row.owner_username || "").trim(),
        avatarUrl: ownerId ? siteAvatarUrl({ discord_id: ownerId }, 64) : "",
        adminUrl: ownerId ? `/admin/users?q=${encodeURIComponent(ownerId)}` : "",
        pairCode: String(row.owner_pair_code || "").trim(),
      },
    };
  });

  const groups = [];
  const groupMap = new Map();

  for (const item of items) {
    const groupUser = safeGroupBy === "sender" ? item.actor : item.owner;
    const groupKey = groupUser.id
      ? `${safeGroupBy}:${groupUser.id}`
      : `${safeGroupBy}:system`;
    const hasGroupUserId = !!groupUser.id;
    let group = groupMap.get(groupKey);

    if (!group) {
      group = {
        key: groupKey,
        userId: groupUser.id || null,
        displayName:
          safeGroupBy === "sender" && !hasGroupUserId
            ? "System / Unknown sender"
            : groupUser.displayName ||
              (safeGroupBy === "receiver"
                ? "Unknown recipient"
                : "Unknown sender"),
        avatarUrl: groupUser.avatarUrl || "",
        adminUrl: groupUser.adminUrl || "",
        meta:
          safeGroupBy === "sender"
            ? groupUser.id
              ? groupUser.id
              : "No sender user ID"
            : [
                groupUser.id || "Unknown recipient",
                item.owner.pairCode ? `pair ${item.owner.pairCode}` : "",
              ]
                .filter(Boolean)
                .join(" • "),
        count: 0,
        items: [],
      };
      groupMap.set(groupKey, group);
      groups.push(group);
    }

    group.count += 1;
    group.items.push(item);
  }

  const senderIds = new Set(
    items.map((item) => String(item.actor.id || "").trim()).filter(Boolean),
  );
  const receiverIds = new Set(
    items.map((item) => String(item.owner.id || "").trim()).filter(Boolean),
  );
  const totalGroupCount = groups.length;
  const totalPages = Math.max(
    1,
    Math.ceil(totalGroupCount / ADMIN_QUEUE_GROUPS_PAGE_SIZE),
  );
  const currentPage = Math.min(requestedPage, totalPages);
  const groupOffset = (currentPage - 1) * ADMIN_QUEUE_GROUPS_PAGE_SIZE;
  const pagedGroups = groups.slice(
    groupOffset,
    groupOffset + ADMIN_QUEUE_GROUPS_PAGE_SIZE,
  );

  return {
    groupBy: safeGroupBy,
    query: safeQuery,
    items,
    groups: pagedGroups,
    totalCount: items.length,
    uniqueSenderCount: senderIds.size,
    uniqueReceiverCount: receiverIds.size,
    totalGroupCount,
    currentPage,
    totalPages,
  };
}

function setAdminQueuePageLocals(res, queueState) {
  const totalGroups = Math.max(0, Number(queueState?.totalGroupCount || 0));
  const safeCurrentPage = normalizePageNumber(queueState?.currentPage);
  const safeTotalPages = Math.max(1, Number(queueState?.totalPages || 0) || 1);
  const visibleGroups = Array.isArray(queueState?.groups) ? queueState.groups : [];
  const pageStart = totalGroups
    ? (safeCurrentPage - 1) * ADMIN_QUEUE_GROUPS_PAGE_SIZE + 1
    : 0;
  const pageEnd = totalGroups
    ? pageStart + Math.max(visibleGroups.length - 1, 0)
    : 0;

  res.locals.adminQueueTotalGroupCount = totalGroups;
  res.locals.adminQueueCurrentPage = safeCurrentPage;
  res.locals.adminQueueTotalPages = safeTotalPages;
  res.locals.adminQueueHasPrevPage = safeCurrentPage > 1;
  res.locals.adminQueueHasNextPage = safeCurrentPage < safeTotalPages;
  res.locals.adminQueuePrevPageHref = buildAdminQueueHref({
    groupBy: queueState?.groupBy,
    q: queueState?.query,
    page: safeCurrentPage - 1,
  });
  res.locals.adminQueueNextPageHref = buildAdminQueueHref({
    groupBy: queueState?.groupBy,
    q: queueState?.query,
    page: safeCurrentPage + 1,
  });
  res.locals.adminQueuePageSummary = totalGroups
    ? `Showing groups ${pageStart}-${pageEnd} of ${totalGroups}.`
    : "";
}

function buildAdminReportsPageHref(mode, page) {
  const base = mode === "history" ? "/admin/reports/history" : "/admin/reports";
  const safePage = normalizePageNumber(page);
  return safePage > 1 ? `${base}?page=${safePage}` : base;
}

function getAdminCommandBlockFlash(query) {
  if (String(query?.unblocked || "").trim() === "1") {
    return {
      text: "Command sender block removed.",
      isError: false,
    };
  }

  const flashMap = {
    missing: {
      text: "Missing command sender block details.",
      isError: true,
    },
    not_found: {
      text: "That command sender block could not be found.",
      isError: true,
    },
    failed: {
      text: "Could not remove that command sender block.",
      isError: true,
    },
  };

  return flashMap[String(query?.error || "").trim()] || {
    text: "",
    isError: false,
  };
}

function buildAdminCommandBlockUser(row, prefix, fallbackUserId) {
  const safePrefix = String(prefix || "");
  const userId = String(fallbackUserId || "").trim();
  const user = {
    discord_id: userId,
    username: String(row?.[`${safePrefix}_username`] || "").trim(),
    global_name: String(row?.[`${safePrefix}_global_name`] || "").trim(),
    control_link_display_name: String(
      row?.[`${safePrefix}_control_link_display_name`] || "",
    ).trim(),
  };

  return {
    userId,
    username: user.username,
    globalName: user.global_name,
    displayName: getPreferredDisplayName(user) || userId || "Unknown user",
    adminUrl: userId ? `/admin/users?q=${encodeURIComponent(userId)}` : "",
  };
}

function formatAdminCommandBlockTime(value) {
  const ts = Number(value || 0);
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

function listCommandSenderBlockGroupsForAdmin() {
  const rows = db
    .prepare(
      `
      SELECT
        b.owner_user_id,
        b.blocked_user_id,
        b.source_event_id,
        b.created_at,
        owner.username AS owner_username,
        owner.global_name AS owner_global_name,
        owner.control_link_display_name AS owner_control_link_display_name,
        blocked.username AS blocked_username,
        blocked.global_name AS blocked_global_name,
        blocked.control_link_display_name AS blocked_control_link_display_name
      FROM command_sender_blocks b
      LEFT JOIN users owner ON owner.discord_id = b.owner_user_id
      LEFT JOIN users blocked ON blocked.discord_id = b.blocked_user_id
      ORDER BY
        COALESCE(
          NULLIF(TRIM(blocked.control_link_display_name), ''),
          NULLIF(TRIM(blocked.global_name), ''),
          NULLIF(TRIM(blocked.username), ''),
          b.blocked_user_id
        ) COLLATE NOCASE ASC,
        b.created_at DESC,
        b.owner_user_id ASC
    `,
    )
    .all();

  const groupsByBlockedUserId = new Map();

  rows.forEach((row) => {
    const ownerUserId = String(row?.owner_user_id || "").trim();
    const blockedUserId = String(row?.blocked_user_id || "").trim();
    if (!ownerUserId || !blockedUserId) return;

    let group = groupsByBlockedUserId.get(blockedUserId);
    if (!group) {
      const blockedUser = buildAdminCommandBlockUser(
        row,
        "blocked",
        blockedUserId,
      );
      group = {
        ...blockedUser,
        blockerCount: 0,
        latestBlockedAt: 0,
        latestBlockedLabel: "",
        blockers: [],
      };
      groupsByBlockedUserId.set(blockedUserId, group);
    }

    const createdAt = Number(row?.created_at || 0);
    if (createdAt > group.latestBlockedAt) {
      group.latestBlockedAt = createdAt;
      group.latestBlockedLabel = formatAdminCommandBlockTime(createdAt);
    }

    group.blockers.push({
      ...buildAdminCommandBlockUser(row, "owner", ownerUserId),
      sourceEventId: String(row?.source_event_id || "").trim(),
      createdAt,
      createdIso: createdAt ? new Date(createdAt).toISOString() : "",
      createdLabel: formatAdminCommandBlockTime(createdAt),
    });
    group.blockerCount = group.blockers.length;
  });

  return Array.from(groupsByBlockedUserId.values());
}

function setAdminReportPageLocals(res, {
  items,
  totalCount,
  openCount,
  resolvedCount,
  mode,
  flash,
  currentPage,
  totalPages,
}) {
  const isHistory = mode === "history";
  const safeCurrentPage = normalizePageNumber(currentPage);
  const safeTotalPages = Math.max(1, Number(totalPages || 0) || 1);
  const pageStart = totalCount
    ? (safeCurrentPage - 1) * ADMIN_REPORTS_PAGE_SIZE + 1
    : 0;
  const pageEnd = totalCount ? pageStart + Math.max((items || []).length - 1, 0) : 0;

  res.locals.adminReportCount = totalCount;
  res.locals.adminReportItems = items;
  res.locals.adminReportTruncated = totalCount > items.length;
  res.locals.adminOpenReportCount = openCount;
  res.locals.adminResolvedReportCount = resolvedCount;
  res.locals.adminReportMode = isHistory ? "history" : "open";
  res.locals.adminReportPageTitle = isHistory ? "Reports History" : "Reports";
  res.locals.adminReportPageSubhead = isHistory
    ? "Resolved reports kept for admin reference."
    : "Newest open reports for admin review across control links and hidden command senders.";
  res.locals.adminReportEmptyText = isHistory
    ? "No reports have been resolved yet."
    : "No open reports need review right now.";
  res.locals.adminReportModeCountLabel = isHistory
    ? "Resolved reports"
    : "Open reports";
  res.locals.adminReportShowResolveAction = !isHistory;
  res.locals.adminReportModeHref = isHistory ? "/admin/reports" : "/admin/reports/history";
  res.locals.adminReportModeLinkLabel = isHistory ? "Open Reports" : "Reports History";
  res.locals.adminReportFlash = flash?.text || "";
  res.locals.adminReportFlashIsError = !!flash?.isError;
  res.locals.adminReportCurrentPage = safeCurrentPage;
  res.locals.adminReportTotalPages = safeTotalPages;
  res.locals.adminReportHasPrevPage = safeCurrentPage > 1;
  res.locals.adminReportHasNextPage = safeCurrentPage < safeTotalPages;
  res.locals.adminReportPrevPageHref = buildAdminReportsPageHref(
    mode,
    safeCurrentPage - 1,
  );
  res.locals.adminReportNextPageHref = buildAdminReportsPageHref(
    mode,
    safeCurrentPage + 1,
  );
  res.locals.adminReportPageSummary = totalCount
    ? `Showing ${pageStart}-${pageEnd} of ${totalCount}.`
    : "";
}

app.get("/admin/reports", requireDiscord, requireAdmin, (req, res) => {
  const viewerId = String(req.user?.discord_id || "").trim();
  markAdminReportQueueNotificationsReadForUser(viewerId);
  setAdminNotificationSummaryLocals(res, viewerId);

  const openCount = countReports({ resolved: false });
  const resolvedCount = countReports({ resolved: true });
  const totalPages = Math.max(
    1,
    Math.ceil(openCount / ADMIN_REPORTS_PAGE_SIZE),
  );
  const currentPage = Math.min(
    normalizePageNumber(req.query?.page),
    totalPages,
  );
  const items = listRecentReports(ADMIN_REPORTS_PAGE_SIZE, {
    resolved: false,
    offset: (currentPage - 1) * ADMIN_REPORTS_PAGE_SIZE,
  });
  setAdminReportPageLocals(res, {
    items,
    totalCount: openCount,
    openCount,
    resolvedCount,
    mode: "open",
    flash: getAdminReportFlash(req.query),
    currentPage,
    totalPages,
  });

  renderWithLayout(res, "pages/admin/reports/rpt_main", {
    title: "Reports",
  });
});

app.get("/admin/reports/history", requireDiscord, requireAdmin, (req, res) => {
  const viewerId = String(req.user?.discord_id || "").trim();
  setAdminNotificationSummaryLocals(res, viewerId);

  const openCount = countReports({ resolved: false });
  const resolvedCount = countReports({ resolved: true });
  const totalPages = Math.max(
    1,
    Math.ceil(resolvedCount / ADMIN_REPORTS_PAGE_SIZE),
  );
  const currentPage = Math.min(
    normalizePageNumber(req.query?.page),
    totalPages,
  );
  const items = listRecentReports(ADMIN_REPORTS_PAGE_SIZE, {
    resolved: true,
    offset: (currentPage - 1) * ADMIN_REPORTS_PAGE_SIZE,
  });
  setAdminReportPageLocals(res, {
    items,
    totalCount: resolvedCount,
    openCount,
    resolvedCount,
    mode: "history",
    flash: getAdminReportFlash(req.query),
    currentPage,
    totalPages,
  });

  renderWithLayout(res, "pages/admin/reports/rpt_main", {
    title: "Reports History",
  });
});

app.post(
  "/admin/reports/:reportId/resolve",
  requireDiscord,
  requireAdmin,
  requireNotBanned,
  (req, res) => {
    const reportId = String(req.params.reportId || "").trim();
    const viewerId = String(req.user?.discord_id || "").trim();
    const requestedStrikeCount = normalizeStrikeCount(req.body?.strike_count);
    if (requestedStrikeCount === null) {
      const errorKey = "bad_strike_count";
      if (wantsJson(req)) {
        return res.status(400).json({
          ok: false,
          message: `Strike count must be between 0 and ${MAX_USER_STRIKES}.`,
        });
      }
      return res.redirect(`/admin/reports?error=${encodeURIComponent(errorKey)}`);
    }

    const result = resolveReportForAdmin(reportId, viewerId, {
      req,
      requestedStrikeCount,
    });

    if (!result.ok) {
      const errorKey = result.code || "resolve_failed";
      if (wantsJson(req)) {
        return res.status(400).json({
          ok: false,
          message: result.message || "Could not resolve that report.",
        });
      }
      return res.redirect(`/admin/reports?error=${encodeURIComponent(errorKey)}`);
    }

    if (wantsJson(req)) {
      return res.json({
        ok: true,
        appliedStrikeCount: result.appliedStrikeCount,
        finalStrikeCount: result.finalStrikeCount,
        didBan: !!result.didBan,
      });
    }

    const params = new URLSearchParams();
    params.set("flash", "resolved");
    params.set("applied_strikes", String(result.appliedStrikeCount || 0));
    if (result.strikeCapped) params.set("capped", "1");
    if (result.didBan) params.set("auto_banned", "1");
    return res.redirect(`/admin/reports?${params.toString()}`);
  },
);

app.get("/admin/command-blocks", requireDiscord, requireAdmin, (req, res) => {
  const totalCount = countCommandSenderBlocks();
  const groups = listCommandSenderBlockGroupsForAdmin();
  const blockerUserIds = new Set();
  groups.forEach((group) => {
    (group.blockers || []).forEach((blocker) => {
      const userId = String(blocker?.userId || "").trim();
      if (userId) blockerUserIds.add(userId);
    });
  });
  const flash = getAdminCommandBlockFlash(req.query);

  res.locals.adminCommandBlockCount = totalCount;
  res.locals.adminCommandBlockBlockedUserCount = groups.length;
  res.locals.adminCommandBlockBlockerUserCount = blockerUserIds.size;
  res.locals.adminCommandBlockGroups = groups;
  res.locals.adminCommandBlockFlash = flash.text;
  res.locals.adminCommandBlockFlashIsError = flash.isError;

  renderWithLayout(res, "pages/admin/command_blocks/cb_main", {
    title: "Command Blocks",
  });
});

app.post(
  "/admin/command-blocks/unblock",
  requireDiscord,
  requireAdmin,
  requireNotBanned,
  (req, res) => {
    const ownerUserId = String(req.body?.owner_user_id || "").trim();
    const blockedUserId = String(req.body?.blocked_user_id || "").trim();

    function sendError(status, key, message) {
      if (wantsJson(req)) {
        return res.status(status).json({ ok: false, message });
      }
      return res.redirect(`/admin/command-blocks?error=${encodeURIComponent(key)}`);
    }

    if (!ownerUserId || !blockedUserId) {
      return sendError(400, "missing", "Missing command sender block details.");
    }

    const row = db
      .prepare(
        `
        SELECT owner_user_id, blocked_user_id, source_event_id, created_at
        FROM command_sender_blocks
        WHERE owner_user_id=? AND blocked_user_id=?
        LIMIT 1
      `,
      )
      .get(ownerUserId, blockedUserId);

    if (!row) {
      return sendError(404, "not_found", "That command sender block could not be found.");
    }

    try {
      const result = db
        .prepare(
          `
          DELETE FROM command_sender_blocks
          WHERE owner_user_id=? AND blocked_user_id=?
        `,
        )
        .run(ownerUserId, blockedUserId);

      if (!result.changes) {
        return sendError(404, "not_found", "That command sender block could not be found.");
      }

      logEvent({
        type: "admin_command_sender_unblocked",
        actorUserId: req.user.discord_id,
        targetUserId: blockedUserId,
        req,
        payload: {
          ownerUserId,
          blockedUserId,
          sourceEventId: String(row.source_event_id || "").trim() || null,
          originalCreatedAt: Number(row.created_at || 0),
        },
      });

      if (wantsJson(req)) {
        return res.json({
          ok: true,
          ownerUserId,
          blockedUserId,
        });
      }

      return res.redirect("/admin/command-blocks?unblocked=1");
    } catch (err) {
      return sendError(
        500,
        "failed",
        err?.message || "Could not remove that command sender block.",
      );
    }
  },
);

app.post(
  "/admin/notifications/send",
  requireDiscord,
  requireAdmin,
  requireNotBanned,
  (req, res) => {
    const title = normalizeNotificationTitle(req.body?.title);
    const message = normalizeNotificationMessage(req.body?.message);
    const actionUrlRaw = String(req.body?.action_url || "").trim();
    const actionUrl = normalizeNotificationActionUrl(actionUrlRaw);
    const actionLabel = normalizeNotificationActionLabel(req.body?.action_label);

    if (!title) {
      const msg = "Title is required.";
      if (wantsJson(req)) return res.status(400).json({ ok: false, message: msg });
      return res.redirect("/admin/notifications?error=title");
    }

    if (!message) {
      const msg = "Message is required.";
      if (wantsJson(req)) return res.status(400).json({ ok: false, message: msg });
      return res.redirect("/admin/notifications?error=message");
    }

    if (actionUrlRaw && !actionUrl) {
      const msg = "Action URL must start with / or http(s)://";
      if (wantsJson(req)) return res.status(400).json({ ok: false, message: msg });
      return res.redirect("/admin/notifications?error=url");
    }

    try {
      const result = broadcastNotificationToAllUsers({
        kind: "admin_broadcast",
        title,
        message,
        actionUrl,
        actionLabel,
        meta: {
          from: "admin_broadcast",
        },
        createdBy: req.user.discord_id,
        sourceType: "admin_broadcast",
      });

      logEvent({
        type: "admin_notifications_broadcast",
        actorUserId: req.user.discord_id,
        req,
        payload: {
          title,
          message,
          actionUrl,
          actionLabel,
          targetCount: result.count,
        },
      });

      if (!wantsJson(req)) {
        return res.redirect("/admin/notifications?sent=1");
      }

      return res.json({
        ok: true,
        sentCount: result.count,
      });
    } catch (err) {
      const messageText = err?.message || "Could not send notifications.";
      if (!wantsJson(req)) {
        return res.redirect("/admin/notifications?error=send");
      }
      return res.status(500).json({
        ok: false,
        message: messageText,
      });
    }
  },
);

function buildAdminGroupsPageHref({
  q = "",
  groupsPage = 1,
  communityPage = 1,
} = {}) {
  const params = new URLSearchParams();
  const safeQ = String(q || "").trim();
  const safeGroupsPage = normalizePageNumber(groupsPage);
  const safeCommunityPage = normalizePageNumber(communityPage);

  if (safeQ) params.set("q", safeQ);
  if (safeGroupsPage > 1) params.set("groupsPage", String(safeGroupsPage));
  if (safeCommunityPage > 1) {
    params.set("communityPage", String(safeCommunityPage));
  }

  const query = params.toString();
  return query ? `/admin/groups?${query}` : "/admin/groups";
}

function buildAdminGroupsPager({
  totalItems = 0,
  page = 1,
  pageSize = ADMIN_COMMUNITY_GROUPS_PAGE_SIZE,
  q = "",
  groupsPage = 1,
  communityPage = 1,
  target = "community",
} = {}) {
  const safeTotal = Math.max(0, Number(totalItems || 0));
  const safePageSize = Math.max(1, Number(pageSize || 1));
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const currentPage = Math.min(normalizePageNumber(page), totalPages);
  const start = safeTotal ? (currentPage - 1) * safePageSize + 1 : 0;
  const end = safeTotal ? Math.min(safeTotal, currentPage * safePageSize) : 0;
  const nextGroupsPage =
    target === "groups" ? currentPage + 1 : normalizePageNumber(groupsPage);
  const prevGroupsPage =
    target === "groups" ? currentPage - 1 : normalizePageNumber(groupsPage);
  const nextCommunityPage =
    target === "community"
      ? currentPage + 1
      : normalizePageNumber(communityPage);
  const prevCommunityPage =
    target === "community"
      ? currentPage - 1
      : normalizePageNumber(communityPage);

  return {
    currentPage,
    totalPages,
    totalItems: safeTotal,
    pageSize: safePageSize,
    hasPrevPage: currentPage > 1,
    hasNextPage: currentPage < totalPages,
    summary: safeTotal ? `Showing ${start}-${end} of ${safeTotal}.` : "",
    prevHref: buildAdminGroupsPageHref({
      q,
      groupsPage: Math.max(1, prevGroupsPage),
      communityPage: Math.max(1, prevCommunityPage),
    }),
    nextHref: buildAdminGroupsPageHref({
      q,
      groupsPage: Math.max(1, nextGroupsPage),
      communityPage: Math.max(1, nextCommunityPage),
    }),
  };
}

function buildAdminGroupsPageData({ q = "", groupsPage = 1, communityPage = 1 } = {}) {
  const groupsByKey = loadGroupsCatalog();
  const query = String(q || "").trim();
  const queryLower = query.toLowerCase();
  const safeGroupsPage = normalizePageNumber(groupsPage);
  const safeCommunityPage = normalizePageNumber(communityPage);

  function listGroupMessagesForAdmin(groupKey) {
    const key = String(groupKey || "").trim();
    if (!key) return [];
    return db
      .prepare(
        `
          SELECT
            gb.id,
            gb.author_user_id,
            gb.body,
            gb.created_at,
            u.username,
            u.global_name,
            u.avatar
          FROM group_message_board gb
          LEFT JOIN users u ON u.discord_id = gb.author_user_id
          WHERE gb.group_key=?
          ORDER BY gb.created_at DESC, gb.id DESC
          LIMIT 25
        `,
      )
      .all(key);
  }

  function listGroupCommandsForAdmin(groupKey) {
    const key = String(groupKey || "").trim();
    if (!key) return [];
    const marker = `"groupKey":${JSON.stringify(key)}`;
    return db
      .prepare(
        `
          SELECT
            e.id,
            e.created_at,
            e.type,
            e.actor_user_id,
            e.payload,
            u.username,
            u.global_name,
            u.avatar
          FROM events e
          LEFT JOIN users u ON u.discord_id = e.actor_user_id
          WHERE e.type LIKE 'group_command_%'
            AND instr(IFNULL(e.payload, ''), ?) > 0
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 25
        `,
      )
      .all(marker)
      .map((row) => {
        const payload = tryJson(row.payload, {}) || {};
        const commandType = String(row.type || "")
          .replace(/^group_command_/, "")
          .replace(/_/g, " ")
          .trim();
        const summaryParts = [];
        if (payload.message) summaryParts.push(String(payload.message));
        if (payload.url) summaryParts.push(String(payload.url));
        if (payload.name) summaryParts.push(String(payload.name));
        if (payload.kind) summaryParts.push(`kind: ${payload.kind}`);
        if (payload.messageCount) summaryParts.push(`${payload.messageCount} messages`);
        if (payload.times) summaryParts.push(`${payload.times} times`);

        return {
          id: row.id,
          created_at: Number(row.created_at || 0),
          type: row.type,
          commandLabel: commandType || String(row.type || "group command"),
          actor_user_id: row.actor_user_id || "",
          username: row.username || "",
          global_name: row.global_name || "",
          avatar: row.avatar || "",
          summary: summaryParts.join(" · "),
        };
      });
  }

  function listMembersForGroups(groupKeys) {
    const keys = Array.isArray(groupKeys)
      ? groupKeys.map((key) => String(key || "").trim()).filter(Boolean)
      : [];
    const membersByKey = new Map(keys.map((key) => [key, []]));
    if (!keys.length) return membersByKey;

    const placeholders = keys.map(() => "?").join(",");
    const rows = db
      .prepare(
        `
          SELECT
            gm.group_key,
            gm.joined_at,
            u.discord_id,
            u.username,
            u.global_name,
            u.avatar
          FROM group_memberships gm
          LEFT JOIN users u ON u.discord_id = gm.user_id
          WHERE gm.group_key IN (${placeholders})
          ORDER BY
            gm.group_key COLLATE NOCASE ASC,
            COALESCE(u.global_name, u.username, u.discord_id, gm.user_id) COLLATE NOCASE ASC
        `,
      )
      .all(...keys);

    for (const row of rows) {
      const key = String(row.group_key || "").trim();
      if (!membersByKey.has(key)) continue;
      membersByKey.get(key).push({
        discord_id: row.discord_id || "",
        username: row.username || "",
        global_name: row.global_name || "",
        avatar: row.avatar || "",
        joined_at: Number(row.joined_at || 0),
      });
    }

    return membersByKey;
  }

  let builtInSource = Array.from(groupsByKey.values()).sort((a, b) =>
    String(a.label || a.key).localeCompare(String(b.label || b.key)),
  );
  if (queryLower) {
    const matchingBuiltInMemberRows = db
      .prepare(
        `
          SELECT DISTINCT gm.group_key
          FROM group_memberships gm
          LEFT JOIN users u ON u.discord_id = gm.user_id
          WHERE
            gm.group_key LIKE @q OR
            gm.user_id LIKE @q OR
            u.discord_id LIKE @q OR
            u.username LIKE @q OR
            u.global_name LIKE @q
        `,
      )
      .all({ q: `%${query}%` });
    const matchingBuiltInMemberKeys = new Set(
      matchingBuiltInMemberRows
        .map((row) => String(row.group_key || "").trim())
        .filter(Boolean),
    );

    builtInSource = builtInSource.filter((group) => {
      const haystack = [
        group.key,
        group.label,
      ].map((value) => String(value || "").toLowerCase()).join(" ");
      return haystack.includes(queryLower) || matchingBuiltInMemberKeys.has(group.key);
    });
  }

  const builtInTotal = builtInSource.length;
  const builtInTotalPages = Math.max(
    1,
    Math.ceil(builtInTotal / ADMIN_BUILT_IN_GROUPS_PAGE_SIZE),
  );
  const effectiveGroupsPage = Math.min(safeGroupsPage, builtInTotalPages);
  const builtInOffset =
    (effectiveGroupsPage - 1) * ADMIN_BUILT_IN_GROUPS_PAGE_SIZE;
  const builtInPageGroups = builtInSource.slice(
    builtInOffset,
    builtInOffset + ADMIN_BUILT_IN_GROUPS_PAGE_SIZE,
  );
  const builtInMemberMap = listMembersForGroups(
    builtInPageGroups.map((group) => group.key),
  );
  const builtInGroups = builtInPageGroups.map((group) => ({
    key: group.key,
    label: group.label,
    icon: group.icon || "/groups/default.png",
    members: builtInMemberMap.get(group.key) || [],
    messages: listGroupMessagesForAdmin(group.key),
    commands: listGroupCommandsForAdmin(group.key),
  }));

  const communityWhere = [];
  const communityArgs = {
    limit: ADMIN_COMMUNITY_GROUPS_PAGE_SIZE,
  };
  if (query) {
    communityWhere.push(`
      (
        cg.group_key LIKE @q OR
        cg.name LIKE @q OR
        cg.description LIKE @q OR
        cg.owner_user_id LIKE @q OR
        u.username LIKE @q OR
        u.global_name LIKE @q OR
        EXISTS (
          SELECT 1
          FROM group_memberships gm
          LEFT JOIN users member ON member.discord_id = gm.user_id
          WHERE gm.group_key = cg.group_key
            AND (
              gm.user_id LIKE @q OR
              member.discord_id LIKE @q OR
              member.username LIKE @q OR
              member.global_name LIKE @q
            )
        )
      )
    `);
    communityArgs.q = `%${query}%`;
  }
  const communityWhereSql = communityWhere.length
    ? `WHERE ${communityWhere.join(" AND ")}`
    : "";

  const communityTotal = Number(
    db
      .prepare(
        `
          SELECT COUNT(*) AS n
          FROM community_groups cg
          LEFT JOIN users u ON u.discord_id = cg.owner_user_id
          ${communityWhereSql}
        `,
      )
      .get(communityArgs)?.n || 0,
  );
  const communityTotalPages = Math.max(
    1,
    Math.ceil(communityTotal / ADMIN_COMMUNITY_GROUPS_PAGE_SIZE),
  );
  const effectiveCommunityPage = Math.min(
    safeCommunityPage,
    communityTotalPages,
  );
  communityArgs.offset =
    (effectiveCommunityPage - 1) * ADMIN_COMMUNITY_GROUPS_PAGE_SIZE;

  const statsRow = db
    .prepare(
      `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN IFNULL(is_public, 0) = 1 THEN 1 ELSE 0 END) AS public_count,
          SUM(CASE WHEN IFNULL(is_public, 0) = 0 THEN 1 ELSE 0 END) AS private_count
        FROM community_groups
      `,
    )
    .get();

  const communityRows = db
    .prepare(
      `
        SELECT
          cg.group_key,
          cg.owner_user_id,
          cg.name,
          cg.description,
          IFNULL(cg.is_public, 0) AS is_public,
          cg.custom_avatar_path,
          cg.custom_banner_path,
          cg.custom_avatar_updated_at,
          cg.custom_banner_updated_at,
          cg.created_at,
          cg.updated_at,
          u.username AS owner_username,
          u.global_name AS owner_global_name,
          u.avatar AS owner_avatar
        FROM community_groups cg
        LEFT JOIN users u ON u.discord_id = cg.owner_user_id
        ${communityWhereSql}
        ORDER BY cg.updated_at DESC, cg.created_at DESC
        LIMIT @limit OFFSET @offset
      `,
    )
    .all(communityArgs);

  const communityKeys = communityRows
    .map((group) => String(group.group_key || "").trim())
    .filter(Boolean);
  const communityMemberMap = listMembersForGroups(communityKeys);

  const communityGroups = communityRows.map((group) => {
    const key = String(group.group_key || "").trim();
    const members = communityMemberMap.get(key) || [];
    const messages = listGroupMessagesForAdmin(key);
    const commands = listGroupCommandsForAdmin(key);

    return {
      key,
      name: String(group.name || key).trim() || key,
      description: String(group.description || "").trim(),
      isPublic: !!Number(group.is_public || 0),
      avatarUrl: group.custom_avatar_path
        ? groupAvatarUrl(key, 128)
        : siteAvatarUrl({ discord_id: group.owner_user_id }, 128),
      bannerUrl: group.custom_banner_path ? groupBannerUrl(key, 1600) : "",
      hasCustomAvatar: !!group.custom_avatar_path,
      hasCustomBanner: !!group.custom_banner_path,
      owner: {
        discord_id: group.owner_user_id || "",
        username: group.owner_username || "",
        global_name: group.owner_global_name || "",
        avatar: group.owner_avatar || "",
      },
      members,
      messages,
      commands,
      created_at: Number(group.created_at || 0),
      updated_at: Number(group.updated_at || 0),
    };
  });

  const builtInPager = buildAdminGroupsPager({
    totalItems: builtInTotal,
    page: effectiveGroupsPage,
    pageSize: ADMIN_BUILT_IN_GROUPS_PAGE_SIZE,
    q: query,
    groupsPage: effectiveGroupsPage,
    communityPage: effectiveCommunityPage,
    target: "groups",
  });
  const communityPager = buildAdminGroupsPager({
    totalItems: communityTotal,
    page: effectiveCommunityPage,
    pageSize: ADMIN_COMMUNITY_GROUPS_PAGE_SIZE,
    q: query,
    groupsPage: effectiveGroupsPage,
    communityPage: effectiveCommunityPage,
    target: "community",
  });

  return {
    builtInGroups,
    builtInPager,
    communityGroups,
    communityPager,
    query,
    stats: {
      builtInTotal,
      communityTotal: Number(statsRow?.total || 0),
      publicCommunityTotal: Number(statsRow?.public_count || 0),
      privateCommunityTotal: Number(statsRow?.private_count || 0),
    },
  };
}

function getAdminGroupsRedirectUrl(req) {
  const fallback = "/admin/groups?ok=1";
  const ref = String(req.get?.("referer") || "").trim();
  if (!ref) return fallback;

  try {
    const url = new URL(ref, "http://admin.local");
    if (url.pathname !== "/admin/groups") return fallback;
    url.searchParams.set("ok", "1");
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

app.get("/admin/groups", requireDiscord, requireAdmin, (req, res) => {
  const data = buildAdminGroupsPageData({
    q: req.query?.q,
    groupsPage: req.query?.groupsPage,
    communityPage: req.query?.communityPage,
  });
  res.locals.groups = data.builtInGroups;
  res.locals.groupsPager = data.builtInPager;
  res.locals.communityGroups = data.communityGroups;
  res.locals.communityGroupsPager = data.communityPager;
  res.locals.adminGroupsQuery = data.query;
  res.locals.adminGroupsStats = data.stats;
  res.locals.adminGroupsFlash = String(req.query?.ok || "") === "1"
    ? "Group moderation action completed."
    : "";
  res.locals.adminGroupsFlashIsError = false;

  renderWithLayout(res, "pages/admin/groups/grp_main", {
    title: "PlayCtrl.me",
  });
});

app.post("/admin/groups/community/:key/visibility", requireDiscord, requireAdmin, (req, res) => {
  const key = String(req.params.key || "").trim();
  const nextPublic = String(req.body?.is_public || "").trim() === "1";
  db.prepare(
    `
      UPDATE community_groups
      SET is_public=?, updated_at=?
      WHERE group_key=?
    `,
  ).run(nextPublic ? 1 : 0, Date.now(), key);
  return res.redirect(getAdminGroupsRedirectUrl(req));
});

app.post("/admin/groups/community/:key/avatar/delete", requireDiscord, requireAdmin, (req, res) => {
  const key = String(req.params.key || "").trim();
  if (typeof clearCustomCommunityGroupAvatar === "function") {
    clearCustomCommunityGroupAvatar(key);
  } else {
    db.prepare(
      `
        UPDATE community_groups
        SET custom_avatar_path=NULL,
            custom_avatar_mime=NULL,
            custom_avatar_updated_at=NULL,
            updated_at=?
        WHERE group_key=?
      `,
    ).run(Date.now(), key);
  }
  return res.redirect(getAdminGroupsRedirectUrl(req));
});

app.post("/admin/groups/community/:key/banner/delete", requireDiscord, requireAdmin, (req, res) => {
  const key = String(req.params.key || "").trim();
  if (typeof clearCustomCommunityGroupBanner === "function") {
    clearCustomCommunityGroupBanner(key);
  } else {
    db.prepare(
      `
        UPDATE community_groups
        SET custom_banner_path=NULL,
            custom_banner_mime=NULL,
            custom_banner_updated_at=NULL,
            updated_at=?
        WHERE group_key=?
      `,
    ).run(Date.now(), key);
  }
  return res.redirect(getAdminGroupsRedirectUrl(req));
});

app.post("/admin/groups/community/:key/messages/:messageId/delete", requireDiscord, requireAdmin, (req, res) => {
  const key = String(req.params.key || "").trim();
  const messageId = Number(req.params.messageId);
  if (Number.isSafeInteger(messageId) && messageId > 0) {
    db.prepare(
      `DELETE FROM group_message_board WHERE group_key=? AND id=?`,
    ).run(key, messageId);
  }
  return res.redirect(getAdminGroupsRedirectUrl(req));
});

app.post("/admin/groups/:key/messages/:messageId/delete", requireDiscord, requireAdmin, (req, res) => {
  const key = String(req.params.key || "").trim();
  const messageId = Number(req.params.messageId);
  if (Number.isSafeInteger(messageId) && messageId > 0) {
    db.prepare(
      `DELETE FROM group_message_board WHERE group_key=? AND id=?`,
    ).run(key, messageId);
  }
  return res.redirect(getAdminGroupsRedirectUrl(req));
});

app.post("/admin/groups/community/:key/delete", requireDiscord, requireAdmin, (req, res) => {
  const key = String(req.params.key || "").trim();
  const tx = db.transaction(() => {
    if (typeof clearCustomCommunityGroupAvatar === "function") {
      clearCustomCommunityGroupAvatar(key);
    }
    if (typeof clearCustomCommunityGroupBanner === "function") {
      clearCustomCommunityGroupBanner(key);
    }
    db.prepare(`DELETE FROM group_message_board WHERE group_key=?`).run(key);
    db.prepare(`DELETE FROM group_memberships WHERE group_key=?`).run(key);
    db.prepare(`DELETE FROM community_group_invites WHERE group_key=?`).run(key);
    db.prepare(`DELETE FROM community_group_command_prefs WHERE group_key=?`).run(key);
    db.prepare(`DELETE FROM community_groups WHERE group_key=?`).run(key);
  });
  tx();
  return res.redirect(getAdminGroupsRedirectUrl(req));
});

app.get("/admin/admins", requireDiscord, requireAdmin, (req, res) => {
  res.locals.admins = db
    .prepare(
      `
    SELECT a.discord_id, a.is_bootstrap, u.username, u.global_name, a.added_by, a.created_at
    FROM admins a
    LEFT JOIN users u ON u.discord_id = a.discord_id
    ORDER BY a.is_bootstrap DESC, a.created_at DESC
  `,
    )
    .all();

  renderWithLayout(res, "pages/admin/manage/mng_main", {
    title: "PlayCtrl.me",
  });
});

app.get("/admin/uploads", requireDiscord, requireAdmin, (req, res) => {
  const uploads = listAllUploadedFilesForAdmin(req);
  const controlLinkAssetData = listControlLinkAssetsForAdmin();
  const totalBytes = uploads.reduce(
    (sum, item) => sum + Number(item.bytes || 0),
    0,
  );

  res.locals.uploads = uploads;
  res.locals.uploadStats = {
    count: uploads.length,
    totalBytes,
    totalBytesLabel: formatBytesCompact(totalBytes),
  };
  res.locals.controlLinkAssetCards = controlLinkAssetData.cards;
  res.locals.controlLinkAssetStats = controlLinkAssetData.stats;

  renderWithLayout(res, "pages/admin/uploads/upl_main", {
    title: "PlayCtrl.me",
  });
});

app.get("/admin/uploads/control-links", requireDiscord, requireAdmin, (req, res) => {
  const controlLinkAssetData = listControlLinkAssetsForAdmin();

  res.locals.uploadStats = {
    count: 0,
    totalBytes: 0,
    totalBytesLabel: "0B",
  };
  res.locals.controlLinkAssetCards = controlLinkAssetData.cards;
  res.locals.controlLinkAssetStats = controlLinkAssetData.stats;

  renderWithLayout(res, "pages/admin/uploads/upl_control_links", {
    title: "PlayCtrl.me",
  });
});

app.post("/admin/uploads/delete", requireDiscord, requireAdmin, (req, res) => {
  const uploadId = String(req.body?.id || "").trim();
  if (!uploadId) {
    return res.status(400).json({ ok: false, message: "Missing upload id." });
  }

  const row = db
    .prepare(
      `
      SELECT
        uf.id,
        uf.user_id,
        uf.file_path,
        uf.original_name,
        uf.stored_name,
        uf.bytes,
        uf.created_at,
        uf.protected_until,
        EXISTS (
          SELECT 1
          FROM queued_command_upload_refs qcur
          WHERE qcur.upload_id = uf.id
        ) AS is_queue_pinned
      FROM uploaded_files uf
      WHERE uf.id=?
    `,
    )
    .get(uploadId);

  if (!row) {
    return res.status(404).json({ ok: false, message: "Upload not found." });
  }

  const isProtected =
    !!Number(row.is_queue_pinned || 0) ||
    Number(row.protected_until || 0) > Date.now();
  if (isProtected) {
    return res.status(409).json({
      ok: false,
      message:
        "This upload is still protected by a queued command or recent delivery.",
    });
  }

  const deleted = deleteUploadedFiles([row], "admin delete");
  if (!deleted) {
    return res.status(500).json({
      ok: false,
      message: "Could not delete the upload right now.",
    });
  }

  logEvent({
    type: "admin_upload_deleted",
    actorUserId: req.user.discord_id,
    targetUserId: String(row.user_id || "").trim() || null,
    req,
    payload: {
      uploadId,
      originalName: String(row.original_name || "").trim(),
      storedName: String(row.stored_name || "").trim(),
      bytes: Number(row.bytes || 0),
      createdAt: Number(row.created_at || 0),
    },
  });

  return res.json({ ok: true, id: uploadId });
});

app.post(
  "/admin/uploads/control-link/delete",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const discordId = String(req.body?.discordId || "").trim();
    const assetKind = String(req.body?.assetKind || "").trim().toLowerCase();

    if (!discordId) {
      return res
        .status(400)
        .json({ ok: false, message: "Missing Discord user id." });
    }

    const configByKind = {
      avatar: {
        pathField: "custom_avatar_path",
        clear: clearCustomSiteAvatar,
      },
      banner: {
        pathField: "custom_banner_path",
        clear: clearCustomSiteBanner,
      },
      background: {
        pathField: "custom_background_path",
        clear: clearCustomSiteBackground,
      },
    };

    const config = configByKind[assetKind];
    if (!config) {
      return res
        .status(400)
        .json({ ok: false, message: "Unknown control link asset type." });
    }

    const row =
      db
        .prepare(
          `
          SELECT
            username,
            global_name,
            control_link_display_name,
            custom_avatar_path,
            custom_banner_path,
            custom_background_path
          FROM users
          WHERE discord_id=?
        `,
        )
        .get(discordId) || null;

    if (!row) {
      return res.status(404).json({ ok: false, message: "User not found." });
    }

    const storedPath = String(row[config.pathField] || "").trim();
    if (!storedPath) {
      return res
        .status(404)
        .json({ ok: false, message: "That control link asset was not found." });
    }

    const abs = resolveStoredSiteAvatarPath(storedPath);
    let bytes = 0;
    if (abs && fs.existsSync(abs)) {
      try {
        bytes = Number(fs.statSync(abs).size || 0);
      } catch {}
    }

    const cleared = config.clear(discordId);
    if (!cleared?.ok) {
      return res.status(Number(cleared?.status || 500)).json({
        ok: false,
        message:
          cleared?.message || "Could not delete that control link asset.",
      });
    }

    logEvent({
      type: "admin_control_link_asset_deleted",
      actorUserId: req.user.discord_id,
      targetUserId: discordId,
      req,
      payload: {
        assetKind,
        bytes,
        storedPath,
        displayName: getPreferredDisplayName({
          ...row,
          discord_id: discordId,
        }),
      },
    });

    return res.json({
      ok: true,
      discordId,
      assetKind,
      bytes,
    });
  },
);

app.post("/admin/admins/add", requireDiscord, requireAdmin, (req, res) => {
  const id = String(req.body?.discord_id || "").trim();
  if (!/^\d{10,20}$/.test(id)) return res.status(400).send("Bad discord id");

  db.prepare(
    `
    INSERT INTO admins (discord_id, added_by, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO NOTHING
  `,
  ).run(id, req.user.discord_id, Date.now());

  logEvent({
    type: "admin_added",
    actorUserId: req.user.discord_id,
    targetUserId: id,
    req,
    payload: {},
  });
  res.redirect("/admin/admins");
});

app.post("/admin/admins/remove", requireDiscord, requireAdmin, (req, res) => {
  const targetId = String(req.body?.discord_id || "").trim();
  if (!targetId) return res.status(400).send("bad_request");

  const row = db
    .prepare(`SELECT is_bootstrap FROM admins WHERE discord_id=?`)
    .get(targetId);
  if (!row) return res.status(404).send("not_found");

  if (row.is_bootstrap) {
    return res.status(403).send("Cannot remove bootstrap admin");
  }

  db.prepare(`DELETE FROM admins WHERE discord_id=?`).run(targetId);
  res.redirect("/admin/admins");
});

app.get("/admin/logs", requireDiscord, requireAdmin, (req, res) => {
  const PAGE_SIZE = 50;
  const groupHistoryTypes = Array.isArray(
    CONTROL_LINK_COMMAND_HISTORY_TYPE_KEYS,
  )
    ? CONTROL_LINK_COMMAND_HISTORY_TYPE_KEYS
    : [];
  const groupHistoryTypePlaceholders = groupHistoryTypes.map(
    (_, index) => `@groupHistoryType${index}`,
  );
  const groupRecipientHistoryFilter = groupHistoryTypes.length
    ? `NOT (
        e.type IN (${groupHistoryTypePlaceholders.join(",")})
        AND e.target_user_id IS NOT NULL
        AND instr(e.payload, @groupHistorySourceMarker) > 0
      )`
    : "1=1";
  const groupHistoryArgs = groupHistoryTypes.length
    ? { groupHistorySourceMarker: '"sourceKind":"group"' }
    : {};
  groupHistoryTypes.forEach((type, index) => {
    groupHistoryArgs[`groupHistoryType${index}`] = type;
  });

  const page = Math.max(1, parseIntSafe(req.query.page, 1));
  const q = String(req.query.q || "").trim();
  const typeSearch = String(req.query.typeSearch || "").trim();
  const typesParam = String(req.query.types || "").trim();
  const selectedTypes = typesParam
    ? typesParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  res.locals.q = q;
  res.locals.typeSearch = typeSearch;
  res.locals.selectedTypes = selectedTypes;

  const typeRows = db
    .prepare(
      `
    SELECT type, COUNT(*) as c
    FROM events e
    WHERE ${groupRecipientHistoryFilter}
    GROUP BY type
    ORDER BY c DESC
    LIMIT 80
  `,
    )
    .all(groupHistoryArgs);
  res.locals.allTypes = typeRows.map((r) => r.type);

  const where = [groupRecipientHistoryFilter];
  const args = { ...groupHistoryArgs };

  if (q) {
    const rawTokens = q.split(/\s+/).map((token) => token.trim()).filter(Boolean);
    const excludeUserIds = [];
    const includeTokens = [];

    for (const token of rawTokens) {
      const maybeExcludedUserId = token.startsWith("-") ? token.slice(1).trim() : "";
      if (/^\d{6,25}$/.test(maybeExcludedUserId)) {
        excludeUserIds.push(maybeExcludedUserId);
        continue;
      }
      includeTokens.push(token);
    }

    includeTokens.forEach((token, index) => {
      const key = `q${index}`;
      where.push(`
        (
          e.type LIKE @${key} OR
          e.actor_user_id LIKE @${key} OR
          e.target_user_id LIKE @${key} OR
          e.pair_code LIKE @${key} OR
          e.device_id LIKE @${key} OR
          e.payload LIKE @${key} OR
          au.username LIKE @${key} OR
          au.global_name LIKE @${key} OR
          tu.username LIKE @${key} OR
          tu.global_name LIKE @${key}
        )
      `);
      args[key] = `%${token}%`;
    });

    excludeUserIds.forEach((userId, index) => {
      const key = `excludeUser${index}`;
      where.push(`
        IFNULL(e.actor_user_id, '') <> @${key}
        AND IFNULL(e.target_user_id, '') <> @${key}
      `);
      args[key] = userId;
    });
  }

  if (typeSearch) {
    where.push(`e.type LIKE @typeSearch`);
    args.typeSearch = `%${typeSearch}%`;
  }

  if (selectedTypes.length) {
    const placeholders = selectedTypes.map((_, i) => `@t${i}`);
    where.push(`e.type IN (${placeholders.join(",")})`);
    selectedTypes.forEach((t, i) => (args[`t${i}`] = t));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = Number(
    db
      .prepare(
        `
    SELECT COUNT(*) as n
    FROM events e
    LEFT JOIN users au ON au.discord_id = e.actor_user_id
    LEFT JOIN users tu ON tu.discord_id = e.target_user_id
    ${whereSql}
  `,
      )
      .get(args)?.n || 0,
  );
  res.locals.total = total;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * PAGE_SIZE;
  res.locals.pages = pages;
  res.locals.safePage = safePage;

  const rows = db
    .prepare(
      `
    SELECT
      e.created_at, e.type, e.actor_user_id, e.target_user_id, e.pair_code, e.device_id, e.payload,

      au.discord_id as actor_id,
      au.username as actor_username,
      au.global_name as actor_global_name,
      au.avatar as actor_avatar,

      tu.discord_id as target_id,
      tu.username as target_username,
      tu.global_name as target_global_name,
      tu.avatar as target_avatar

    FROM events e
    LEFT JOIN users au ON au.discord_id = e.actor_user_id
    LEFT JOIN users tu ON tu.discord_id = e.target_user_id
    ${whereSql}
    ORDER BY e.created_at DESC
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `,
    )
    .all(args);
  res.locals.rows = rows;

  function userChip(prefix, id, username, globalName, avatar) {
    if (!id) return `<span class="uChip muted">(none)</span>`;
    const display = globalName || username || id;
    const avatarUrl = siteAvatarUrl({ discord_id: id }, 64);
    return `
      <span class="uChip" data-uid="${escapeHtml(id)}">
        <img class="uAv" src="${escapeHtml(avatarUrl)}" alt="" />
        <span class="uNm">${escapeHtml(display)}</span>
        <span class="uId">${escapeHtml(id)}</span>
      </span>
    `;
  }
  res.locals.userChip = userChip;

  function normalizeHttpUrl(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.toString();
    } catch {
      return "";
    }
  }

  function renderUrlAnchor(url, label) {
    const safeUrl = normalizeHttpUrl(url);
    if (!safeUrl) return "";
    let text = String(label || safeUrl).trim();
    try {
      const parsed = new URL(safeUrl);
      text =
        parsed.hostname +
        (parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "") +
        (parsed.search ? parsed.search : "");
    } catch {}

    if (text.length > 88) text = text.slice(0, 85) + "...";

    return `<a class="inlineLink" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(safeUrl)}">${escapeHtml(text)}</a>`;
  }

  function renderInlineTextSnippet(value, max = 140) {
    const text = String(value || "").trim();
    if (!text) return "";
    const compact = text.replace(/\s+/g, " ");
    const clipped =
      compact.length > max ? `${compact.slice(0, Math.max(0, max - 3))}...` : compact;
    return `"${escapeHtml(clipped)}"`;
  }

  res.locals.cards = rows.map((r) => {
    const createdAt = Number(r.created_at || 0);
    const payloadObj = tryJson(r.payload);
    const pretty = payloadObj
      ? JSON.stringify(payloadObj, null, 2)
      : String(r.payload || "");

    let summary = "";
    let summaryHtml = "";
    let previewUrl = "";
    let previewLabel = "";
    if (payloadObj && typeof payloadObj === "object") {
      const title = payloadObj.title ? `title="${payloadObj.title}"` : "";
      const msg = payloadObj.message
        ? `message="${String(payloadObj.message).slice(0, 80)}"`
        : "";
      const url = payloadObj.url ? `url="${payloadObj.url}"` : "";
      const cmdId = payloadObj.commandId ? `cmd=${payloadObj.commandId}` : "";
      summary = [cmdId, title, msg, url].filter(Boolean).join(" • ");
    }

    const payloadUrl = normalizeHttpUrl(payloadObj?.url);

    if (
      r.type === "command_url" ||
      r.type === "group_command_open_url" ||
      r.type === "command_spiral_overlay" ||
      r.type === "group_command_spiral_overlay"
    ) {
      const bits = [];
      if (payloadObj?.commandId) bits.push(`cmd=${escapeHtml(payloadObj.commandId)}`);
      if (payloadUrl) bits.push(`url=${renderUrlAnchor(payloadUrl, payloadUrl)}`);
      summaryHtml = bits.join(" • ");
    }

    if (
      r.type === "command_play_sound" ||
      r.type === "command_play_sound_loop" ||
      r.type === "group_command_play_sound"
    ) {
      const bits = [];
      if (payloadObj?.commandId) bits.push(`cmd=${escapeHtml(payloadObj.commandId)}`);
      if (payloadObj?.kind) bits.push(`kind=${escapeHtml(payloadObj.kind)}`);
      if (payloadObj?.name) bits.push(`name="${escapeHtml(payloadObj.name)}"`);
      if (payloadObj?.kind === "tone") {
        bits.push(`baseHz=${escapeHtml(payloadObj.baseHz)}`);
        bits.push(`beatHz=${escapeHtml(payloadObj.beatHz)}`);
      }
      if (payloadUrl) bits.push(`url=${renderUrlAnchor(payloadUrl, payloadUrl)}`);
      summaryHtml = bits.join(" • ");
    }

    if (
      r.type === "command_image" ||
      r.type === "command_fullscreen_popup" ||
      r.type === "group_command_image_popup" ||
      r.type === "group_command_fullscreen_popup" ||
      r.type === "command_set_wallpaper" ||
      r.type === "group_command_set_wallpaper"
    ) {
      previewUrl = payloadUrl;
      previewLabel =
        r.type === "command_set_wallpaper" || r.type === "group_command_set_wallpaper"
          ? "Wallpaper preview"
          : r.type === "command_fullscreen_popup" ||
              r.type === "group_command_fullscreen_popup"
            ? "Fullscreen preview"
          : "Image preview";

      const bits = [];
      if (payloadObj?.commandId) bits.push(`cmd=${escapeHtml(payloadObj.commandId)}`);
      if (payloadUrl) bits.push(`url=${renderUrlAnchor(payloadUrl, payloadUrl)}`);
      summaryHtml = bits.join(" • ");
    }

    if (r.type === "about_me_updated") {
      const aboutText = renderInlineTextSnippet(
        payloadObj?.text ?? payloadObj?.aboutMe ?? "",
      );
      summaryHtml = aboutText ? `about=${aboutText}` : "about cleared";
    }

    if (r.type === "control_link_profile_updated") {
      const bits = [];
      const theme = String(payloadObj?.theme || "").trim();
      const displayName = String(payloadObj?.displayName || "").trim();
      const aboutText = renderInlineTextSnippet(payloadObj?.aboutMe || "");
      if (theme) bits.push(`theme=${escapeHtml(theme)}`);
      if (displayName) bits.push(`name=${renderInlineTextSnippet(displayName, 80)}`);
      bits.push(aboutText ? `about=${aboutText}` : "about cleared");
      summaryHtml = bits.join(" • ");
    }

    if (!summaryHtml && summary) {
      summaryHtml = escapeHtml(summary);
    }

    return {
      type: r.type,
      pair_code: r.pair_code,
      device_id: r.device_id,

      actor_id: r.actor_id,
      actor_username: r.actor_username,
      actor_global_name: r.actor_global_name,
      actor_avatar: r.actor_avatar,

      target_id: r.target_id,
      target_username: r.target_username,
      target_global_name: r.target_global_name,
      target_avatar: r.target_avatar,

      createdAt,
      summary,
      summaryHtml,
      previewUrl,
      previewLabel,
      pretty,
    };
  });

  function qs(nextPage) {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (typeSearch) p.set("typeSearch", typeSearch);
    if (selectedTypes.length) p.set("types", selectedTypes.join(","));
    p.set("page", String(nextPage));
    return "?" + p.toString();
  }
  res.locals.qs = qs;

  res.locals.prevDisabled = safePage <= 1;
  res.locals.nextDisabled = safePage >= pages;

  const maxPageOptions = Math.min(pages, 400);
  res.locals.pageOptionsHtml = Array.from(
    { length: maxPageOptions },
    (_, i) => {
      const n = i + 1;
      const sel = n === safePage ? "selected" : "";
      return `<option value="${n}" ${sel}>${n}</option>`;
    },
  ).join("");

  renderWithLayout(res, "pages/admin/logs/logs_main", {
    title: "Admin Logs",
  });
});

app.get("/admin/bans", requireDiscord, requireAdmin, (req, res) => {
  res.locals.users = db
    .prepare(
      `
    SELECT
      u.discord_id, u.username, u.global_name, u.avatar,
      b.discord_id AS banned, b.reason, b.banned_by, b.created_at AS banned_at
    FROM users u
    LEFT JOIN bans b ON b.discord_id = u.discord_id
    ORDER BY (b.discord_id IS NOT NULL) DESC, u.created_at DESC
    LIMIT 2000
  `,
    )
    .all();

  renderWithLayout(res, "pages/admin/bans/bans_main", {
    title: "PlayCtrl.me",
  });
});

app.post("/admin/bans/ban", requireDiscord, requireAdmin, (req, res) => {
  const targetId = String(req.body?.discord_id || "").trim();
  const reason = String(req.body?.reason || "")
    .trim()
    .slice(0, 300);

  if (!/^\d{10,20}$/.test(targetId))
    return res.status(400).send("Bad discord id");

  db.prepare(
    `
    INSERT INTO bans (discord_id, reason, banned_by, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      reason=excluded.reason,
      banned_by=excluded.banned_by,
      created_at=excluded.created_at
  `,
  ).run(targetId, reason || null, req.user.discord_id, Date.now());

  logEvent({
    type: "user_banned",
    actorUserId: req.user.discord_id,
    targetUserId: targetId,
    req,
    payload: { reason: reason || null },
  });

  res.redirect("/admin/bans");
});

app.post("/admin/bans/unban", requireDiscord, requireAdmin, (req, res) => {
  const targetId = String(req.body?.discord_id || "").trim();
  if (!/^\d{10,20}$/.test(targetId))
    return res.status(400).send("Bad discord id");

  db.prepare(`DELETE FROM bans WHERE discord_id=?`).run(targetId);

  logEvent({
    type: "user_unbanned",
    actorUserId: req.user.discord_id,
    targetUserId: targetId,
    req,
    payload: {},
  });

  res.redirect("/admin/bans");
});

app.get("/admin/invites", requireDiscord, requireAdmin, (req, res) => {
  res.locals.rows = db
    .prepare(
      `
    SELECT created_at, created_by, used_at, used_by
    FROM invite_codes
    ORDER BY created_at DESC
    LIMIT 500
  `,
    )
    .all();

  res.locals.enrollmentOpen = isEnrollmentOpen();

  renderWithLayout(res, "pages/admin/invites/inv_main", {
    title: "Invites",
  });
});

app.post("/admin/invites/new", requireDiscord, requireAdmin, (req, res) => {
  let count = Number(req.body?.count || 1);
  if (!Number.isFinite(count)) count = 1;
  count = Math.max(1, Math.min(50, Math.floor(count)));

  const now = Date.now();
  const createdBy = req.user.discord_id;

  const insert = db.prepare(`
    INSERT INTO invite_codes (code_hash, created_at, created_by)
    VALUES (?, ?, ?)
  `);

  const codes = [];

  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      let code, hash;
      for (let tries = 0; tries < 10; tries++) {
        code = genInviteCode();
        hash = inviteHash(code);
        try {
          insert.run(hash, now, createdBy);
          codes.push(code);
          break;
        } catch (e) {
          if (!String(e?.message || "").includes("UNIQUE")) throw e;
        }
      }
    }
  });

  tx();

  logEvent({
    type: "invite_generated",
    actorUserId: createdBy,
    targetUserId: null,
    req,
    payload: { count: codes.length },
  });

  return renderGeneratedInviteCodesPage(res, codes);
});

app.post(
  "/admin/invites/enrollment-toggle",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const enabled = String(req.body?.enabled || "0") === "1";

    setSetting("enrollment_open", enabled ? "1" : "0");

    try {
      logEvent({
        type: "enrollment_toggle",
        actorUserId: req.user.discord_id,
        targetUserId: null,
        req,
        payload: { enrollment_open: enabled ? 1 : 0 },
      });
    } catch {}

    if ((req.headers["x-requested-with"] || "") === "XMLHttpRequest") {
      return res.json({ ok: true, enrollment_open: enabled });
    }

    return res.redirect("/admin/invites");
  },
);

app.get("/admin/url-blocklist", requireDiscord, requireAdmin, (req, res) => {
  res.locals.pending = db
    .prepare(
      `
    SELECT host, sample_url, first_seen_at, last_seen_at, seen_count
    FROM url_verification_queue
    WHERE decided IS NULL
    ORDER BY last_seen_at DESC
    LIMIT 500
  `,
    )
    .all();

  renderWithLayout(res, "pages/admin/blocklist/bl_main", {
    title: "URL Blocklist",
  });
});

app.get(
  "/admin/url-blocklist/list",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const which = String(req.query.which || "allow").toLowerCase();
    const qRaw = String(req.query.q || "");
    const q = qRaw.trim().toLowerCase();
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const limit = Math.min(
      500,
      Math.max(10, Number(req.query.limit || 200) || 200),
    );

    const set = which === "block" ? getBlockSet() : getAllowSet();

    let items = Array.from(set);
    if (q) items = items.filter((h) => String(h).toLowerCase().includes(q));
    items.sort();

    const total = items.length;
    const page = items.slice(offset, offset + limit);

    res.json({
      ok: true,
      which,
      total,
      offset,
      limit,
      items: page,
    });
  },
);

app.post(
  "/admin/url-blocklist/allow/add",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const host = String(req.body?.host || "").trim();
    appendHostToFile(ALLOWLIST_PATH, host);
    return res.json({ ok: true });
  },
);

app.post(
  "/admin/url-blocklist/allow/remove",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const host = String(req.body?.host || "").trim();
    removeHostFromFile(ALLOWLIST_PATH, host);
    return res.json({ ok: true });
  },
);

app.post(
  "/admin/url-blocklist/block/add",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const host = String(req.body?.host || "").trim();
    appendHostToFile(BLOCKLIST_PATH, host);
    return res.json({ ok: true });
  },
);

app.post(
  "/admin/url-blocklist/block/remove",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const host = String(req.body?.host || "").trim();
    removeHostFromFile(BLOCKLIST_PATH, host);
    return res.json({ ok: true });
  },
);

app.post(
  "/admin/url-blocklist/queue/decide",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const host = String(req.body?.host || "")
      .trim()
      .toLowerCase();
    const decision = String(req.body?.decision || "").trim();
    if (!host || (decision !== "allow" && decision !== "block")) {
      return res.status(400).json({ ok: false, message: "Bad request." });
    }

    if (decision === "allow") appendHostToFile(ALLOWLIST_PATH, host);
    if (decision === "block") appendHostToFile(BLOCKLIST_PATH, host);

    db.prepare(
      `
    UPDATE url_verification_queue
    SET decided=?, decided_by=?, decided_at=?
    WHERE host=?
  `,
    ).run(decision, req.user.discord_id, Date.now(), host);

    logEvent({
      type: "url_queue_decided",
      actorUserId: req.user.discord_id,
      targetUserId: null,
      req,
      payload: { host, decision },
    });

    return res.json({ ok: true });
  },
);

app.get("/admin/users", requireDiscord, requireAdmin, (req, res) => {
  const PAGE_SIZE = 50;

  const page = Math.max(1, parseIntSafe(req.query.page, 1));
  const q = String(req.query.q || "").trim();
  const sortKey = String(req.query.sort || "commands").trim();
  const dir =
    String(req.query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  res.locals.q = q;
  res.locals.dir = dir;

  const where = [];
  const args = {};

  if (q) {
    where.push(`
      (
        u.discord_id LIKE @q OR
        u.username LIKE @q OR
        u.global_name LIKE @q OR
        pc.code_plain LIKE @q
      )
    `);
    args.q = `%${q}%`;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const SORT_MAP = {
    display: "COALESCE(u.global_name, u.username, '')",
    username: "COALESCE(u.username, '')",
    discord: "u.discord_id",
    paircode: "COALESCE(pc.code_plain, '')",
    commands: "COALESCE(u.commands_sent_total, 0)",
    queue: "COALESCE(qq.queue_count, 0)",
    api_limit: "COALESCE(u.api_rate_limit, 0)",
  };
  const isStrikeSort = sortKey === "strikes";
  const orderBy = SORT_MAP[sortKey] || SORT_MAP.commands;
  const baseFromSql = `
    FROM users u
    LEFT JOIN pair_codes pc
      ON pc.rowid = (
        SELECT MAX(rowid) FROM pair_codes WHERE user_id = u.discord_id
      )
    LEFT JOIN (
      SELECT owner_user_id, COUNT(*) AS queue_count
      FROM queued_commands
      GROUP BY owner_user_id
    ) qq
      ON qq.owner_user_id = u.discord_id
    LEFT JOIN bans b
      ON b.discord_id = u.discord_id
    ${whereSql}
  `;

  const total = Number(
    db
      .prepare(
        `
    SELECT COUNT(*) AS n
    ${baseFromSql}
  `,
      )
      .get(args)?.n || 0,
  );
  res.locals.total = total;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * PAGE_SIZE;
  res.locals.pages = pages;
  res.locals.safePage = safePage;

  const selectUsersSql = `
    SELECT
      u.discord_id,
      u.username,
      u.global_name,
      u.avatar,
      COALESCE(u.commands_sent_total, 0) AS commands_sent_total,
      COALESCE(u.has_supporter_badge, 0) AS has_supporter_badge,
      COALESCE(u.api_rate_limit, 0) AS api_rate_limit,
      COALESCE(qq.queue_count, 0) AS queue_count,
      pc.code_plain AS pair_code,
      CASE WHEN b.discord_id IS NOT NULL THEN 1 ELSE 0 END AS is_banned
    ${baseFromSql}
  `;
  let rows = [];

  if (isStrikeSort) {
    rows = db
      .prepare(
        `
          ${selectUsersSql}
          ORDER BY u.discord_id ASC
        `,
      )
      .all(args);

    const strikeStatesByUserId = getUserStrikeStatesByUserIds(
      rows.map((row) => row.discord_id),
    );

    for (const row of rows) {
      row.strike_count = Math.max(
        0,
        Number(
          strikeStatesByUserId.get(String(row.discord_id || "").trim())
            ?.currentStrikeCount || 0,
        ),
      );
      row.queue_count = Math.max(0, Number(row.queue_count || 0));
      row.queue_admin_url = buildAdminQueueHref({
        groupBy: "receiver",
        q: row.discord_id,
      });
    }

    rows.sort((left, right) => {
      const diff = Number(left.strike_count || 0) - Number(right.strike_count || 0);
      if (diff !== 0) {
        return dir === "ASC" ? diff : -diff;
      }
      return String(left.discord_id || "").localeCompare(
        String(right.discord_id || ""),
      );
    });

    rows = rows.slice(offset, offset + PAGE_SIZE);
  } else {
    rows = db
      .prepare(
        `
          ${selectUsersSql}
          ORDER BY ${orderBy} ${dir}, u.discord_id ASC
          LIMIT ${PAGE_SIZE} OFFSET ${offset}
        `,
      )
      .all(args);

    const strikeStatesByUserId = getUserStrikeStatesByUserIds(
      rows.map((row) => row.discord_id),
    );

    for (const row of rows) {
      row.strike_count = Math.max(
        0,
        Number(
          strikeStatesByUserId.get(String(row.discord_id || "").trim())
            ?.currentStrikeCount || 0,
        ),
      );
      row.queue_count = Math.max(0, Number(row.queue_count || 0));
      row.queue_admin_url = buildAdminQueueHref({
        groupBy: "receiver",
        q: row.discord_id,
      });
    }
  }

  res.locals.rows = rows;

  function qs(nextPage) {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (sortKey) p.set("sort", sortKey);
    if (dir) p.set("dir", dir.toLowerCase());
    p.set("page", String(nextPage));
    return "?" + p.toString();
  }
  res.locals.qs = qs;

  res.locals.prevDisabled = safePage <= 1;
  res.locals.nextDisabled = safePage >= pages;

  res.locals.pageOptions = Array.from({ length: pages }, (_, i) => {
    const n = i + 1;
    return `<option value="${n}" ${n === safePage ? "selected" : ""}>${n}</option>`;
  }).join("");

  res.locals.sortOptions = [
    ["commands", "Commands sent"],
    ["queue", "Queued commands"],
    ["strikes", "Strikes"],
    ["api_limit", "API limit"],
    ["display", "Display name"],
    ["username", "Username"],
    ["discord", "Discord ID"],
    ["paircode", "Pair code"],
  ]
    .map(([k, label]) => {
      const sel = k === sortKey ? "selected" : "";
      return `<option value="${escapeHtml(k)}" ${sel}>${escapeHtml(label)}</option>`;
    })
    .join("");

  renderWithLayout(res, "pages/admin/users/usr_main", {
    title: "Users",
  });
});

app.post(
  "/admin/users/:discordId/queue/clear",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const targetId = String(req.params.discordId || "").trim();
    if (!/^\d{10,20}$/.test(targetId)) {
      return res.status(400).json({ ok: false, message: "Bad discord id" });
    }

    const result = clearQueuedCommandsForOwnerForAdmin(targetId);

    logEvent({
      type: "admin_queued_commands_cleared_for_user",
      actorUserId: req.user.discord_id,
      targetUserId: targetId,
      req,
      payload: {
        cleared_count: Number(result.clearedCount || 0),
      },
    });

    return res.json({
      ok: true,
      ownerUserId: targetId,
      clearedCount: Number(result.clearedCount || 0),
    });
  },
);

app.post(
  "/admin/users/:discordId/queue/sent/clear",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const targetId = String(req.params.discordId || "").trim();
    if (!/^\d{10,20}$/.test(targetId)) {
      return res.status(400).json({ ok: false, message: "Bad discord id" });
    }

    const result = clearQueuedCommandsForActorForAdmin(targetId);

    logEvent({
      type: "admin_queued_commands_cleared_from_sender",
      actorUserId: req.user.discord_id,
      targetUserId: targetId,
      req,
      payload: {
        cleared_count: Number(result.clearedCount || 0),
      },
    });

    return res.json({
      ok: true,
      actorUserId: targetId,
      clearedCount: Number(result.clearedCount || 0),
    });
  },
);

app.post(
  "/admin/users/set-commands",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    try {
      const targetId = String(req.body?.discord_id || "").trim();
      const nRaw = req.body?.commands_sent_total;
      const n = Number.parseInt(String(nRaw), 10);
      const strikeCount = normalizeStrikeCount(req.body?.strike_count);
      const supporterRaw = String(req.body?.has_supporter_badge || "").trim();
      const hasSupporterBadge =
        supporterRaw === "1" || supporterRaw.toLowerCase() === "true" ? 1 : 0;

      if (!/^\d{10,20}$/.test(targetId)) {
        return res.status(400).json({ ok: false, message: "Bad discord id" });
      }
      if (!Number.isFinite(n) || n < 0) {
        return res
          .status(400)
          .json({ ok: false, message: "Bad commands_sent_total" });
      }
      if (strikeCount === null) {
        return res.status(400).json({
          ok: false,
          message: `Strike count must be between 0 and ${MAX_USER_STRIKES}.`,
        });
      }

      const userExists = db
        .prepare(`SELECT discord_id FROM users WHERE discord_id=? LIMIT 1`)
        .get(targetId);
      if (!userExists) {
        return res.status(404).json({ ok: false, message: "User not found" });
      }

      db.prepare(
        `
      UPDATE users
      SET commands_sent_total = ?,
          has_supporter_badge = ?
      WHERE discord_id = ?
    `,
      ).run(n, hasSupporterBadge, targetId);

      const strikeResult = setUserStrikeCountByAdmin(
        targetId,
        strikeCount,
        req.user.discord_id,
        { req },
      );
      if (!strikeResult.ok) {
        return res.status(400).json({
          ok: false,
          message: strikeResult.message || "Could not update strikes.",
        });
      }

      logEvent({
        type: "admin_set_commands_sent",
        actorUserId: req.user.discord_id,
        targetUserId: targetId,
        req,
        payload: {
          commands_sent_total: n,
          has_supporter_badge: hasSupporterBadge,
          strike_count: strikeCount,
        },
      });

      return res.json({
        ok: true,
        has_supporter_badge: hasSupporterBadge,
        strike_count: strikeCount,
        auto_banned: !!strikeResult.didBan,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Server error" });
    }
  },
);

app.post(
  "/admin/users/:discordId/commands-sent",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const uid = String(req.params.discordId || "").trim();
    if (!uid)
      return res.status(400).json({ ok: false, message: "Missing user id" });

    const nRaw = req.body?.commands_sent_total;
    const n = Math.max(0, Math.floor(Number(nRaw)));
    if (!Number.isFinite(n))
      return res.status(400).json({ ok: false, message: "Bad number" });

    const info = db
      .prepare(
        `
    UPDATE users
    SET commands_sent_total = @n
    WHERE discord_id = @uid
  `,
      )
      .run({ n, uid });

    if (!info.changes)
      return res.status(404).json({ ok: false, message: "User not found" });
    return res.json({ ok: true });
  },
);

}

module.exports = {
  registerAdminRoutes,
};
