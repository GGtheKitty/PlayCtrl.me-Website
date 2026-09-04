const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

function createUploadService(deps) {
  const {
    UPLOAD_ANIMATED_MAX_BYTES,
    UPLOAD_CONTEXT_UI,
    UPLOAD_FILE_RULES,
    UPLOAD_JANITOR_LIMIT,
    UPLOAD_RECENT_LIST_LIMIT,
    UPLOADS_DIR,
    UPLOADS_MAX_BYTES,
    UPLOADS_PER_USER_MAX_BYTES,
    UPLOADS_PER_USER_MAX_FILES,
    REPORT_MEDIA_BACKUPS_DIR,
    SITE_AVATARS_DIR,
    WALLPAPER_MEDIA_OGG_VIDEO_UPLOAD_RULE,
    crypto,
    db,
    enforceUrlPolicy,
    formatBytesCompact,
    getPreferredDisplayName,
    getUrlFileExtension,
    isHttpUrl,
    logEvent,
    normalizeHost,
    resolveStoredSiteAvatarPath,
    safeUnlink,
    siteAvatarMimeFromPath,
    siteAvatarUrl,
    siteBackgroundUrl,
    siteBannerUrl,
  } = deps;

  const deleteUploadedFileRow = db.prepare(`DELETE FROM uploaded_files WHERE id=?`);
  const markUploadedFileDeleteAfterQueue = db.prepare(`
    UPDATE uploaded_files
    SET delete_after_queue=1
    WHERE id=?
  `);
  const deleteReportMediaBackupRow = db.prepare(
    `DELETE FROM report_media_backups WHERE id=?`,
  );

  function getRequestOrigin(req) {
    return `${req.protocol}://${req.get("host")}`;
  }

function getUploadContextUiConfig() {
  return UPLOAD_CONTEXT_UI;
}

function getRecentUploadsByContextForUser(req, userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    return {
      image_popup: [],
      set_wallpaper: [],
      set_wallpaper_media: [],
      play_sound: [],
    };
  }

  return {
    image_popup: listRecentUploadedFilesForUser(
      req,
      uid,
      "image_popup",
      UPLOAD_RECENT_LIST_LIMIT,
    ),
    set_wallpaper: listRecentUploadedFilesForUser(
      req,
      uid,
      "set_wallpaper",
      UPLOAD_RECENT_LIST_LIMIT,
    ),
    set_wallpaper_media: listRecentUploadedFilesForUser(
      req,
      uid,
      "set_wallpaper_media",
      UPLOAD_RECENT_LIST_LIMIT,
    ),
    play_sound: listRecentUploadedFilesForUser(
      req,
      uid,
      "play_sound",
      UPLOAD_RECENT_LIST_LIMIT,
    ),
  };
}

function getUploadRuleForFile({ context, filename, mime }) {
  const ctx = String(context || "").trim();
  const originalName = String(filename || "").trim();
  const normalizedMime = String(mime || "")
    .trim()
    .toLowerCase();
  const ext = path.extname(originalName).slice(1).toLowerCase();

  if (!UPLOAD_CONTEXT_UI[ctx]) {
    return { ok: false, message: "Invalid upload context." };
  }

  if (!ext) {
    return { ok: false, message: "File must include a valid extension." };
  }

  if (
    ctx === "set_wallpaper_media" &&
    ext === "ogg" &&
    normalizedMime.startsWith("audio/")
  ) {
    return { ok: false, message: "Only video .ogg files are allowed here." };
  }

  const rule =
    ctx === "set_wallpaper_media" && ext === "ogg"
      ? WALLPAPER_MEDIA_OGG_VIDEO_UPLOAD_RULE
      : UPLOAD_FILE_RULES[ext];
  if (!rule || !rule.contexts.has(ctx)) {
    return { ok: false, message: "That file type is not allowed here." };
  }

  const isGenericMime =
    !normalizedMime ||
    normalizedMime === "application/octet-stream" ||
    normalizedMime === "binary/octet-stream";
  let resolvedMime = normalizedMime || rule.mimeTypes[0];

  if (!isGenericMime) {
    const directMimeMatch = rule.mimeTypes.some(
      (allowed) =>
        normalizedMime === allowed || normalizedMime.startsWith(allowed + ";"),
    );

    const broadMimeMatch =
      (rule.mediaGroup === "audio" && normalizedMime.startsWith("audio/")) ||
      (rule.previewKind === "image" && normalizedMime.startsWith("image/")) ||
      (rule.previewKind === "video" && normalizedMime.startsWith("video/"));

    if (!directMimeMatch && !broadMimeMatch) {
      console.warn("[uploads] accepting file by extension despite mime mismatch", {
        context: ctx,
        filename: originalName,
        ext,
        mime: normalizedMime,
      });
      resolvedMime = rule.mimeTypes[0];
    }
  }

  return {
    ok: true,
    context: ctx,
    ext,
    rule,
    mime: resolvedMime,
  };
}

function getUploadListSqlForContext(context) {
  switch (String(context || "").trim()) {
    case "image_popup":
      return "media_group='visual'";
    case "set_wallpaper":
      return "wallpaper_compatible=1";
    case "set_wallpaper_media":
      return `(
        (ext IN ('png', 'jpg', 'jpeg', 'webp', 'gif') AND preview_kind='image')
        OR
        (ext IN ('webm', 'ogg', 'ogv') AND preview_kind='video')
      )`;
    case "play_sound":
      return "media_group='audio'";
    default:
      return null;
  }
}

function isManagedPathInDir(filePath, baseDir) {
  const abs = path.resolve(String(filePath || ""));
  const base = path.resolve(baseDir) + path.sep;
  return abs.startsWith(base);
}

function isUploadedFileProtectedRow(row, now = Date.now()) {
  return (
    (!!Number(row?.is_queue_pinned || 0) &&
      !Number(row?.delete_after_queue || 0)) ||
    Number(row?.protected_until || 0) > Number(now || 0)
  );
}

function markUploadDeleteAfterQueueByIds(uploadIds) {
  const ids = Array.from(
    new Set(
      (Array.isArray(uploadIds) ? uploadIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

  for (const uploadId of ids) {
    markUploadedFileDeleteAfterQueue.run(uploadId);
  }

  return ids.length;
}

function deleteUploadedFiles(rows, reason = "cleanup") {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return 0;

  const tx = db.transaction((list) => {
    for (const row of list) {
      const abs = path.resolve(String(row.file_path || ""));
      if (!isManagedPathInDir(abs, UPLOADS_DIR)) {
        console.warn(
          "[uploads] refusing to unlink outside uploads dir:",
          abs,
        );
      } else {
        safeUnlink(abs, "uploads");
      }

      deleteUploadedFileRow.run(String(row.id));
    }
  });

  try {
    tx(items);
    console.log("[uploads] deleted", items.length, "files for", reason);
    return items.length;
  } catch (e) {
    console.warn("[uploads] delete tx failed:", e?.message || e);
    return 0;
  }
}

function purgeExpiredUploadedFiles(limit = UPLOAD_JANITOR_LIMIT) {
  let rows = [];
  try {
    rows = db
      .prepare(
        `
      SELECT id, file_path, created_at, bytes
      FROM uploaded_files uf
      WHERE expires_at <= ?
        AND IFNULL(protected_until, 0) <= ?
        AND (
          IFNULL(delete_after_queue, 0)=1
          OR NOT EXISTS (
            SELECT 1
            FROM queued_command_upload_refs qr
            WHERE qr.upload_id = uf.id
          )
        )
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `,
      )
      .all(Date.now(), Date.now(), limit);
  } catch (e) {
    console.warn("[uploads] janitor query failed:", e?.message || e);
    return 0;
  }

  if (!rows.length) return 0;
  return deleteUploadedFiles(rows, "expired");
}

function drainExpiredUploadedFiles(maxPasses = 25) {
  let total = 0;

  for (let i = 0; i < maxPasses; i++) {
    const deleted = purgeExpiredUploadedFiles(UPLOAD_JANITOR_LIMIT);
    total += deleted;
    if (deleted < UPLOAD_JANITOR_LIMIT) break;
  }

  return total;
}

function ensureUploadCapacityForNewFile({ userId, incomingBytes }) {
  const uid = String(userId || "").trim();
  const size = Number(incomingBytes || 0);

  if (!uid) return { ok: false, status: 400, message: "Missing upload user." };
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, status: 400, message: "Invalid upload size." };
  }

  if (size > UPLOADS_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `File is larger than the total upload storage limit (${formatBytesCompact(UPLOADS_MAX_BYTES)}).`,
    };
  }

  if (size > UPLOADS_PER_USER_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `File is larger than your personal upload storage limit (${formatBytesCompact(UPLOADS_PER_USER_MAX_BYTES)}).`,
    };
  }

  drainExpiredUploadedFiles();

  const now = Date.now();
  const userRows = db
    .prepare(
      `
      SELECT
        uf.id,
        uf.file_path,
        uf.created_at,
        uf.bytes,
        uf.expires_at,
        uf.protected_until,
        IFNULL(uf.delete_after_queue, 0) AS delete_after_queue,
        EXISTS (
          SELECT 1
          FROM queued_command_upload_refs qr
          WHERE qr.upload_id = uf.id
        ) AS is_queue_pinned
      FROM uploaded_files uf
      WHERE uf.user_id=?
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(uid);

  const missingUserRows = userRows.filter((row) => {
    const abs = path.resolve(String(row.file_path || ""));
    return !isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs);
  });
  if (missingUserRows.length) {
    deleteUploadedFiles(missingUserRows, "missing");
  }

  const activeUserRows = missingUserRows.length
    ? userRows.filter((row) => !missingUserRows.includes(row))
    : userRows;
  const deletableUserRows = activeUserRows.filter(
    (row) => !isUploadedFileProtectedRow(row, now),
  );
  const queuePinnedUserRows = activeUserRows.filter(
    (row) => !!Number(row.is_queue_pinned || 0),
  );

  let userBytes = 0;
  for (const row of activeUserRows) {
    if (Number(row.is_queue_pinned || 0)) continue;
    userBytes += Number(row.bytes || 0);
  }

  let userCount = activeUserRows.filter(
    (row) => !Number(row.is_queue_pinned || 0),
  ).length;
  const userDeletes = [];

  for (const row of deletableUserRows) {
    const overFileLimit = userCount >= UPLOADS_PER_USER_MAX_FILES;
    const overByteLimit = userBytes + size > UPLOADS_PER_USER_MAX_BYTES;
    if (!overFileLimit && !overByteLimit) break;

    userDeletes.push(row);
    userCount -= 1;
    userBytes -= Number(row.bytes || 0);
  }

  if (userDeletes.length) deleteUploadedFiles(userDeletes, "per-user limits");

  const rawUserBytes = activeUserRows.reduce(
    (sum, row) => sum + Number(row.bytes || 0),
    0,
  );
  const rawUserCount = activeUserRows.length;
  if (
    queuePinnedUserRows.length > 0 &&
    (rawUserBytes + size > UPLOADS_PER_USER_MAX_BYTES ||
      rawUserCount + 1 > UPLOADS_PER_USER_MAX_FILES)
  ) {
    markUploadDeleteAfterQueueByIds(queuePinnedUserRows.map((row) => row.id));
  }

  if (
    userCount >= UPLOADS_PER_USER_MAX_FILES ||
    userBytes + size > UPLOADS_PER_USER_MAX_BYTES
  ) {
    return {
      ok: false,
      status: 507,
      message: "Not enough personal upload storage is available right now.",
    };
  }

  const globalRows = db
    .prepare(
      `
      SELECT
        uf.id,
        uf.file_path,
        uf.created_at,
        uf.bytes,
        uf.expires_at,
        uf.protected_until,
        IFNULL(uf.delete_after_queue, 0) AS delete_after_queue,
        EXISTS (
          SELECT 1
          FROM queued_command_upload_refs qr
          WHERE qr.upload_id = uf.id
        ) AS is_queue_pinned
      FROM uploaded_files uf
      WHERE expires_at > ?
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(now);

  const missingGlobalRows = globalRows.filter((row) => {
    const abs = path.resolve(String(row.file_path || ""));
    return !isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs);
  });
  if (missingGlobalRows.length) {
    deleteUploadedFiles(missingGlobalRows, "missing");
  }

  const activeGlobalRows = missingGlobalRows.length
    ? globalRows.filter((row) => !missingGlobalRows.includes(row))
    : globalRows;

  let totalBytes = 0;
  for (const row of activeGlobalRows) totalBytes += Number(row.bytes || 0);

  const globalDeletes = [];

  const deletableGlobalRows = activeGlobalRows.filter(
    (row) => !isUploadedFileProtectedRow(row, now),
  );

  for (const row of deletableGlobalRows) {
    if (totalBytes + size <= UPLOADS_MAX_BYTES) break;
    globalDeletes.push(row);
    totalBytes -= Number(row.bytes || 0);
  }

  if (totalBytes + size > UPLOADS_MAX_BYTES) {
    return {
      ok: false,
      status: 507,
      message: "Not enough server upload storage is available right now.",
    };
  }

  if (globalDeletes.length) deleteUploadedFiles(globalDeletes, "global limit");

  return { ok: true };
}

function serializeUploadedFileRow(req, row) {
  const storedName = String(row.stored_name || "").trim();
  return {
    id: String(row.id),
    originalName: String(row.original_name || storedName || "").trim(),
    storedName,
    mime: String(row.mime || "").trim(),
    ext: String(row.ext || "").trim().toLowerCase(),
    bytes: Number(row.bytes || 0),
    previewKind: String(row.preview_kind || "").trim() || "image",
    mediaGroup: String(row.media_group || "").trim() || "visual",
    wallpaperCompatible: !!row.wallpaper_compatible,
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
    url: `${getRequestOrigin(req)}/uploads/${encodeURIComponent(storedName)}`,
  };
}

function listRecentUploadedFilesForUser(
  req,
  userId,
  context,
  limit = UPLOAD_RECENT_LIST_LIMIT,
) {
  const whereSql = getUploadListSqlForContext(context);
  if (!whereSql) return [];

  drainExpiredUploadedFiles();

  const rows = db
    .prepare(
      `
      SELECT
        id, original_name, stored_name, file_path, mime, ext, bytes,
        preview_kind, media_group, wallpaper_compatible, created_at, expires_at
      FROM uploaded_files
      WHERE user_id=? AND expires_at > ? AND IFNULL(delete_after_queue, 0)=0 AND ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    )
    .all(
      String(userId),
      Date.now(),
      Math.max(Number(limit || 0), 1) * 3,
    );

  const staleRows = [];
  const items = [];

  for (const row of rows) {
    const abs = path.resolve(String(row.file_path || ""));
    if (!isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs)) {
      staleRows.push(row);
      continue;
    }

    items.push(serializeUploadedFileRow(req, row));
    if (items.length >= limit) break;
  }

  if (staleRows.length) deleteUploadedFiles(staleRows, "missing");

  return items;
}

function listAllUploadedFilesForAdmin(req) {
  drainExpiredUploadedFiles();

  const rows = db
    .prepare(
      `
      SELECT
        uf.id,
        uf.user_id,
        uf.original_name,
        uf.stored_name,
        uf.file_path,
        uf.mime,
        uf.ext,
        uf.bytes,
        uf.preview_kind,
        uf.media_group,
        uf.wallpaper_compatible,
        uf.created_at,
        uf.expires_at,
        u.username,
        u.global_name,
        u.avatar
      FROM uploaded_files uf
      LEFT JOIN users u ON u.discord_id = uf.user_id
      WHERE uf.expires_at > ?
      ORDER BY uf.created_at DESC, uf.id DESC
    `,
    )
    .all(Date.now());

  const staleRows = [];
  const items = [];

  for (const row of rows) {
    const abs = path.resolve(String(row.file_path || ""));
    if (!isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs)) {
      staleRows.push(row);
      continue;
    }

    const item = serializeUploadedFileRow(req, row);
    const uploaderId = String(row.user_id || "").trim();
    const uploader = {
      discordId: uploaderId,
      username: String(row.username || "").trim(),
      globalName: String(row.global_name || "").trim(),
      avatarUrl: siteAvatarUrl({ discord_id: uploaderId }, 64),
    };

    items.push({
      ...item,
      sizeLabel: formatBytesCompact(item.bytes),
      uploader,
      uploaderDisplayName:
        uploader.globalName || uploader.username || uploader.discordId || "(unknown user)",
    });
  }

  if (staleRows.length) deleteUploadedFiles(staleRows, "missing");

  return items;
}

function getReportMediaBackupCommandKey(commandType) {
  const normalized = String(commandType || "").trim().toLowerCase();

  if (
    normalized === "command_image" ||
    normalized === "group_command_image_popup" ||
    normalized === "image_popup"
  ) {
    return "image_popup";
  }

  if (
    normalized === "command_set_wallpaper" ||
    normalized === "group_command_set_wallpaper" ||
    normalized === "set_wallpaper"
  ) {
    return "set_wallpaper";
  }

  if (
    normalized === "command_play_sound" ||
    normalized === "command_play_sound_loop" ||
    normalized === "group_command_play_sound" ||
    normalized === "play_sound" ||
    normalized === "play_sound_loop"
  ) {
    return "play_sound";
  }

  return null;
}

function getReportMediaBackupContexts(commandType) {
  const commandKey = getReportMediaBackupCommandKey(commandType);
  if (commandKey === "image_popup") return ["image_popup"];
  if (commandKey === "set_wallpaper") {
    return ["set_wallpaper", "set_wallpaper_media"];
  }
  if (commandKey === "play_sound") return ["play_sound"];
  return [];
}

function normalizeStoredMime(value, fallback = "application/octet-stream") {
  const mime = String(value || "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
  return mime || fallback;
}

function sanitizeReportMediaBackupName(name, fallbackBase = "reported-media") {
  const base = path
    .basename(
      String(name || "")
        .split("#")[0]
        .split("?")[0],
    )
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return base || fallbackBase;
}

function buildReportMediaBackupOriginalName({
  preferredName = "",
  rawUrl = "",
  ext = "",
  fallbackBase = "reported-media",
}) {
  const normalizedExt = String(ext || "").trim().toLowerCase();
  const candidates = [
    sanitizeReportMediaBackupName(preferredName, ""),
    (() => {
      try {
        const parsed = new URL(String(rawUrl || ""));
        return sanitizeReportMediaBackupName(parsed.pathname, "");
      } catch {
        return "";
      }
    })(),
  ].filter(Boolean);

  const fallback = sanitizeReportMediaBackupName(fallbackBase, "reported-media");
  const candidate = candidates[0] || fallback;
  const candidateExt = path.extname(candidate).slice(1).toLowerCase();
  const baseName = candidateExt
    ? candidate.slice(0, -(candidateExt.length + 1))
    : candidate;

  if (normalizedExt && candidateExt === normalizedExt) {
    return candidate;
  }

  return normalizedExt
    ? `${baseName || fallback}.${normalizedExt}`
    : candidate;
}

function resolveReportMediaBackupCaptureSpec({
  commandType,
  sourceUrl,
  sourceName = "",
  sourceMime = "",
}) {
  const commandKey = getReportMediaBackupCommandKey(commandType);
  if (!commandKey || !isHttpUrl(sourceUrl)) return null;

  const contexts = getReportMediaBackupContexts(commandType);
  if (!contexts.length) return null;

  const normalizedMime = normalizeStoredMime(sourceMime, "");
  const candidateExts = [];
  const seenExts = new Set();
  const pushExt = (value) => {
    const ext = String(value || "").trim().toLowerCase();
    if (!ext || seenExts.has(ext)) return;
    seenExts.add(ext);
    candidateExts.push(ext);
  };

  pushExt(path.extname(String(sourceName || "")).slice(1));
  pushExt(getUrlFileExtension(sourceUrl));

  if (normalizedMime) {
    for (const [ext, rule] of Object.entries(UPLOAD_FILE_RULES)) {
      const allowedInContext = contexts.some((context) => rule.contexts.has(context));
      if (!allowedInContext) continue;

      const directMimeMatch = rule.mimeTypes.some(
        (allowed) =>
          normalizedMime === allowed ||
          normalizedMime.startsWith(allowed + ";"),
      );
      const broadMimeMatch =
        (rule.mediaGroup === "audio" && normalizedMime.startsWith("audio/")) ||
        (rule.previewKind === "image" && normalizedMime.startsWith("image/")) ||
        (rule.previewKind === "video" && normalizedMime.startsWith("video/"));

      if (directMimeMatch || broadMimeMatch) {
        pushExt(ext);
      }
    }

    if (
      commandKey === "set_wallpaper" &&
      (normalizedMime === "video/ogg" ||
        normalizedMime === "video/ogv" ||
        normalizedMime.startsWith("video/webm"))
    ) {
      pushExt("ogv");
      pushExt("webm");
    }
  }

  for (const ext of candidateExts) {
    for (const context of contexts) {
      const originalName = buildReportMediaBackupOriginalName({
        preferredName: sourceName,
        rawUrl: sourceUrl,
        ext,
        fallbackBase: commandKey,
      });
      const matched = getUploadRuleForFile({
        context,
        filename: originalName,
        mime: normalizedMime,
      });
      if (matched.ok) {
        return {
          commandKey,
          context,
          ext: matched.ext,
          mime: normalizeStoredMime(matched.mime, matched.rule.mimeTypes[0]),
          rule: matched.rule,
          originalName,
        };
      }
    }
  }

  return null;
}

function findManagedUploadRowByUrl(req, rawUrl) {
  if (!isManagedUploadUrl(req, rawUrl)) return null;

  let storedName = "";
  try {
    const parsed = new URL(String(rawUrl || ""));
    storedName = decodeURIComponent(path.basename(String(parsed.pathname || "")));
  } catch {
    return null;
  }

  if (!storedName) return null;

  const row = db
    .prepare(
      `
      SELECT
        id,
        original_name,
        stored_name,
        file_path,
        mime,
        ext,
        bytes,
        created_at
      FROM uploaded_files
      WHERE stored_name=?
      LIMIT 1
    `,
    )
    .get(storedName);

  if (!row) return null;

  const abs = path.resolve(String(row.file_path || ""));
  if (!isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs)) {
    return null;
  }

  return row;
}

async function readResponseBodyWithLimit(response, maxBytes) {
  const limit = Math.max(1, Number(maxBytes || 0) || UPLOAD_ANIMATED_MAX_BYTES);
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength && contentLength > limit) {
    throw new Error("That file is too large to preserve with the report.");
  }

  if (!response.body) return Buffer.alloc(0);

  const stream =
    typeof Readable.fromWeb === "function" &&
    response.body &&
    typeof response.body.getReader === "function"
      ? Readable.fromWeb(response.body)
      : response.body;

  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bufferChunk.length;
    if (total > limit) {
      throw new Error("That file is too large to preserve with the report.");
    }
    chunks.push(bufferChunk);
  }

  return Buffer.concat(chunks, total);
}

function createReportMediaBackupRecord({
  reportId,
  backupKind,
  sourceUrl,
  originalName,
  mime,
  ext,
  buffer,
}) {
  const existing = db
    .prepare(
      `
      SELECT id, report_id, backup_kind, source_url, original_name, stored_name,
             file_path, mime, ext, bytes, created_at
      FROM report_media_backups
      WHERE report_id=?
      LIMIT 1
    `,
    )
    .get(String(reportId || "").trim());
  if (existing) return existing;

  const safeReportId = String(reportId || "").trim();
  const safeKind = String(backupKind || "").trim() || "media";
  const safeExt = String(ext || "").trim().toLowerCase();
  const safeOriginalName = buildReportMediaBackupOriginalName({
    preferredName: originalName,
    rawUrl: sourceUrl,
    ext: safeExt,
    fallbackBase: safeKind,
  });
  const safeMime = normalizeStoredMime(mime);
  const bytes = Buffer.isBuffer(buffer) ? buffer.length : 0;

  if (!safeReportId || !bytes || !safeExt) {
    throw new Error("Invalid report media backup.");
  }

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const storedName = `report_${createdAt}_${id}.${safeExt}`;
  const filePath = path.join(REPORT_MEDIA_BACKUPS_DIR, storedName);

  fs.writeFileSync(filePath, buffer);

  try {
    db.prepare(
      `
      INSERT INTO report_media_backups (
        id,
        report_id,
        backup_kind,
        source_url,
        original_name,
        stored_name,
        file_path,
        mime,
        ext,
        bytes,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      safeReportId,
      safeKind,
      String(sourceUrl || "").trim() || null,
      safeOriginalName,
      storedName,
      filePath,
      safeMime,
      safeExt,
      bytes,
      createdAt,
    );
  } catch (err) {
    safeUnlink(filePath, "report-media-backups");
    throw err;
  }

  return {
    id,
    report_id: safeReportId,
    backup_kind: safeKind,
    source_url: String(sourceUrl || "").trim() || null,
    original_name: safeOriginalName,
    stored_name: storedName,
    file_path: filePath,
    mime: safeMime,
    ext: safeExt,
    bytes,
    created_at: createdAt,
  };
}

async function captureReportMediaBackupFromCommand({
  report,
  commandType,
  sourceUrl,
  sourceName = "",
  sourceMime = "",
  req = null,
}) {
  const reportId = String(report?.id || "").trim();
  const safeUrl = String(sourceUrl || "").trim();
  const commandKey = getReportMediaBackupCommandKey(commandType);
  if (!reportId || !commandKey || !isHttpUrl(safeUrl)) return null;

  const managedUploadRow = req ? findManagedUploadRowByUrl(req, safeUrl) : null;
  let captureSpec = resolveReportMediaBackupCaptureSpec({
    commandType,
    sourceUrl: safeUrl,
    sourceName:
      sourceName ||
      managedUploadRow?.original_name ||
      managedUploadRow?.stored_name ||
      "",
    sourceMime: sourceMime || managedUploadRow?.mime || "",
  });
  if (!captureSpec) return null;

  let buffer = null;
  let finalMime =
    sourceMime ||
    managedUploadRow?.mime ||
    captureSpec.mime ||
    captureSpec.rule.mimeTypes[0];

  if (managedUploadRow) {
    const abs = path.resolve(String(managedUploadRow.file_path || ""));
    if (!isManagedPathInDir(abs, UPLOADS_DIR) || !fs.existsSync(abs)) {
      throw new Error("The uploaded file for this command is no longer available.");
    }

    const size = Number(managedUploadRow.bytes || 0);
    if (size && size > Number(captureSpec.rule.maxBytes || 0)) {
      throw new Error("That file is too large to preserve with the report.");
    }

    buffer = fs.readFileSync(abs);
    if (buffer.length > Number(captureSpec.rule.maxBytes || 0)) {
      throw new Error("That file is too large to preserve with the report.");
    }
  } else {
    const response = await fetch(safeUrl, {
      method: "GET",
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`Could not fetch report media backup (HTTP ${response.status}).`);
    }

    const responseMime = normalizeStoredMime(
      response.headers.get("content-type") || sourceMime || captureSpec.mime,
      captureSpec.mime,
    );
    const responseSpec = resolveReportMediaBackupCaptureSpec({
      commandType,
      sourceUrl: safeUrl,
      sourceName,
      sourceMime: responseMime,
    });
    if (responseSpec) {
      captureSpec = responseSpec;
    }

    buffer = await readResponseBodyWithLimit(
      response,
      captureSpec.rule.maxBytes,
    );
    finalMime = responseMime || finalMime;
  }

  if (!buffer || !buffer.length) {
    throw new Error("Could not read the media file for this report.");
  }

  const backup = createReportMediaBackupRecord({
    reportId,
    backupKind: commandKey,
    sourceUrl: safeUrl,
    originalName: captureSpec.originalName,
    mime: finalMime,
    ext: captureSpec.ext,
    buffer,
  });

  logEvent({
    type: "report_media_backup_created",
    actorUserId: String(report?.reporterUserId || "").trim() || null,
    targetUserId: String(report?.subjectId || "").trim() || null,
    req,
    payload: {
      reportId,
      backupId: backup.id,
      backupKind: commandKey,
      bytes: Number(backup.bytes || 0),
    },
  });

  return backup;
}

function deleteReportMediaBackups(rows, reason = "cleanup") {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return 0;

  const tx = db.transaction((list) => {
    for (const row of list) {
      const abs = path.resolve(String(row.file_path || ""));
      if (!isManagedPathInDir(abs, REPORT_MEDIA_BACKUPS_DIR)) {
        console.warn(
          "[report-backups] refusing to unlink outside backups dir:",
          abs,
        );
      } else {
        safeUnlink(abs, "report-media-backups");
      }

      deleteReportMediaBackupRow.run(String(row.id || ""));
    }
  });

  try {
    tx(items);
    console.log("[report-backups] deleted", items.length, "files for", reason);
    return items.length;
  } catch (e) {
    console.warn("[report-backups] delete tx failed:", e?.message || e);
    return 0;
  }
}

function appendCacheBust(url, version) {
  const base = String(url || "").trim();
  if (!base) return "";
  const v = Number(version || 0);
  if (!v) return base;
  return `${base}${base.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(v))}`;
}

function buildControlLinkAssetAdminUrl(discordId, kind, updatedAt) {
  const user = { discord_id: discordId };
  switch (kind) {
    case "avatar":
      return appendCacheBust(siteAvatarUrl(user, 256), updatedAt);
    case "banner":
      return appendCacheBust(siteBannerUrl(user, 1600), updatedAt);
    case "background":
      return appendCacheBust(siteBackgroundUrl(user, 1920), updatedAt);
    default:
      return "";
  }
}

function listControlLinkAssetsForAdmin() {
  const rows = db
    .prepare(
      `
      SELECT
        discord_id,
        username,
        global_name,
        avatar,
        control_link_display_name,
        custom_avatar_path,
        custom_avatar_mime,
        custom_avatar_updated_at,
        custom_banner_path,
        custom_banner_mime,
        custom_banner_updated_at,
        custom_background_path,
        custom_background_mime,
        custom_background_updated_at
      FROM users
      WHERE
        TRIM(IFNULL(custom_avatar_path, '')) <> ''
        OR TRIM(IFNULL(custom_banner_path, '')) <> ''
        OR TRIM(IFNULL(custom_background_path, '')) <> ''
    `,
    )
    .all();

  const cards = [];
  let totalBytes = 0;
  let totalAssets = 0;

  const assetConfigs = [
    {
      kind: "avatar",
      label: "Profile Picture",
      pathField: "custom_avatar_path",
      mimeField: "custom_avatar_mime",
      updatedField: "custom_avatar_updated_at",
    },
    {
      kind: "banner",
      label: "Banner",
      pathField: "custom_banner_path",
      mimeField: "custom_banner_mime",
      updatedField: "custom_banner_updated_at",
    },
    {
      kind: "background",
      label: "Background",
      pathField: "custom_background_path",
      mimeField: "custom_background_mime",
      updatedField: "custom_background_updated_at",
    },
  ];

  for (const row of rows) {
    const discordId = String(row.discord_id || "").trim();
    if (!discordId) continue;

    const assets = [];
    let latestUpdatedAt = 0;

    for (const config of assetConfigs) {
      const storedPath = String(row[config.pathField] || "").trim();
      if (!storedPath) continue;

      const abs = resolveStoredSiteAvatarPath(storedPath);
      if (!abs || !isManagedPathInDir(abs, SITE_AVATARS_DIR) || !fs.existsSync(abs)) {
        continue;
      }

      let bytes = 0;
      try {
        bytes = Number(fs.statSync(abs).size || 0);
      } catch {}

      const updatedAt = Number(row[config.updatedField] || 0);
      latestUpdatedAt = Math.max(latestUpdatedAt, updatedAt);
      totalBytes += bytes;
      totalAssets += 1;

      assets.push({
        kind: config.kind,
        label: config.label,
        url: buildControlLinkAssetAdminUrl(discordId, config.kind, updatedAt),
        bytes,
        sizeLabel: formatBytesCompact(bytes),
        updatedAt,
        updatedAtLabel: updatedAt
          ? new Date(updatedAt).toLocaleString()
          : "Unknown",
        mime:
          String(row[config.mimeField] || "").trim() ||
          siteAvatarMimeFromPath(abs),
      });
    }

    if (!assets.length) continue;

    cards.push({
      user: {
        discordId,
        username: String(row.username || "").trim(),
        globalName: String(row.global_name || "").trim(),
        displayName: getPreferredDisplayName(row) || discordId,
        avatarUrl: siteAvatarUrl({ discord_id: discordId }, 64),
      },
      latestUpdatedAt,
      assets,
    });
  }

  cards.sort((a, b) => {
    if (b.latestUpdatedAt !== a.latestUpdatedAt) {
      return b.latestUpdatedAt - a.latestUpdatedAt;
    }
    return String(a.user.displayName || "").localeCompare(
      String(b.user.displayName || ""),
    );
  });

  return {
    cards,
    stats: {
      userCount: cards.length,
      assetCount: totalAssets,
      totalBytes,
      totalBytesLabel: formatBytesCompact(totalBytes),
    },
  };
}

function runUploadsJanitorOnce() {
  const deleted = purgeExpiredUploadedFiles(UPLOAD_JANITOR_LIMIT);
  if (deleted > 0) {
    console.log("[uploads] janitor deleted", deleted, "expired uploads");
  }
}

function isManagedUploadUrl(req, rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return false;

  try {
    const url = new URL(input);
    const proto = String(url.protocol || "").toLowerCase();
    if (proto !== "http:" && proto !== "https:") return false;

    const requestHost = normalizeHost(req.get("host"));
    if (!requestHost) return false;

    return (
      normalizeHost(url.host) === requestHost &&
      String(url.pathname || "").startsWith("/uploads/")
    );
  } catch {
    return false;
  }
}

function enforceManagedUrlPolicy({ db, logEvent }, req, res, rawUrl) {
  if (isManagedUploadUrl(req, rawUrl)) {
    return { ok: true, status: "managed_upload" };
  }

  return enforceUrlPolicy({ db, logEvent }, req, res, rawUrl);
}

  return {
    captureReportMediaBackupFromCommand,
    createReportMediaBackupRecord,
    deleteReportMediaBackups,
    deleteUploadedFiles,
    enforceManagedUrlPolicy,
    ensureUploadCapacityForNewFile,
    getRecentUploadsByContextForUser,
    getUploadContextUiConfig,
    getUploadRuleForFile,
    isManagedPathInDir,
    listAllUploadedFilesForAdmin,
    listControlLinkAssetsForAdmin,
    listRecentUploadedFilesForUser,
    normalizeStoredMime,
    resolveReportMediaBackupCaptureSpec,
    runUploadsJanitorOnce,
    serializeUploadedFileRow,
  };
}

module.exports = { createUploadService };
