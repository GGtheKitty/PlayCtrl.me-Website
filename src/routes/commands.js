function registerCommandRoutes(app, deps) {
  const {
    buildDirectDeliveryMessage,
    buildGroupDeliveryMessage,
    crypto,
    db,
    denyIfBlockedCommandSender,
    denyIfDisabled,
    enforceManagedUrlPolicy,
    enforceWebCooldownForNewUsers,
    groupHasReportedCapabilityForActor,
    heavyCooldown,
    incrementCommandsSentTotal,
    incrementCommandsSentTotalOnce,
    isCommunityGroupCommandEnabled,
    isAllowedByWhitelist,
    isAllowedWallpaperExt,
    isHttpUrl,
    logEvent,
    logDeliveredDirectCommandHistory,
    ownerHasReportedCapabilityForActor,
    requireDiscord,
    requireNotBanned,
    resolvePopupMediaUrl,
    resolveOwnerAndDevicesByPairCode,
    sendCommandToResolvedTarget,
    sendToGroupAndWait,
  } = deps;

  const WRITE_FOR_ME_MAX_LENGTH = 4000;
  const WRITE_FOR_ME_INVALID_CHAR_RE = /[^\x20-\x7E]/;
  const SUBLIMINAL_MESSAGE_MAX_LENGTH = 2000;
  const SUBLIMINAL_MESSAGE_MAX_COUNT = 20;

  function validateWriteForMeMessage(rawValue) {
    const rawMessage = String(rawValue ?? "");
    if (!rawMessage.trim()) {
      return { ok: false, message: "Missing message" };
    }
    if (WRITE_FOR_ME_INVALID_CHAR_RE.test(rawMessage)) {
      return {
        ok: false,
        message:
          "Message must be a single line with standard keyboard characters only",
      };
    }
    return {
      ok: true,
      value: rawMessage.trim().slice(0, WRITE_FOR_ME_MAX_LENGTH),
    };
  }

  function validateSubliminalMessages(rawValue) {
    const rawList = Array.isArray(rawValue)
      ? rawValue
      : rawValue == null
        ? []
        : [rawValue];
    const messages = [];

    for (const item of rawList) {
      const message = String(item ?? "").trim();
      if (!message) continue;

      messages.push(message.slice(0, SUBLIMINAL_MESSAGE_MAX_LENGTH));
      if (messages.length > SUBLIMINAL_MESSAGE_MAX_COUNT) {
        return {
          ok: false,
          message: `You can send up to ${SUBLIMINAL_MESSAGE_MAX_COUNT} messages at once`,
        };
      }
    }

    if (!messages.length) {
      return { ok: false, message: "Add at least one message" };
    }

    return { ok: true, value: messages };
  }

  function normalizeSelfPreviewMode(value) {
    const mode = String(value || "").trim().toLowerCase();
    if (mode === "standard" || mode === "whitelisted") return mode;
    return null;
  }

  function getCommandActorUserId(req) {
    return String(
      req.actorUser?.discord_id ||
        req.user?.discord_id ||
        req.viewUser?.discord_id ||
        "",
    ).trim();
  }

  function getEffectiveUserId(req) {
    return String(req.user?.discord_id || req.viewUser?.discord_id || "").trim();
  }

  function hasDelegatedControlForOwner(req, ownerUserId) {
    const actorId = getCommandActorUserId(req);
    const effectiveId = getEffectiveUserId(req);
    const ownerId = String(ownerUserId || "").trim();
    if (!actorId || !effectiveId || !ownerId) return false;
    if (actorId === ownerId) return false;
    if (effectiveId !== ownerId) return false;

    const row = db
      .prepare(
        `
          SELECT 1
          FROM leash_delegations
          WHERE sub_user_id=? AND dom_user_id=?
          LIMIT 1
        `,
      )
      .get(ownerId, actorId);
    return !!row;
  }

  function getDirectCommandContext(req, resolved) {
    const actorUserId = getCommandActorUserId(req);
    const effectiveUserId = getEffectiveUserId(req);
    const ownerUserId = String(resolved?.ownerUserId || "").trim();
    const selfPreviewMode =
      effectiveUserId && ownerUserId && effectiveUserId === ownerUserId
        ? normalizeSelfPreviewMode(req.body?.preview_mode)
        : null;

    return {
      actorUserId,
      selfPreviewMode,
    };
  }

  function resolveDeviceCommandTarget(req, res, pairCode) {
    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved) {
      res.send("Invalid code");
      return null;
    }

    const actorUserId = getCommandActorUserId(req);
    const hasDelegatedControl = hasDelegatedControlForOwner(
      req,
      resolved.ownerUserId,
    );

    if (
      !hasDelegatedControl &&
      !isAllowedByWhitelist(resolved.ownerUserId, actorUserId)
    ) {
      res.send("Not allowed");
      return null;
    }

    if (
      !hasDelegatedControl &&
      denyIfBlockedCommandSender(res, resolved.ownerUserId, actorUserId)
    ) {
      return null;
    }

    return resolved;
  }

  function finalizeDeviceCommand(
    req,
    res,
    resolved,
    result,
    {
      pairCode = null,
      commandPayload = null,
      historyCommandPayload = null,
      commandId = null,
    } = {},
  ) {
    if (!result.ok) {
      return res.send(buildDirectDeliveryMessage(result));
    }

    if (result.delivery === "sent" && Number(result.sent || 0) > 0) {
      logDeliveredDirectCommandHistory({
        actorUserId: getCommandActorUserId(req),
        targetUserId: resolved.ownerUserId,
        pairCode,
        commandPayload: historyCommandPayload || commandPayload,
        commandId: commandId || result.commandId || null,
        req,
      });
    }

    const failed = Array.isArray(result.acks)
      ? result.acks.some((ack) => !ack?.ok)
      : false;
    if (result.delivery === "queued" || !failed) {
      incrementCommandsSentTotal({
        senderDiscordId: getCommandActorUserId(req),
        targetOwnerDiscordId: resolved.ownerUserId,
      });
    }

    return res.send(buildDirectDeliveryMessage(result));
  }

  function finalizeGroupCommand(res, actorId, result) {
    if (!result.ok) {
      return res.status(409).send(buildGroupDeliveryMessage(result));
    }

    const anyFail = Array.isArray(result.acks)
      ? result.acks.some((ack) => !ack?.ok)
      : false;
    const liveTargets = Array.isArray(result.targets) ? result.targets : [];
    const queuedTargets = Array.isArray(result.queuedTargets)
      ? result.queuedTargets
      : [];
    const hasOtherRecipient = liveTargets
      .concat(queuedTargets)
      .some((target) => String(target.ownerUserId) !== String(actorId));
    if ((result.queuedCount > 0 || !anyFail) && hasOtherRecipient) {
      incrementCommandsSentTotalOnce(actorId);
    }

    return res.send(buildGroupDeliveryMessage(result));
  }

  function sendValidationError(res, statusCode, message) {
    if (statusCode && statusCode !== 200) {
      res.status(statusCode).send(message);
      return;
    }
    res.send(message);
  }

  function getCommunityGroupCommandAccess(groupKey, actorUserId) {
    const key = String(groupKey || "").trim();
    const actorId = String(actorUserId || "").trim();
    if (!key) {
      return {
        ok: false,
        statusCode: 400,
        message: "Missing group",
      };
    }

    const groupRow = db
      .prepare(
        `
        SELECT
          group_key,
          owner_user_id,
          name,
          IFNULL(is_public, 0) AS is_public
        FROM community_groups
        WHERE group_key=?
        LIMIT 1
      `,
      )
      .get(key);

    if (!groupRow) {
      return { ok: true, kind: "static" };
    }

    const ownerUserId = String(groupRow.owner_user_id || "").trim();
    if (actorId && actorId === ownerUserId) {
      return {
        ok: true,
        kind: "community",
        isOwner: true,
        isMember: true,
      };
    }

    const memberRow = actorId
      ? db
          .prepare(
            `
            SELECT 1
            FROM group_memberships
            WHERE group_key=? AND user_id=?
            LIMIT 1
          `,
          )
          .get(key, actorId)
      : null;
    if (memberRow) {
      return {
        ok: true,
        kind: "community",
        isOwner: false,
        isMember: true,
      };
    }

    return {
      ok: false,
      kind: "community",
      statusCode: 403,
      message: Number(groupRow.is_public || 0)
        ? "Join this community group before sending commands"
        : "You must be invited to use this private community group",
    };
  }

  function ensureActorCanUseGroup(req, res, groupKey) {
    const access = getCommunityGroupCommandAccess(
      groupKey,
      getEffectiveUserId(req),
    );
    if (!access.ok) {
      res.status(access.statusCode || 403).send(access.message || "Forbidden");
      return null;
    }
    return access;
  }

  function ensureGroupCommandEnabled(req, res, groupKey, commandKey) {
    if (
      typeof isCommunityGroupCommandEnabled === "function" &&
      !isCommunityGroupCommandEnabled(groupKey, commandKey)
    ) {
      res.status(403).send("That command is disabled for this community group.");
      return false;
    }
    return true;
  }

  function validatePlaySoundRequest(
    req,
    res,
    { kind, name, url, invalidStatusCode = 200 },
  ) {
    if (kind !== "builtin" && kind !== "url") {
      sendValidationError(res, invalidStatusCode, "Invalid kind");
      return null;
    }

    if (kind === "builtin") {
      if (!name) {
        sendValidationError(res, invalidStatusCode, "Missing sound name");
        return null;
      }

      if (name.includes("..") || name.includes("/") || name.includes("\\")) {
        sendValidationError(res, invalidStatusCode, "Invalid sound name");
        return null;
      }
    }

    if (kind === "url") {
      if (!isHttpUrl(url)) {
        sendValidationError(res, invalidStatusCode, "Invalid URL");
        return null;
      }

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return null;
    }

    return kind === "builtin"
      ? { type: "play_sound", kind: "builtin", name }
      : { type: "play_sound", kind: "url", url };
  }

  function validatePlaySoundLoopRequest(
    req,
    res,
    { kind, name, url, baseHz, beatHz, invalidStatusCode = 200 },
  ) {
    if (kind === "tone") {
      const normalizedBaseHz = Number(baseHz);
      const normalizedBeatHz = Number(beatHz);
      if (!Number.isFinite(normalizedBaseHz) || normalizedBaseHz <= 0) {
        sendValidationError(res, invalidStatusCode, "Base frequency must be greater than 0");
        return null;
      }
      if (!Number.isFinite(normalizedBeatHz) || normalizedBeatHz <= 0) {
        sendValidationError(res, invalidStatusCode, "Beat frequency must be greater than 0");
        return null;
      }
      return {
        type: "play_sound_loop",
        kind: "tone",
        baseHz: normalizedBaseHz,
        beatHz: normalizedBeatHz,
      };
    }

    const sound = validatePlaySoundRequest(req, res, {
      kind,
      name,
      url,
      invalidStatusCode,
    });
    return sound ? { ...sound, type: "play_sound_loop" } : null;
  }

  function isSpiralOverlayUrl(rawValue) {
    try {
      const parsed = new URL(String(rawValue || ""));
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        String(parsed.hostname || "").trim().toLowerCase() === "swirl.3bu.dev"
      );
    } catch {
      return false;
    }
  }

  async function buildResolvedPopupCommandPayload({
    commandType,
    url,
    actorUserId = null,
    targetUserId = null,
    req = null,
  } = {}) {
    const safeCommandType = String(commandType || "").trim();
    const originalUrl = String(url || "").trim();

    const resolution = await resolvePopupMediaUrl({
      commandType: safeCommandType,
      url: originalUrl,
      actorUserId,
      targetUserId,
      req,
    });

    if (!resolution?.changed) {
      return {
        commandPayload: { type: safeCommandType, url: originalUrl },
        historyCommandPayload: { type: safeCommandType, url: originalUrl },
      };
    }

    const resolvedUrl = String(resolution.resolvedUrl || "").trim() || originalUrl;
    const resolverKey = String(resolution.resolverKey || "").trim();
    const resolvedUrlHost = String(resolution.resolvedUrlHost || "").trim();

    return {
      commandPayload: {
        type: safeCommandType,
        url: resolvedUrl,
        originalUrl,
        resolvedUrl,
        mediaUrlResolvedBy: resolverKey || undefined,
        resolvedUrlHost: resolvedUrlHost || undefined,
      },
      historyCommandPayload: {
        type: safeCommandType,
        url: originalUrl,
        originalUrl,
        resolvedUrl,
        mediaUrlResolvedBy: resolverKey || undefined,
        resolvedUrlHost: resolvedUrlHost || undefined,
      },
    };
  }

  app.post("/api/device/:pairCode/popup", requireDiscord, async (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    const message = String(req.body?.message || "").trim();
    if (!message) return res.send("Missing message");

    const resolved = resolveDeviceCommandTarget(req, res, pairCode);
    if (!resolved) return;
    const directContext = getDirectCommandContext(req, resolved);

    const commandId = crypto.randomUUID();
    const commandPayload = { type: "popup", message };

    const result = await sendCommandToResolvedTarget({
      resolved,
      requestId: commandId,
      actorUserId: directContext.actorUserId,
      commandPayload,
      timeoutMs: 15000,
      sourceKind: "direct",
      sourceId: pairCode,
      selfPreviewMode: directContext.selfPreviewMode,
      req,
    });

    return finalizeDeviceCommand(req, res, resolved, result, {
      pairCode,
      commandPayload,
      commandId,
    });
  });

  async function handleDirectSubliminalMessage(req, res) {
    const pairCode = String(req.params.pairCode || "").trim();
    const messagesCheck = validateSubliminalMessages(req.body?.messages);

    if (!messagesCheck.ok) {
      return res.status(400).send(messagesCheck.message);
    }

    const resolved = resolveDeviceCommandTarget(req, res, pairCode);
    if (!resolved) return;
    const directContext = getDirectCommandContext(req, resolved);

    const commandId = crypto.randomUUID();
    const messages = messagesCheck.value;
    const commandPayload = { type: "subliminal_message", messages };

    const result = await sendCommandToResolvedTarget({
      resolved,
      requestId: commandId,
      actorUserId: directContext.actorUserId,
      commandPayload,
      timeoutMs: 20000,
      sourceKind: "direct",
      sourceId: pairCode,
      selfPreviewMode: directContext.selfPreviewMode,
      req,
    });

    return finalizeDeviceCommand(req, res, resolved, result, {
      pairCode,
      commandPayload,
      commandId,
    });
  }

  app.post(
    "/api/device/:pairCode/subliminal_message",
    requireDiscord,
    handleDirectSubliminalMessage,
  );

  app.post(
    "/api/device/:pairCode/open_url",
    requireDiscord,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const url = String(req.body?.url || "").trim();

      if (!/^https?:\/\//i.test(url)) return res.send("Invalid URL");

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      const commandId = crypto.randomUUID();
      const commandPayload = { type: "open_url", url };

      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload,
        timeoutMs: 15000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/device/:pairCode/image_popup",
    requireDiscord,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const url = String(req.body?.url || "").trim();

      if (!/^https?:\/\//i.test(url)) return res.send("Invalid URL");

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      const commandId = crypto.randomUUID();
      const popupPayload = await buildResolvedPopupCommandPayload({
        commandType: "image_popup",
        url,
        actorUserId: directContext.actorUserId,
        targetUserId: resolved.ownerUserId,
        req,
      });

      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload: popupPayload.commandPayload,
        timeoutMs: 20000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload: popupPayload.commandPayload,
        historyCommandPayload: popupPayload.historyCommandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/device/:pairCode/fullscreen_popup",
    requireDiscord,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const url = String(req.body?.url || "").trim();

      if (!/^https?:\/\//i.test(url)) return res.send("Invalid URL");

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      const commandId = crypto.randomUUID();
      const popupPayload = await buildResolvedPopupCommandPayload({
        commandType: "fullscreen_popup",
        url,
        actorUserId: directContext.actorUserId,
        targetUserId: resolved.ownerUserId,
        req,
      });

      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload: popupPayload.commandPayload,
        timeoutMs: 20000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload: popupPayload.commandPayload,
        historyCommandPayload: popupPayload.historyCommandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/device/:pairCode/spiral_overlay",
    requireDiscord,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const url = String(req.body?.url || "").trim();

      if (!isSpiralOverlayUrl(url)) {
        return res.send("Invalid spiral overlay URL");
      }

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      const commandId = crypto.randomUUID();
      const commandPayload = { type: "spiral_overlay", url };

      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload,
        timeoutMs: 20000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/device/:pairCode/set_wallpaper",
    requireDiscord,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const url = String(req.body?.url || "").trim();

      if (!/^https?:\/\//i.test(url)) return res.send("Invalid URL");

      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      const allowWallpaperMedia = ownerHasReportedCapabilityForActor(
        resolved.ownerUserId,
        directContext.actorUserId,
        "set_wallpaper_media",
        {
          selfPreviewMode: directContext.selfPreviewMode,
        },
      );
      if (!isAllowedWallpaperExt(url, { allowMedia: allowWallpaperMedia })) {
        return res.send("Invalid file type");
      }

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const commandId = crypto.randomUUID();
      const commandPayload = { type: "set_wallpaper", url };

      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload,
        timeoutMs: 20000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/device/:pairCode/screenshot",
    requireDiscord,
    heavyCooldown,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      const commandId = crypto.randomUUID();
      const commandPayload = { type: "screenshot" };

      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload,
        timeoutMs: 30000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/device/:pairCode/webcam_capture",
    requireDiscord,
    heavyCooldown,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      if (denyIfDisabled(req, res, resolved.ownerUserId, "webcam_capture")) {
        return;
      }

      const commandId = crypto.randomUUID();
      const commandPayload = { type: "webcam_capture" };

      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload,
        timeoutMs: 30000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/device/:pairCode/play_sound",
    requireDiscord,
    enforceWebCooldownForNewUsers,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const kind = String(req.body?.kind || "builtin").trim();
      const name = String(req.body?.name || "").trim();
      const url = String(req.body?.url || "").trim();

      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      if (denyIfDisabled(req, res, resolved.ownerUserId, "play_sound")) {
        return;
      }

      const commandPayload = validatePlaySoundRequest(req, res, {
        kind,
        name,
        url,
        invalidStatusCode: 200,
      });
      if (!commandPayload) return;

      const commandId = crypto.randomUUID();

      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload,
        timeoutMs: 20000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/device/:pairCode/play_sound_loop",
    requireDiscord,
    enforceWebCooldownForNewUsers,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const kind = String(req.body?.kind || "builtin").trim();
      const name = String(req.body?.name || "").trim();
      const url = String(req.body?.url || "").trim();

      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      if (denyIfDisabled(req, res, resolved.ownerUserId, "play_sound_loop")) return;
      if (
        kind === "url" &&
        denyIfDisabled(req, res, resolved.ownerUserId, "play_sound_loop_url")
      ) return;

      const commandPayload = validatePlaySoundLoopRequest(req, res, {
        kind,
        name,
        url,
        baseHz: req.body?.baseHz,
        beatHz: req.body?.beatHz,
        invalidStatusCode: 200,
      });
      if (!commandPayload) return;

      const commandId = crypto.randomUUID();
      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload,
        timeoutMs: 20000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/device/:pairCode/write_for_me",
    requireDiscord,
    async (req, res) => {
      const pairCode = String(req.params.pairCode || "").trim();
      const messageCheck = validateWriteForMeMessage(req.body?.message);
      const times = Number(req.body?.times || 1);

      if (!messageCheck.ok) {
        return res.status(400).send(messageCheck.message);
      }
      if (times < 1 || times > 500) {
        return res.status(400).send("Times must be between 1 and 500");
      }

      const resolved = resolveDeviceCommandTarget(req, res, pairCode);
      if (!resolved) return;
      const directContext = getDirectCommandContext(req, resolved);

      if (denyIfDisabled(req, res, resolved.ownerUserId, "write_for_me")) {
        return;
      }

      const message = messageCheck.value;
      const commandId = crypto.randomUUID();
      const commandPayload = { type: "write_for_me", message, times };

      const result = await sendCommandToResolvedTarget({
        resolved,
        requestId: commandId,
        actorUserId: directContext.actorUserId,
        commandPayload,
        timeoutMs: 20000,
        sourceKind: "direct",
        sourceId: pairCode,
        selfPreviewMode: directContext.selfPreviewMode,
        req,
      });

      return finalizeDeviceCommand(req, res, resolved, result, {
        pairCode,
        commandPayload,
        commandId,
      });
    },
  );

  app.post(
    "/api/group/:key/popup",
    requireDiscord,
    requireNotBanned,
    async (req, res) => {
      const groupKey = String(req.params.key || "").trim();
      if (!ensureActorCanUseGroup(req, res, groupKey)) return;
      if (!ensureGroupCommandEnabled(req, res, groupKey, "popup")) return;
      const message = String(req.body?.message || "").trim();
      if (!message) return res.status(400).send("Missing message");

      const actorId = getCommandActorUserId(req);
      logEvent({
        type: "group_command_popup",
        actorUserId: actorId,
        targetUserId: null,
        pairCode: null,
        req,
        payload: { groupKey, message },
      });

      const result = await sendToGroupAndWait({
        groupKey,
        cmdKey: "popup",
        commandPayload: { type: "popup", message },
        timeoutMs: 15000,
        actorUserId: actorId,
        req,
      });

      return finalizeGroupCommand(res, actorId, result);
    },
  );

  app.post(
    "/api/group/:key/open_url",
    requireDiscord,
    requireNotBanned,
    async (req, res) => {
      const groupKey = String(req.params.key || "").trim();
      if (!ensureActorCanUseGroup(req, res, groupKey)) return;
      if (!ensureGroupCommandEnabled(req, res, groupKey, "open_url")) return;
      const url = String(req.body?.url || "").trim();

      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).send("Invalid URL");
      }

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const actorId = getCommandActorUserId(req);
      logEvent({
        type: "group_command_open_url",
        actorUserId: actorId,
        targetUserId: null,
        req,
        payload: { groupKey, url },
      });

      const result = await sendToGroupAndWait({
        groupKey,
        cmdKey: "open_url",
        commandPayload: { type: "open_url", url },
        timeoutMs: 15000,
        actorUserId: actorId,
        req,
      });

      return finalizeGroupCommand(res, actorId, result);
    },
  );

  async function handleGroupSubliminalMessage(req, res) {
    const groupKey = String(req.params.key || "").trim();
    if (!ensureActorCanUseGroup(req, res, groupKey)) return;
    if (!ensureGroupCommandEnabled(req, res, groupKey, "subliminal_message")) {
      return;
    }
    const messagesCheck = validateSubliminalMessages(req.body?.messages);

    if (!messagesCheck.ok) {
      return res.status(400).send(messagesCheck.message);
    }

    const actorId = getCommandActorUserId(req);
    const messages = messagesCheck.value;
    logEvent({
      type: "group_command_subliminal_message",
      actorUserId: actorId,
      targetUserId: null,
      req,
      payload: {
        groupKey,
        messages,
        messageCount: messages.length,
      },
    });

    const result = await sendToGroupAndWait({
      groupKey,
      cmdKey: "subliminal_message",
      commandPayload: { type: "subliminal_message", messages },
      timeoutMs: 20000,
      actorUserId: actorId,
      req,
    });

    return finalizeGroupCommand(res, actorId, result);
  }

  app.post(
    "/api/group/:key/subliminal_message",
    requireDiscord,
    requireNotBanned,
    handleGroupSubliminalMessage,
  );

  app.post(
    "/api/group/:key/image_popup",
    requireDiscord,
    requireNotBanned,
    async (req, res) => {
      const groupKey = String(req.params.key || "").trim();
      if (!ensureActorCanUseGroup(req, res, groupKey)) return;
      if (!ensureGroupCommandEnabled(req, res, groupKey, "image_popup")) return;
      const url = String(req.body?.url || "").trim();

      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).send("Invalid URL");
      }

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const actorId = getCommandActorUserId(req);
      logEvent({
        type: "group_command_image_popup",
        actorUserId: actorId,
        targetUserId: null,
        req,
        payload: { groupKey, url },
      });

      const popupPayload = await buildResolvedPopupCommandPayload({
        commandType: "image_popup",
        url,
        actorUserId: actorId,
        req,
      });

      const result = await sendToGroupAndWait({
        groupKey,
        cmdKey: "image_popup",
        commandPayload: popupPayload.commandPayload,
        timeoutMs: 20000,
        actorUserId: actorId,
        req,
      });

      return finalizeGroupCommand(res, actorId, result);
    },
  );

  app.post(
    "/api/group/:key/fullscreen_popup",
    requireDiscord,
    requireNotBanned,
    async (req, res) => {
      const groupKey = String(req.params.key || "").trim();
      if (!ensureActorCanUseGroup(req, res, groupKey)) return;
      if (!ensureGroupCommandEnabled(req, res, groupKey, "fullscreen_popup")) {
        return;
      }
      const url = String(req.body?.url || "").trim();

      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).send("Invalid URL");
      }

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const actorId = getCommandActorUserId(req);
      logEvent({
        type: "group_command_fullscreen_popup",
        actorUserId: actorId,
        targetUserId: null,
        req,
        payload: { groupKey, url },
      });

      const popupPayload = await buildResolvedPopupCommandPayload({
        commandType: "fullscreen_popup",
        url,
        actorUserId: actorId,
        req,
      });

      const result = await sendToGroupAndWait({
        groupKey,
        cmdKey: "fullscreen_popup",
        commandPayload: popupPayload.commandPayload,
        timeoutMs: 20000,
        actorUserId: actorId,
        req,
      });

      return finalizeGroupCommand(res, actorId, result);
    },
  );

  app.post(
    "/api/group/:key/spiral_overlay",
    requireDiscord,
    requireNotBanned,
    async (req, res) => {
      const groupKey = String(req.params.key || "").trim();
      if (!ensureActorCanUseGroup(req, res, groupKey)) return;
      if (!ensureGroupCommandEnabled(req, res, groupKey, "spiral_overlay")) {
        return;
      }
      const url = String(req.body?.url || "").trim();

      if (!isSpiralOverlayUrl(url)) {
        return res.status(400).send("Invalid spiral overlay URL");
      }

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const actorId = getCommandActorUserId(req);
      logEvent({
        type: "group_command_spiral_overlay",
        actorUserId: actorId,
        targetUserId: null,
        req,
        payload: { groupKey, url },
      });

      const result = await sendToGroupAndWait({
        groupKey,
        cmdKey: "spiral_overlay",
        commandPayload: { type: "spiral_overlay", url },
        timeoutMs: 20000,
        actorUserId: actorId,
        req,
      });

      return finalizeGroupCommand(res, actorId, result);
    },
  );

  app.post(
    "/api/group/:key/set_wallpaper",
    requireDiscord,
    requireNotBanned,
    async (req, res) => {
      const groupKey = String(req.params.key || "").trim();
      if (!ensureActorCanUseGroup(req, res, groupKey)) return;
      if (!ensureGroupCommandEnabled(req, res, groupKey, "set_wallpaper")) {
        return;
      }
      const url = String(req.body?.url || "").trim();

      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).send("Invalid URL");
      }

      const allowWallpaperMedia = groupHasReportedCapabilityForActor(
        groupKey,
        getCommandActorUserId(req),
        "set_wallpaper_media",
      );
      if (!isAllowedWallpaperExt(url, { allowMedia: allowWallpaperMedia })) {
        return res.status(400).send("Invalid file type");
      }

      const policy = enforceManagedUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      const actorId = getCommandActorUserId(req);
      logEvent({
        type: "group_command_set_wallpaper",
        actorUserId: actorId,
        targetUserId: null,
        req,
        payload: { groupKey, url },
      });

      const result = await sendToGroupAndWait({
        groupKey,
        cmdKey: "set_wallpaper",
        commandPayload: { type: "set_wallpaper", url },
        timeoutMs: 20000,
        actorUserId: actorId,
        req,
      });

      return finalizeGroupCommand(res, actorId, result);
    },
  );

  app.post(
    "/api/group/:key/play_sound",
    requireDiscord,
    requireNotBanned,
    enforceWebCooldownForNewUsers,
    async (req, res) => {
      const groupKey = String(req.params.key || "").trim();
      if (!ensureActorCanUseGroup(req, res, groupKey)) return;
      if (!ensureGroupCommandEnabled(req, res, groupKey, "play_sound")) return;
      const kind = String(req.body?.kind || "builtin").trim();
      const name = String(req.body?.name || "").trim();
      const url = String(req.body?.url || "").trim();

      const commandPayload = validatePlaySoundRequest(req, res, {
        kind,
        name,
        url,
        invalidStatusCode: 400,
      });
      if (!commandPayload) return;

      const actorId = getCommandActorUserId(req);
      logEvent({
        type: "group_command_play_sound",
        actorUserId: actorId,
        targetUserId: null,
        req,
        payload: {
          groupKey,
          kind,
          name: kind === "builtin" ? name : null,
          url: kind === "url" ? String(url).slice(0, 800) : null,
        },
      });

      const result = await sendToGroupAndWait({
        groupKey,
        cmdKey: "play_sound",
        commandPayload,
        timeoutMs: 20000,
        actorUserId: actorId,
        req,
      });

      return finalizeGroupCommand(res, actorId, result);
    },
  );

  app.post(
    "/api/group/:key/write_for_me",
    requireDiscord,
    requireNotBanned,
    async (req, res) => {
      const groupKey = String(req.params.key || "").trim();
      if (!ensureActorCanUseGroup(req, res, groupKey)) return;
      if (!ensureGroupCommandEnabled(req, res, groupKey, "write_for_me")) {
        return;
      }
      const messageCheck = validateWriteForMeMessage(req.body?.message);
      const times = Number(req.body?.times || 1);

      if (!messageCheck.ok) {
        return res.status(400).send(messageCheck.message);
      }
      if (times < 1 || times > 500) {
        return res.status(400).send("Times must be between 1 and 500");
      }

      const actorId = getCommandActorUserId(req);
      const message = messageCheck.value;
      logEvent({
        type: "group_command_write_for_me",
        actorUserId: actorId,
        targetUserId: null,
        req,
        payload: { groupKey, message, times },
      });

      const result = await sendToGroupAndWait({
        groupKey,
        cmdKey: "write_for_me",
        commandPayload: { type: "write_for_me", message, times },
        timeoutMs: 20000,
        actorUserId: actorId,
        req,
      });

      return finalizeGroupCommand(res, actorId, result);
    },
  );
}

module.exports = { registerCommandRoutes };
