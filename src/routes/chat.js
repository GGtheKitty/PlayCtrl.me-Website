const CHAT_MESSAGE_MAX_LENGTH = 500;
const CHAT_MESSAGE_LIMIT = 100;
const CHAT_MESSAGE_RETENTION_LIMIT = 1000;
const CHAT_POST_COOLDOWN_MS = 3000;
const CHAT_MEDIA_EMBED_LIMIT = 4;
const CHAT_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const CHAT_VIDEO_EXTENSIONS = new Set([
  ".mov",
  ".mp4",
  ".ogg",
  ".ogv",
  ".webm",
]);
const CHAT_MUTE_DURATIONS_MS = Object.freeze({
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  permanent: null,
});

function normalizeChatMessageBody(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, CHAT_MESSAGE_MAX_LENGTH);
}

function normalizeMuteDuration(value) {
  const key = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CHAT_MUTE_DURATIONS_MS, key)
    ? key
    : "24h";
}

function isChatImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const pathname = url.pathname.toLowerCase();
    if ([...CHAT_IMAGE_EXTENSIONS].some((extension) => pathname.endsWith(extension))) {
      return true;
    }
    const format = String(url.searchParams.get("format") || "").toLowerCase();
    return CHAT_IMAGE_EXTENSIONS.has(`.${format}`);
  } catch {
    return false;
  }
}

function isChatVideoUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const pathname = url.pathname.toLowerCase();
    if ([...CHAT_VIDEO_EXTENSIONS].some((extension) => pathname.endsWith(extension))) {
      return true;
    }
    const format = String(url.searchParams.get("format") || "").toLowerCase();
    return CHAT_VIDEO_EXTENSIONS.has(`.${format}`);
  } catch {
    return false;
  }
}

function buildChatMessageContent(value) {
  const body = String(value || "");
  const matches = [];
  const urlPattern = /\bhttps?:\/\/[^\s<>"']+/gi;
  let match;

  while ((match = urlPattern.exec(body)) && matches.length < CHAT_MEDIA_EMBED_LIMIT) {
    const raw = String(match[0] || "");
    const url = raw.replace(/[),.!?]+$/g, "");
    const kind = isChatImageUrl(url)
      ? "image"
      : isChatVideoUrl(url)
        ? "video"
        : "";
    if (!url || !kind) continue;
    matches.push({
      url,
      kind,
      start: match.index,
      end: match.index + url.length,
    });
  }

  if (!matches.length) return { text: body, imageUrls: [], videoUrls: [] };

  let cursor = 0;
  let text = "";
  for (const item of matches) {
    text += body.slice(cursor, item.start);
    cursor = item.end;
  }
  text += body.slice(cursor);

  return {
    text: text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/ {2,}/g, " ")
      .trim(),
    imageUrls: matches
      .filter((item) => item.kind === "image")
      .map((item) => item.url),
    videoUrls: matches
      .filter((item) => item.kind === "video")
      .map((item) => item.url),
  };
}

function registerChatRoutes(app, deps) {
  const {
    createUserReport,
    db,
    getPreferredDisplayName,
    isAdmin,
    logEvent,
    renderWithLayout,
    requireDiscord,
    requireNotBanned,
    siteAvatarUrl,
    reportReasonByKey,
    reportReasonOptions,
  } = deps;

  function getActiveMute(userId, now = Date.now()) {
    const row = db
      .prepare(
        `SELECT user_id, muted_by_user_id, reason, created_at, expires_at
         FROM public_chat_mutes
         WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)`,
      )
      .get(userId, now);
    return row || null;
  }

  function serializeMute(row) {
    if (!row) return null;
    return {
      reason: String(row.reason || "").trim(),
      created_at: Number(row.created_at || 0),
      expires_at: row.expires_at == null ? null : Number(row.expires_at),
    };
  }

  function listMessages(limit = CHAT_MESSAGE_LIMIT) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || CHAT_MESSAGE_LIMIT, CHAT_MESSAGE_LIMIT));
    const rows = db
      .prepare(
        `SELECT pcm.id, pcm.author_user_id, pcm.body, pcm.created_at,
                u.username, u.global_name, u.avatar, u.control_link_display_name,
                CASE WHEN a.discord_id IS NULL THEN 0 ELSE 1 END AS author_is_admin,
                CASE WHEN m.user_id IS NOT NULL
                          AND (m.expires_at IS NULL OR m.expires_at>?)
                     THEN 1 ELSE 0 END AS author_is_muted,
                m.expires_at AS mute_expires_at
         FROM public_chat_messages pcm
         LEFT JOIN users u ON u.discord_id=pcm.author_user_id
         LEFT JOIN admins a ON a.discord_id=pcm.author_user_id
         LEFT JOIN public_chat_mutes m ON m.user_id=pcm.author_user_id
         ORDER BY pcm.created_at DESC, pcm.id DESC
         LIMIT ?`,
      )
      .all(Date.now(), safeLimit);

    return rows.reverse().map((row) => {
      const author = {
        discord_id: String(row.author_user_id || "").trim(),
        username: row.username || "",
        global_name: row.global_name || "",
        avatar: row.avatar || "",
        control_link_display_name: row.control_link_display_name || "",
      };
      const messageContent = buildChatMessageContent(row.body);
      return {
        id: Number(row.id),
        author_user_id: author.discord_id,
        author_display_name: getPreferredDisplayName(author) || "Member",
        author_avatar_url: siteAvatarUrl(author, 64),
        author_is_admin: !!Number(row.author_is_admin || 0),
        author_is_muted: !!Number(row.author_is_muted || 0),
        mute_expires_at:
          row.mute_expires_at == null ? null : Number(row.mute_expires_at),
        body: String(row.body || ""),
        display_body: messageContent.text,
        image_urls: messageContent.imageUrls,
        video_urls: messageContent.videoUrls,
        created_at: Number(row.created_at || 0),
      };
    });
  }

  function roomPayload(userId) {
    return {
      ok: true,
      messages: listMessages(),
      mute: serializeMute(getActiveMute(userId)),
      cooldown_ms: CHAT_POST_COOLDOWN_MS,
    };
  }

  const postMessage = db.transaction((authorUserId, body, now) => {
    const latest = db
      .prepare(
        `SELECT created_at FROM public_chat_messages
         WHERE author_user_id=? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(authorUserId);
    const retryAfterMs = CHAT_POST_COOLDOWN_MS - (now - Number(latest?.created_at || 0));
    if (latest && retryAfterMs > 0) {
      const error = new Error("chat_cooldown");
      error.retryAfterMs = retryAfterMs;
      throw error;
    }

    const result = db
      .prepare(
        `INSERT INTO public_chat_messages (author_user_id, body, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(authorUserId, body, now);
    db.prepare(
      `DELETE FROM public_chat_messages
       WHERE id NOT IN (
         SELECT id FROM public_chat_messages
         ORDER BY created_at DESC, id DESC LIMIT ?
       )`,
    ).run(CHAT_MESSAGE_RETENTION_LIMIT);
    return Number(result.lastInsertRowid);
  });

  app.get("/chat", requireDiscord, requireNotBanned, (req, res) => {
    const viewerId = String(req.user.discord_id || "").trim();
    res.locals.layoutBodyClass = "page-public-chat";
    renderWithLayout(res, "pages/chat/chat_main", {
      title: "Public Chat",
      extraStylesheets: ["/css/chat.css"],
      chatMessages: listMessages(),
      chatMute: serializeMute(getActiveMute(viewerId)),
      viewerIsChatAdmin: !!isAdmin(viewerId),
      chatReportReasonOptions: Array.isArray(reportReasonOptions)
        ? reportReasonOptions
        : [],
      meta: {
        ogTitle: "Public Chat | PlayCtrl.me",
        ogDesc: "Talk with the PlayCtrl.me community.",
      },
    });
  });

  app.get("/api/chat/messages", requireDiscord, requireNotBanned, (req, res) => {
    return res.json(roomPayload(String(req.user.discord_id || "").trim()));
  });

  app.post("/api/chat/messages", requireDiscord, requireNotBanned, (req, res) => {
    const userId = String(req.user.discord_id || "").trim();
    const mute = getActiveMute(userId);
    if (mute) {
      return res.status(403).json({
        ok: false,
        code: "CHAT_MUTED",
        message: "You are muted in public chat.",
        mute: serializeMute(mute),
      });
    }

    const body = normalizeChatMessageBody(req.body?.body);
    if (!body) {
      return res.status(400).json({ ok: false, message: "Message required." });
    }

    const now = Date.now();
    let messageId;
    try {
      messageId = postMessage(userId, body, now);
    } catch (error) {
      if (error?.message === "chat_cooldown") {
        const retryAfterMs = Math.max(1, Number(error.retryAfterMs || 0));
        res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
        return res.status(429).json({
          ok: false,
          code: "CHAT_COOLDOWN",
          retry_after_ms: retryAfterMs,
          message: "Please wait a moment before posting again.",
        });
      }
      throw error;
    }

    logEvent({
      type: "public_chat_message_posted",
      actorUserId: userId,
      req,
      payload: { messageId, body, createdAt: now },
    });
    return res.json(roomPayload(userId));
  });

  app.post(
    "/api/chat/messages/:messageId/report",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const messageId = Number(req.params.messageId);
      const viewerId = String(req.user.discord_id || "").trim();
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ ok: false, message: "Invalid message." });
      }
      const message = db
        .prepare(
          `SELECT pcm.id, pcm.author_user_id, pcm.body, pcm.created_at,
                  u.username, u.global_name, u.avatar, u.control_link_display_name
           FROM public_chat_messages pcm
           LEFT JOIN users u ON u.discord_id=pcm.author_user_id
           WHERE pcm.id=?`,
        )
        .get(messageId);
      if (!message) {
        return res.status(404).json({ ok: false, message: "Message not found." });
      }
      if (String(message.author_user_id || "") === viewerId) {
        return res.status(400).json({ ok: false, message: "You can't report your own message." });
      }

      try {
        const created = createUserReport({
          subjectUserId: String(message.author_user_id || "").trim(),
          subjectUser: {
            discord_id: String(message.author_user_id || "").trim(),
            username: message.username || "",
            global_name: message.global_name || "",
            avatar: message.avatar || "",
            control_link_display_name: message.control_link_display_name || "",
          },
          reporterUser: req.user,
          reasonKey: req.body?.reason,
          reasonMap: reportReasonByKey,
          details: req.body?.details,
          meta: {
            sourceKind: "public_chat_message",
            messageId,
            messageBody: String(message.body || ""),
            messageCreatedAt: Number(message.created_at || 0),
            chatUrl: "/chat",
          },
          req,
        });
        return res.json({
          ok: true,
          reportId: created.report.id,
          message: "Message reported to the moderation team.",
        });
      } catch (error) {
        return res.status(400).json({
          ok: false,
          message: String(error?.message || "Could not report message."),
        });
      }
    },
  );

  app.delete(
    "/api/chat/messages/:messageId",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const viewerId = String(req.user.discord_id || "").trim();
      const viewerIsAdmin = isAdmin(viewerId);
      const messageId = Number(req.params.messageId);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ ok: false, message: "Invalid message." });
      }
      const message = db
        .prepare(
          `SELECT id, author_user_id, body, created_at
           FROM public_chat_messages WHERE id=?`,
        )
        .get(messageId);
      if (!message) {
        return res.status(404).json({ ok: false, message: "Message not found." });
      }
      const authorUserId = String(message.author_user_id || "").trim();
      const isOwnMessage = authorUserId === viewerId;
      if (!isOwnMessage && !viewerIsAdmin) {
        return res.status(403).json({
          ok: false,
          message: "You can only delete your own messages.",
        });
      }
      db.prepare("DELETE FROM public_chat_messages WHERE id=?").run(messageId);
      logEvent({
        type: viewerIsAdmin && !isOwnMessage
          ? "public_chat_message_deleted_by_admin"
          : "public_chat_message_deleted_by_author",
        actorUserId: viewerId,
        targetUserId: authorUserId || null,
        req,
        payload: {
          messageId,
          messageBody: String(message.body || ""),
          messageCreatedAt: Number(message.created_at || 0),
        },
      });
      return res.json({ ok: true, message: "Message deleted.", messages: listMessages() });
    },
  );

  app.post(
    "/api/chat/mutes/:userId",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const adminId = String(req.user.discord_id || "").trim();
      const targetUserId = String(req.params.userId || "").trim();
      if (!isAdmin(adminId)) {
        return res.status(403).json({ ok: false, message: "Admin access required." });
      }
      if (!targetUserId || !db.prepare("SELECT 1 FROM users WHERE discord_id=?").get(targetUserId)) {
        return res.status(404).json({ ok: false, message: "User not found." });
      }
      if (targetUserId === adminId || isAdmin(targetUserId)) {
        return res.status(400).json({ ok: false, message: "Admins cannot be muted." });
      }

      const duration = normalizeMuteDuration(req.body?.duration);
      const durationMs = CHAT_MUTE_DURATIONS_MS[duration];
      const now = Date.now();
      const expiresAt = durationMs == null ? null : now + durationMs;
      const reason = String(req.body?.reason || "").replace(/\s+/g, " ").trim().slice(0, 300);
      db.prepare(
        `INSERT INTO public_chat_mutes
           (user_id, muted_by_user_id, reason, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           muted_by_user_id=excluded.muted_by_user_id,
           reason=excluded.reason,
           created_at=excluded.created_at,
           expires_at=excluded.expires_at`,
      ).run(targetUserId, adminId, reason || null, now, expiresAt);
      logEvent({
        type: "public_chat_user_muted",
        actorUserId: adminId,
        targetUserId,
        req,
        payload: { duration, reason: reason || null, expiresAt },
      });
      return res.json({ ok: true, message: "User muted.", messages: listMessages() });
    },
  );

  app.delete(
    "/api/chat/mutes/:userId",
    requireDiscord,
    requireNotBanned,
    (req, res) => {
      const adminId = String(req.user.discord_id || "").trim();
      const targetUserId = String(req.params.userId || "").trim();
      if (!isAdmin(adminId)) {
        return res.status(403).json({ ok: false, message: "Admin access required." });
      }
      const result = db.prepare("DELETE FROM public_chat_mutes WHERE user_id=?").run(targetUserId);
      if (!result.changes) {
        return res.status(404).json({ ok: false, message: "That user is not muted." });
      }
      logEvent({
        type: "public_chat_user_unmuted",
        actorUserId: adminId,
        targetUserId,
        req,
        payload: {},
      });
      return res.json({ ok: true, message: "User unmuted.", messages: listMessages() });
    },
  );
}

module.exports = {
  CHAT_MESSAGE_MAX_LENGTH,
  buildChatMessageContent,
  isChatImageUrl,
  isChatVideoUrl,
  normalizeChatMessageBody,
  normalizeMuteDuration,
  registerChatRoutes,
};
