const WebSocket = require("ws");

function createRealtimeService({
  db,
  hmac,
  handleIncomingAck,
  saveResponseFromAck,
  handleDeviceConnected = null,
  handleOwnerActivity = null,
}) {
const wsByDeviceId = new Map();

const HEARTBEAT_INTERVAL_MS = 15_000;

function isDeviceOnline(deviceId) {
  const ws = wsByDeviceId.get(deviceId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  const last = Number(ws.lastPongAt || 0);
  const ttl = HEARTBEAT_INTERVAL_MS * 2 + 2000;
  return last && (Date.now() - last) <= ttl;
}

const capsByDeviceId = new Map();
const lastCapsByUserId = new Map();

const KNOWN_COMMANDS = new Set([
  "popup",
  "subliminal_message",
  "open_url",
  "image_popup",
  "fullscreen_popup",
  "spiral_overlay",
  "set_wallpaper",
  "set_wallpaper_media",
  "screenshot",
  "webcam_capture",
  "play_sound",
  "play_sound_url",
  "play_sound_loop",
  "play_sound_loop_url",
  "write_for_me",
]);

function normalizeEnabledCommands(arr) {
  const out = new Set();
  if (!Array.isArray(arr)) return out;
  for (const x of arr) {
    const k = String(x || "").trim();
    if (KNOWN_COMMANDS.has(k)) out.add(k);
  }
  return out;
}

function serializeEnabledCommands(enabled) {
  const list = Array.from(
    enabled instanceof Set ? enabled : normalizeEnabledCommands(enabled),
  ).sort();
  return JSON.stringify(list);
}

function parseEnabledCommandsJson(rawJson) {
  if (!rawJson) return new Set();
  try {
    return normalizeEnabledCommands(JSON.parse(String(rawJson)));
  } catch {
    return new Set();
  }
}

function loadLastReportedCapabilitiesForOwner(ownerUserId) {
  const ownerId = String(ownerUserId || "").trim();
  if (!ownerId) {
    return {
      enabled: new Set(),
      enabledForWhitelistedSenders: new Set(),
      updatedAt: 0,
    };
  }

  let rows = [];
  try {
    rows = db
      .prepare(
        `
        SELECT
          d.reported_capabilities_json,
          d.reported_capabilities_whitelisted_json,
          d.reported_capabilities_updated_at
        FROM device_pairs dp
        JOIN devices_v2 d ON d.device_id = dp.device_id
        WHERE dp.user_id=?
          AND d.reported_capabilities_json IS NOT NULL
          AND TRIM(d.reported_capabilities_json) != ''
      `,
      )
      .all(ownerId);
  } catch {
    rows = [];
  }

  const enabled = new Set();
  const enabledForWhitelistedSenders = new Set();
  let updatedAt = 0;

  for (const row of rows) {
    const rowEnabled = parseEnabledCommandsJson(row?.reported_capabilities_json);
    const rowEnabledForWhitelistedSenders =
      row?.reported_capabilities_whitelisted_json == null ||
      String(row?.reported_capabilities_whitelisted_json || "").trim() === ""
        ? new Set(rowEnabled)
        : parseEnabledCommandsJson(row?.reported_capabilities_whitelisted_json);
    for (const key of rowEnabled) enabled.add(key);
    for (const key of rowEnabledForWhitelistedSenders) {
      enabledForWhitelistedSenders.add(key);
    }
    updatedAt = Math.max(updatedAt, Number(row?.reported_capabilities_updated_at || 0));
  }

  if (enabled.size || enabledForWhitelistedSenders.size) {
    const entry = { enabled, enabledForWhitelistedSenders, updatedAt };
    lastCapsByUserId.set(ownerId, entry);
    return entry;
  }

  lastCapsByUserId.delete(ownerId);
  return {
    enabled: new Set(),
    enabledForWhitelistedSenders: new Set(),
    updatedAt: 0,
  };
}

function resolveOwnerUserIdByDeviceId(deviceId) {
  try {
    const row = db
      .prepare(
        `
          SELECT dp.user_id
          FROM device_pairs dp
          LEFT JOIN client_pairing_credentials c ON c.user_id=dp.user_id
          LEFT JOIN bans b ON b.discord_id = dp.user_id
          WHERE dp.device_id=?
            AND b.discord_id IS NULL
            AND (IFNULL(c.secret_required, 0)=0 OR dp.auth_level='verified')
        `,
      )
      .get(deviceId);
    return row ? String(row.user_id) : null;
  } catch {
    return null;
  }
}

function handleIncomingCapabilities(deviceId, msg) {
  if (!deviceId) return;
  if (!msg || msg.type !== "capabilities") return;

  const enabled = normalizeEnabledCommands(msg.enabledCommands);
  const hasWhitelistedSenderList = Object.prototype.hasOwnProperty.call(
    msg,
    "enabledCommandsForWhitelistedSenders",
  );
  const enabledForWhitelistedSenders = hasWhitelistedSenderList
    ? normalizeEnabledCommands(msg.enabledCommandsForWhitelistedSenders)
    : new Set(enabled);

  const ownerUserId = resolveOwnerUserIdByDeviceId(deviceId);
  if (!ownerUserId) return;

  const now = Date.now();
  capsByDeviceId.set(deviceId, {
    ownerUserId,
    enabled,
    enabledForWhitelistedSenders,
    updatedAt: now,
  });
  try {
    db.prepare(
      `
      UPDATE devices_v2
      SET reported_capabilities_json=?,
          reported_capabilities_whitelisted_json=?,
          reported_capabilities_updated_at=?
      WHERE device_id=?
    `,
    ).run(
      serializeEnabledCommands(enabled),
      serializeEnabledCommands(enabledForWhitelistedSenders),
      now,
      deviceId,
    );
  } catch {}

  loadLastReportedCapabilitiesForOwner(ownerUserId);
}

function getOnlineDeviceIdsForOwner(ownerUserId) {
  if (!ownerUserId) return [];
  try {
    const rows = db
      .prepare(`SELECT device_id FROM device_pairs WHERE user_id=?`)
      .all(ownerUserId);
    const ids = rows.map(r => r.device_id);
    return ids.filter(did => isDeviceOnline(did));
  } catch {
    return [];
  }
}

function getUnionCapabilitySetsForOwnerOnline(ownerUserId) {
  const onlineIds = getOnlineDeviceIdsForOwner(ownerUserId);

  let hasAnyReportingOnline = false;
  const union = new Set();
  const unionForWhitelistedSenders = new Set();

  for (const did of onlineIds) {
    const entry = capsByDeviceId.get(did);
    if (!entry || !entry.enabled) continue;

    hasAnyReportingOnline = true;
    for (const k of entry.enabled) {
      union.add(k);
    }
    const entryWhitelisted =
      entry.enabledForWhitelistedSenders instanceof Set
        ? entry.enabledForWhitelistedSenders
        : entry.enabled;
    for (const k of entryWhitelisted) {
      unionForWhitelistedSenders.add(k);
    }
  }

  return {
    enabled: union,
    enabledForWhitelistedSenders: unionForWhitelistedSenders,
    hasAnyReportingOnline,
  };
}

function getUnionCapsForOwnerOnline(ownerUserId) {
  const { enabled, hasAnyReportingOnline } =
    getUnionCapabilitySetsForOwnerOnline(ownerUserId);
  return { enabled, hasAnyReportingOnline };
}

function getUnionCapsForWhitelistedSendersOnline(ownerUserId) {
  const { enabledForWhitelistedSenders, hasAnyReportingOnline } =
    getUnionCapabilitySetsForOwnerOnline(ownerUserId);
  return {
    enabled: enabledForWhitelistedSenders,
    hasAnyReportingOnline,
  };
}

function getReportedCapabilitiesForOwner(ownerUserId) {
  const { enabled, hasAnyReportingOnline } = getUnionCapsForOwnerOnline(ownerUserId);
  if (hasAnyReportingOnline) return enabled;

  return loadLastReportedCapabilitiesForOwner(ownerUserId).enabled;
}

function getReportedCapabilitiesForWhitelistedSenders(ownerUserId) {
  const { enabled, hasAnyReportingOnline } =
    getUnionCapsForWhitelistedSendersOnline(ownerUserId);
  if (hasAnyReportingOnline) return enabled;

  return loadLastReportedCapabilitiesForOwner(ownerUserId)
    .enabledForWhitelistedSenders;
}

function getLastReportedCapabilitiesForOwner(ownerUserId) {
  return loadLastReportedCapabilitiesForOwner(ownerUserId).enabled;
}

function getLastReportedCapabilitiesForWhitelistedSenders(ownerUserId) {
  return loadLastReportedCapabilitiesForOwner(ownerUserId)
    .enabledForWhitelistedSenders;
}

function ownerHasReportedCapability(ownerUserId, capability) {
  const cap = String(capability || "").trim();
  if (!ownerUserId || !cap) return false;
  return getReportedCapabilitiesForOwner(ownerUserId).has(cap);
}

function ownerHasReportedCapabilityForWhitelistedSenders(
  ownerUserId,
  capability,
) {
  const cap = String(capability || "").trim();
  if (!ownerUserId || !cap) return false;
  return getReportedCapabilitiesForWhitelistedSenders(ownerUserId).has(cap);
}

function groupHasReportedCapability(groupKey, capability) {
  const key = String(groupKey || "").trim();
  const cap = String(capability || "").trim();
  if (!key || !cap) return false;

  const rows = db
    .prepare(`SELECT user_id FROM group_memberships WHERE group_key=?`)
    .all(key);

  for (const row of rows) {
    if (ownerHasReportedCapability(String(row.user_id || ""), cap)) {
      return true;
    }
  }

  return false;
}

  function registerRealtimeServer(server) {
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  let deviceId = null;
  let ownerUserId = null;

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    deviceId = url.searchParams.get("deviceId") || "";
    const deviceToken = url.searchParams.get("deviceToken") || "";

    if (!deviceId || !deviceToken) {
      ws.close(1008, "Missing auth");
      return;
    }

    const row = db
      .prepare("SELECT device_token_hash FROM devices_v2 WHERE device_id=?")
      .get(deviceId);
    if (!row) {
      ws.close(1008, "Unknown device");
      return;
    }

    if (hmac(deviceToken) !== row.device_token_hash) {
      ws.close(1008, "Invalid token");
      return;
    }

    ownerUserId = resolveOwnerUserIdByDeviceId(deviceId);
    if (!ownerUserId) {
      ws.close(1008, "Access denied");
      return;
    }

    ws.isAlive = true;
    ws.lastPongAt = Date.now();

    ws.on("pong", () => {
      const now = Date.now();
      const resolvedOwnerUserId = resolveOwnerUserIdByDeviceId(deviceId);
      if (!resolvedOwnerUserId) {
        try {
          ws.close(1008, "Access denied");
        } catch {}
        return;
      }

      ownerUserId = resolvedOwnerUserId;
      ws.isAlive = true;
      ws.lastPongAt = now;
      try {
        db.prepare(
          "UPDATE devices_v2 SET last_seen_at=? WHERE device_id=?",
        ).run(now, deviceId);
      } catch {}
      if (ownerUserId && typeof handleOwnerActivity === "function") {
        try {
          handleOwnerActivity({ ownerUserId, deviceId, at: now, cause: "pong" });
        } catch {}
      }
    });

    wsByDeviceId.set(deviceId, ws);
    ws.lastPongAt = Date.now();
    db.prepare("UPDATE devices_v2 SET last_seen_at=? WHERE device_id=?").run(
      ws.lastPongAt,
      deviceId,
    );
    if (ownerUserId && typeof handleOwnerActivity === "function") {
      try {
        handleOwnerActivity({
          ownerUserId,
          deviceId,
          at: ws.lastPongAt,
          cause: "connect",
        });
      } catch {}
    }

    const pairingRow = db
      .prepare(`SELECT auth_level FROM device_pairs WHERE device_id=?`)
      .get(deviceId);
    const verified = String(pairingRow?.auth_level || "legacy") === "verified";
    ws.send(JSON.stringify({
      type: "hello",
      deviceId,
      authLevel: verified ? "verified" : "legacy",
      commandHistoryAccess: verified,
    }));
    if (ownerUserId && typeof handleDeviceConnected === "function") {
      try {
        handleDeviceConnected({ ownerUserId, deviceId, at: ws.lastPongAt });
      } catch {}
    }

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      console.log("[ws] from", deviceId, "type=", msg?.type, "keys=", Object.keys(msg || {}));

      handleIncomingAck(msg);
      handleIncomingCapabilities(deviceId, msg);

      if (msg && msg.type === "ack") {
        try {
          const hasB64 = !!(msg.details && msg.details.webp_b64);
          const success =
            msg.ok === true ||
            msg.status === "ok" ||
            msg.status === "shown" ||
            msg.status === "opened";

          if (success && hasB64) {
            const row = db.prepare(`
              SELECT user_id
              FROM device_pairs
              WHERE device_id=?
            `).get(deviceId);

            if (row?.user_id) {
              const saved = saveResponseFromAck({
                ownerUserId: String(row.user_id),
                deviceId,
                ack: msg,
              });

              if (!saved) {
                console.log("[responses] ack had image but was not saved", {
                  kind: msg.details?.kind,
                  mime: msg.details?.mime,
                });
              }
            }
          } else {
            console.log("[responses] ack not saved", {
              ok: msg.ok,
              status: msg.status,
              hasWebpB64: hasB64,
            });
          }
        } catch (e) {
          console.warn("[responses] failed to record response from ack", e);
        }
        return;
      }
    });

    ws.on("close", () => {
      if (deviceId && wsByDeviceId.get(deviceId) === ws) wsByDeviceId.delete(deviceId);
      if (deviceId) capsByDeviceId.delete(deviceId);
    });
  } catch (e) {
    try {
      ws.close();
    } catch {}
  }
});

const hbTimer = setInterval(() => {
  for (const [deviceId, ws] of wsByDeviceId.entries()) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      wsByDeviceId.delete(deviceId);
      continue;
    }

    if (!resolveOwnerUserIdByDeviceId(deviceId)) {
      try {
        ws.close(1008, "Access denied");
      } catch {
        try {
          ws.terminate();
        } catch {}
      }
      wsByDeviceId.delete(deviceId);
      continue;
    }

    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      wsByDeviceId.delete(deviceId);
      continue;
    }

    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      try {
        ws.terminate();
      } catch {}
      wsByDeviceId.delete(deviceId);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

hbTimer.unref?.();

    return { wss, hbTimer };
  }

  return {
    groupHasReportedCapability,
    getLastReportedCapabilitiesForOwner,
    getLastReportedCapabilitiesForWhitelistedSenders,
    isDeviceOnline,
    lastCapsByUserId,
    ownerHasReportedCapability,
    ownerHasReportedCapabilityForWhitelistedSenders,
    registerRealtimeServer,
    resolveOwnerUserIdByDeviceId,
    getReportedCapabilitiesForOwner,
    getReportedCapabilitiesForWhitelistedSenders,
    getUnionCapsForOwnerOnline,
    getUnionCapsForWhitelistedSendersOnline,
    wsByDeviceId,
  };
}

module.exports = { createRealtimeService };
