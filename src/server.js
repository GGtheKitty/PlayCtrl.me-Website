const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const cors = require("cors");
const ENV = require("dotenv").config();
const cookieParser = require("cookie-parser");
const { renderWithLayout } = require("./views/render");

const PORT = process.env.PORT || 8080;

const PEPPER = process.env.PEPPER || "pepper_change_me";

const CATALOG_PRUNE = process.env.CATALOG_PRUNE;

const LISTS = {
  favorites: {
    key: "favorites",
    label: process.env.LIST_FAVORITES_LABEL || "Favorites",
    accent: "purple",
  },
  dislikes: {
    key: "dislikes",
    label: process.env.LIST_DISLIKES_LABEL || "Dislikes",
    accent: "danger",
  },
};

const CATALOG = process.env.LIST_CATALOG || "";

const DISCORD_AUTH = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
const DISCORD_ME = "https://discord.com/api/users/@me";

function b64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function hmac(s) {
  return crypto.createHmac("sha256", PEPPER).update(s).digest("hex");
}
function randBase32(len) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}
function inviteHash(code) {
  return hmac("invite:" + String(code));
}

function genInviteCode() {
  return randBase32(12);
}

function gen6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function genApiKey() {
  return "pc_" + crypto.randomBytes(32).toString("base64url");
}
function hashApiKey(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function ensureUserApiKeyExists(userId) {
  const row = db
    .prepare(`SELECT key_hash FROM api_keys WHERE user_id=?`)
    .get(userId);
  if (row) return;

  const raw = genApiKey();
  const key_hash = hashApiKey(raw);
  const now = Date.now();

  db.prepare(
    `
    INSERT INTO api_keys (user_id, key_hash, created_at, last_reset_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(userId, key_hash, now, now);
}

function getApiKeyMeta(userId) {
  return (
    db
      .prepare(
        `
    SELECT created_at, last_reset_at
    FROM api_keys
    WHERE user_id=?
  `,
      )
      .get(userId) || null
  );
}

const DISCORD_EPOCH_MS = 1420070400000n;

function discordSnowflakeToMs(id) {
  try {
    const snowflake = BigInt(String(id));
    const timestamp = (snowflake >> 22n) + DISCORD_EPOCH_MS;
    return Number(timestamp);
  } catch {
    return null;
  }
}

function discordAccountAgeDays(discordId) {
  const createdMs = discordSnowflakeToMs(discordId);
  if (!createdMs) return null;
  const ageMs = Date.now() - createdMs;
  return ageMs / (1000 * 60 * 60 * 24);
}

function banDiscordIdSystem(targetId, req, payload = {}) {
  const reason = null;

  db.prepare(
    `
    INSERT INTO bans (discord_id, reason, banned_by, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      reason=excluded.reason,
      banned_by=excluded.banned_by,
      created_at=excluded.created_at
  `,
  ).run(targetId, reason, "system", Date.now());

  try {
    logEvent({
      type: "user_banned",
      actorUserId: "system",
      targetUserId: targetId,
      req,
      payload,
    });
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function parseIntSafe(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}

function isAllowedWallpaperExt(url) {
  const clean = String(url).split("#")[0].split("?")[0].toLowerCase();
  return (
    clean.endsWith(".png") || clean.endsWith(".jpg") || clean.endsWith(".jpeg")
  );
}

function incrementCommandsSentTotal({ senderDiscordId, targetOwnerDiscordId }) {
  if (!senderDiscordId) return;
  if (!targetOwnerDiscordId) return;

  if (String(senderDiscordId) === String(targetOwnerDiscordId)) return;

  db.prepare(
    `
    UPDATE users
    SET commands_sent_total = commands_sent_total + 1
    WHERE discord_id = ?
  `,
  ).run(senderDiscordId);
}

async function verifyWallpaperUrl(url) {
  const resp = await fetch(url, { method: "HEAD", redirect: "follow" });

  if (!resp.ok) throw new Error(`URL check failed (HTTP ${resp.status})`);

  const ct = String(resp.headers.get("content-type") || "").toLowerCase();
  const okType = ct.startsWith("image/png") || ct.startsWith("image/jpeg");
  if (!okType)
    throw new Error(`Not a PNG/JPEG (content-type=${ct || "unknown"})`);

  const len = Number(resp.headers.get("content-length") || "0");
  const MAX = 10 * 1024 * 1024;
  if (len && len > MAX)
    throw new Error(
      `Image too large (${Math.round(len / 1024 / 1024)}MB > 10MB)`,
    );

  return true;
}

function getSetting(key, fallback = null) {
  const row = db
    .prepare(`SELECT value FROM site_settings WHERE key=?`)
    .get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `
    INSERT INTO site_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `,
  ).run(key, String(value));
}

function isEnrolledUser(user) {
  return !!user?.enrolled_at;
}

function markUserEnrolled(discordId) {
  db.prepare(`UPDATE users SET enrolled_at=? WHERE discord_id=?`).run(
    Date.now(),
    discordId,
  );
}

function isEnrollmentOpen() {
  return getSetting("enrollment_open", "0") === "1";
}

function ensurePairCode(userId) {
  const row = db
    .prepare("SELECT code_plain FROM pair_codes WHERE user_id=?")
    .get(userId);
  if (row?.code_plain) return row.code_plain;

  const code = gen6();
  db.prepare(
    `
    INSERT INTO pair_codes (user_id, code_hash, code_plain, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      code_hash=excluded.code_hash,
      code_plain=excluded.code_plain,
      updated_at=excluded.updated_at
  `,
  ).run(userId, hmac(code), code, Date.now());

  return code;
}

const pendingAcks = new Map();

function waitForAcks(commandId, expected, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const entry = {
      expected: Math.max(0, Number(expected) || 0),
      results: [],
      resolve,
      timer: null,
    };

    if (entry.expected <= 0) return resolve([]);

    entry.timer = setTimeout(() => {
      pendingAcks.delete(commandId);
      resolve(entry.results);
    }, timeoutMs);

    pendingAcks.set(commandId, entry);
  });
}

function handleIncomingAck(msg) {
  if (!msg || msg.type !== "ack" || !msg.commandId) return;

  const entry = pendingAcks.get(msg.commandId);
  if (!entry) return;

  entry.results.push(msg);

  if (entry.results.length >= entry.expected) {
    pendingAcks.delete(msg.commandId);
    try {
      if (entry.timer) clearTimeout(entry.timer);
    } catch {}
    entry.resolve(entry.results);
  }
}

function sendToPairedDevices(deviceIds, msgObj) {
  let sentTo = 0;
  for (const deviceId of deviceIds) {
    const ws = wsByDeviceId.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msgObj));
        sentTo++;
      } catch {}
    }
  }
  return sentTo;
}

async function sendToAllAndWait(commandId, deviceIds, commandPayload, timeoutMs = 15000) {
  const ids = Array.isArray(deviceIds) ? deviceIds : [];
  const online = ids.filter((did) => isDeviceOnline(did));

  if (!online.length) {
    return { ok: false, error: "No devices online", sent: 0, acks: [] };
  }

  const sent = sendToPairedDevices(online, {
    type: "command",
    commandId,
    command: commandPayload,
  });

  if (sent <= 0) {
    return { ok: false, error: "No devices online", sent: 0, acks: [] };
  }

  const acks = await waitForAcks(commandId, sent, timeoutMs);
  return { ok: true, commandId, sent, acks };
}

function renderAcks(acks) {
  if (!acks || !acks.length) return "No response from devices";

  return acks
    .map((a) => {
      if (a && a.ok) return "OK";

      if (a && a.status === "rejected") {
        const code = a.code || "unknown";
        const msg = a.message ? ` — ${String(a.message)}` : "";
        return `Rejected: ${code}${msg}`;
      }

      const code = (a && (a.code || a.message)) || "unknown";
      return `Failed: ${code}`;
    })
    .join("<br>");
}

function mb(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x) || x <= 0) return null;
  return (x / 1024 / 1024).toFixed(1);
}

function formatAckForHttp(ack) {
  const ok = !!ack?.ok;
  if (ok) return { ok: true, ack };

  const clientCode = String(ack?.code || "unknown");
  let message = String(ack?.message || "Command rejected by client.");
  const details = ack?.details;

  if (clientCode === "file_too_large" && details && (details.sizeBytes || details.maxBytes)) {
    const s = mb(details.sizeBytes);
    const m = mb(details.maxBytes);
    if (s && m) message = `${message} (${s}MB > ${m}MB)`;
  }

  return {
    ok: false,
    code: "CLIENT_REJECTED",
    client_code: clientCode,
    message,
    details: details || null,
    ack
  };
}

async function sendCommandToOneOnlineAndWaitAck({ resolved, commandId, commandObj, timeoutMs = 20000 }) {
  const deviceIds = resolved.deviceIds || [];
  const targetDeviceId = deviceIds.find(did => isDeviceOnline(did));
  if (!targetDeviceId) {
    return { ok: false, httpStatus: 409, code: "DEVICE_OFFLINE", message: "No paired devices online." };
  }

  const sent = sendToPairedDevices([targetDeviceId], {
    type: "command",
    commandId,
    command: commandObj
  });

  if (sent <= 0) {
    return { ok: false, httpStatus: 409, code: "DEVICE_OFFLINE", message: "Target device not online." };
  }

  const ack = await waitForAck(commandId, targetDeviceId, timeoutMs);
  if (ack?.ok) {
    return { ok: true, httpStatus: 200, targetDeviceId, ack };
  }

  const formatted = formatAckForHttp(ack);
  return { ok: false, httpStatus: 422, targetDeviceId, ...formatted };
}

function enforceWebCooldownForNewUsers(req, res, next) {
  try {
    const senderId = req.user?.discord_id;
    if (!senderId) return next();

    const row = db
      .prepare(`SELECT commands_sent_total FROM users WHERE discord_id=?`)
      .get(senderId);
    const total = Number(row?.commands_sent_total || 0);
    if (total >= 100) return next();

    const now = Date.now();
    const cd = db
      .prepare(
        `SELECT next_allowed_at_ms FROM web_cmd_cooldowns WHERE user_id=?`,
      )
      .get(senderId);
    const nextAllowed = Number(cd?.next_allowed_at_ms || 0);

    if (now < nextAllowed) {
      const retry = Math.max(0, nextAllowed - now);
      return res.status(429).json({
        ok: false,
        code: "WEB_COOLDOWN",
        retry_after_ms: retry,
      });
    }

    const nextAt = now + 3000;
    db.prepare(
      `
      INSERT INTO web_cmd_cooldowns (user_id, next_allowed_at_ms)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET next_allowed_at_ms=excluded.next_allowed_at_ms
    `,
    ).run(senderId, nextAt);

    next();
  } catch (e) {
    next();
  }
}

const fs = require("fs");

const URL_DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(URL_DATA_DIR)) fs.mkdirSync(URL_DATA_DIR);

const ALLOWLIST_PATH = path.join(URL_DATA_DIR, "url_allowlist.txt");
const BLOCKLIST_PATH = path.join(URL_DATA_DIR, "url_blocklist.txt");

function ensureListFilesExist() {
  fs.mkdirSync(path.dirname(ALLOWLIST_PATH), { recursive: true });
  if (!fs.existsSync(ALLOWLIST_PATH))
    fs.writeFileSync(ALLOWLIST_PATH, "", "utf8");
  if (!fs.existsSync(BLOCKLIST_PATH))
    fs.writeFileSync(BLOCKLIST_PATH, "", "utf8");
}

function parseHostLine(line) {
  const s = String(line || "").trim();
  if (!s || s.startsWith("#")) return null;

  try {
    if (s.includes("://")) {
      const u = new URL(s);
      return normalizeHost(u.host);
    }
  } catch {}
  return normalizeHost(s);
}

function normalizeHost(host) {
  const h = String(host || "")
    .trim()
    .toLowerCase();

  return h.replace(/\/+$/, "");
}

let cacheAllow = { mtimeMs: 0, set: new Set() };
let cacheBlock = { mtimeMs: 0, set: new Set() };

function loadHostSetCached(filePath, cacheObj) {
  ensureListFilesExist();
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    st = null;
  }
  const mtimeMs = st ? st.mtimeMs : 0;

  if (mtimeMs && mtimeMs === cacheObj.mtimeMs && cacheObj.set.size) {
    return cacheObj.set;
  }

  let txt = "";
  try {
    txt = fs.readFileSync(filePath, "utf8");
  } catch {}

  const set = new Set();
  for (const line of txt.split(/\r?\n/)) {
    const host = parseHostLine(line);
    if (host) set.add(host);
  }

  cacheObj.mtimeMs = mtimeMs;
  cacheObj.set = set;
  return set;
}

function getAllowSet() {
  return loadHostSetCached(ALLOWLIST_PATH, cacheAllow);
}
function getBlockSet() {
  return loadHostSetCached(BLOCKLIST_PATH, cacheBlock);
}

function extractHostFromUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return null;

  let u;
  try {
    u = new URL(s);
  } catch {
    try {
      u = new URL("https://" + s);
    } catch {
      return null;
    }
  }

  const proto = (u.protocol || "").toLowerCase();
  if (proto !== "http:" && proto !== "https:") return null;

  return normalizeHost(u.host);
}

function upsertVerificationHost(db, host, sampleUrl) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO url_verification_queue (host, sample_url, first_seen_at, last_seen_at, seen_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(host) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,
      sample_url=excluded.sample_url,
      seen_count=seen_count + 1
  `,
  ).run(host, String(sampleUrl || "").slice(0, 800), now, now);
}

function banUserSilently(db, logEvent, discordId, req) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO bans (discord_id, reason, banned_by, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      reason=excluded.reason,
      banned_by=excluded.banned_by,
      created_at=excluded.created_at
  `,
  ).run(discordId, null, "system", now);

  logEvent({
    type: "user_banned",
    actorUserId: "system",
    targetUserId: discordId,
    req,
    payload: { reason: null, auto: true },
  });
}

function enforceUrlPolicy({ db, logEvent }, req, res, rawUrl) {
  const host = extractHostFromUrl(rawUrl);

  if (!host) {
    res.status(400).json({ ok: false, message: "Invalid URL." });
    return { ok: false, blocked: true };
  }

  const allow = getAllowSet();
  const block = getBlockSet();

  if (block.has(host)) {
    banUserSilently(db, logEvent, req.user.discord_id, req);

    res.status(403).json({ ok: false, message: "Not allowed." });
    return { ok: false, blocked: true };
  }

  if (allow.has(host)) {
    return { ok: true, host, status: "allowed" };
  }

  upsertVerificationHost(db, host, rawUrl);
  return { ok: true, host, status: "queued" };
}

function appendHostToFile(filePath, host) {
  ensureListFilesExist();
  const h = normalizeHost(host);
  if (!h) return;

  const txt = fs.readFileSync(filePath, "utf8");
  const lines = txt
    .split(/\r?\n/)
    .map((l) => parseHostLine(l))
    .filter(Boolean);
  const set = new Set(lines);

  if (!set.has(h)) {
    fs.appendFileSync(
      filePath,
      (txt.endsWith("\n") || txt.length === 0 ? "" : "\n") + h + "\n",
      "utf8",
    );
  }
}

function removeHostFromFile(filePath, host) {
  ensureListFilesExist();
  const h = normalizeHost(host);
  const txt = fs.readFileSync(filePath, "utf8");
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const parsed = parseHostLine(line);
    if (!parsed) {
      out.push(line);
      continue;
    }
    if (parsed === h) continue;
    out.push(parsed);
  }
  fs.writeFileSync(
    filePath,
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n",
    "utf8",
  );
}

module.exports = {
  ALLOWLIST_PATH,
  BLOCKLIST_PATH,
  getAllowSet,
  getBlockSet,
  extractHostFromUrl,
  enforceUrlPolicy,
  appendHostToFile,
  removeHostFromFile,
  discordAvatarUrl,
};

const db = require("./db");
const { resourceLimits } = require("worker_threads");

db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    user_id TEXT NOT NULL,               -- the logged in user
    favorite_user_id TEXT NOT NULL,       -- the person they favorited
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (user_id, favorite_user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_favorites_user_created
  ON favorites(user_id, created_at);
`);

function tableExists(name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

function getBoardMessages(ownerUserId, limit = 10) {
  return db
    .prepare(
      `
    SELECT id, body, created_at
    FROM device_message_board
    WHERE owner_user_id=?
    ORDER BY created_at DESC
    LIMIT ?
  `,
    )
    .all(ownerUserId, limit);
}

const postBoardMessageTx = db.transaction((ownerUserId, body) => {
  const now = Date.now();

  db.prepare(
    `
    INSERT INTO device_message_board (owner_user_id, body, created_at)
    VALUES (?, ?, ?)
  `,
  ).run(ownerUserId, body, now);

  db.prepare(
    `
    DELETE FROM device_message_board
    WHERE owner_user_id=?
      AND id NOT IN (
        SELECT id
        FROM device_message_board
        WHERE owner_user_id=?
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      )
  `,
  ).run(ownerUserId, ownerUserId);

  return now;
});

function bootstrapAdminsFromEnv() {
  const raw = String(process.env.BOOTSTRAP_ADMINS || "").trim();
  if (!raw) return;

  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const now = Date.now();

  const upsert = db.prepare(`
    INSERT INTO admins (discord_id, created_at, is_bootstrap)
    VALUES (?, ?, 1)
    ON CONFLICT(discord_id) DO UPDATE SET
      is_bootstrap=1
  `);

  const tx = db.transaction(() => {
    for (const id of ids) upsert.run(id, now);
  });
  tx();

  console.log("[admin] bootstrapped:", ids);
}
bootstrapAdminsFromEnv();

function wantsJson(req) {
  const accept = String(req.headers["accept"] || "");
  const xr = String(req.headers["x-requested-with"] || "");
  return (
    accept.includes("application/json") || xr.toLowerCase() === "xmlhttprequest"
  );
}

function isInvitedUser(u) {
  return !!(u && u.invited_at);
}

function loginRequiredPage(req, res, opts = {}) {
  const title = opts.title || "Login required";
  const nextUrl = opts.nextUrl || req.originalUrl || "/";
  const ogUrl = `https://playctrl.me${nextUrl}`;

  /*return res
    .status(200)
    .type("html")
    .send(
      layout({
        title,
        user: req.viewUser,
        isAdmin: req.viewIsAdmin,
        meta: {
          ogTitle: opts.ogTitle || "PlayCtrl.me",
          ogDesc: opts.ogDesc || "Login required to view this page.",
          ogUrl,
          ogImage: opts.ogImage || "https://playctrl.me/og.png",
        },
        body: `
      <div class="card">
        <div class="cardHd">${escapeHtml(title)}</div>
        <div class="cardBd">
          <p class="muted">${escapeHtml(opts.message || "You must login to access this page.")}</p>

          <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">
            <a class="btnLink" href="/auth/discord?next=${encodeURIComponent(nextUrl)}">Login with Discord</a>
            <a class="btnLink" href="/">Home</a>
          </div>
        </div>
      </div>
    `,
      }),
    );*/

  return res.status(403).type("html").send(`
    <h1>Access denied</h1>
    <p>You must login to access this page.</p>
  `);
}

function inviteGate(req, res, next) {
  const path = req.path || req.url || "";

  if (
    path === "/" ||
    path === "/api/pair" ||
    path.startsWith("/auth/discord") ||
    path === "/invite/redeem" ||
    path === "/invite" ||
    path.startsWith("/upd/") ||
    path.startsWith("/invite/") ||
    path.startsWith("/public/") ||
    path === "/logout" ||
    path.startsWith("/assets/") ||
    path.startsWith("/api/")
  ) {
    return next();
  }

  if (!req.viewUser) {
    const shareable =
      path.startsWith("/device/") ||
      path === "/discover" ||
      path === "/profile";

    if (req.method === "GET" && shareable) {
      return loginRequiredPage(req, res, {
        title: "Login required",
        message: "Login to view this page.",
        ogTitle: "PlayCtrl.me",
        ogDesc: "Login required to view this PlayCtrl.me page.",
      });
    }

    return res.redirect("/auth/discord");
  }

  if (req.viewIsAdmin) return next();

  if (typeof isEnrollmentOpen === "function" && isEnrollmentOpen()) {
    if (!req.viewUser.enrolled_at) {
      try {
        markUserEnrolled(req.viewUser.discord_id);
        req.viewUser.enrolled_at = Date.now();
      } catch (e) {}
    }
    return next();
  }

  if (!isInvitedUser(req.viewUser) && !isEnrolledUser(req.viewUser)) {
    if (req.method === "GET") return res.redirect("/invite");
    return res.status(403).send("Invite required.");
  }

  next();
}

function isAdmin(discordId) {
  if (!discordId) return false;
  const row = db
    .prepare("SELECT discord_id FROM admins WHERE discord_id=?")
    .get(discordId);
  return !!row;
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect("/auth/discord");
  if (!isAdmin(req.user.discord_id))
    return res.status(403).type("html").send("Admins only.");
  next();
}

function isDiscordId(s) {
  return typeof s === "string" && /^\d{10,20}$/.test(s.trim());
}

function isWhitelistEnabled(ownerId) {
  const row = db
    .prepare(`SELECT whitelist_enabled FROM users WHERE discord_id=?`)
    .get(ownerId);
  return !!row?.whitelist_enabled;
}

function getWhitelist(ownerId) {
  return db
    .prepare(
      `
    SELECT w.allowed_id, u.username, u.global_name, u.avatar, w.created_at
    FROM user_whitelist w
    LEFT JOIN users u ON u.discord_id = w.allowed_id
    WHERE w.owner_id=?
    ORDER BY w.created_at DESC
  `,
    )
    .all(ownerId);
}

function isAllowedByWhitelist(ownerId, actorId) {
  if (!actorId) return false;

  if (ownerId === actorId) return true;

  if (isAdmin(actorId)) return true;

  if (!isWhitelistEnabled(ownerId)) return true;

  const row = db
    .prepare(
      `
    SELECT 1 FROM user_whitelist
    WHERE owner_id=? AND allowed_id=?
  `,
    )
    .get(ownerId, actorId);

  return !!row;
}

function logEvent({
  type,
  actorUserId = null,
  targetUserId = null,
  pairCode = null,
  deviceId = null,
  req = null,
  payload = {},
}) {
  db.prepare(
    `
    INSERT INTO events (
      id, created_at, type,
      actor_user_id, target_user_id,
      pair_code, device_id,
      ip, ua, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    crypto.randomUUID(),
    Date.now(),
    String(type),
    actorUserId,
    targetUserId,
    pairCode,
    deviceId,
    req ? req.headers["x-forwarded-for"] || req.ip || null : null,
    req ? req.headers["user-agent"] || null : null,
    JSON.stringify(payload ?? {}),
  );
}

function discordAvatarUrl(u, size = 64) {
  if (u && u.avatar) {
    return `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png?size=${size}`;
  }

  return "https://cdn.discordapp.com/embed/avatars/0.png";
}

function getLoggedInUser(req) {
  const sid = req.cookies?.sid;
  if (!sid) return null;

  return (
    db
      .prepare(
        `
    SELECT
      u.discord_id,
      u.username,
      u.global_name,
      u.avatar,

      IFNULL(u.discoverable, 0)        AS discoverable,
      IFNULL(u.whitelist_enabled, 0)   AS whitelist_enabled,

      u.invited_at,
      u.enrolled_at,

      s.created_at AS session_created_at
    FROM sessions s
    JOIN users u ON u.discord_id = s.discord_id
    WHERE s.session_id = ?
  `,
      )
      .get(sid) || null
  );
}

function getCommandPrefsForUser(discordId) {
  try {
    return (
      db
        .prepare(
          `
      SELECT allow_toast, allow_popup, allow_open_url, allow_image_popup, allow_set_wallpaper
      FROM users WHERE discord_id=?
    `,
        )
        .get(discordId) || {
        allow_toast: 1,
        allow_popup: 1,
        allow_open_url: 1,
        allow_image_popup: 1,
      }
    );
  } catch {
    return {
      allow_toast: 1,
      allow_popup: 1,
      allow_open_url: 1,
      allow_image_popup: 1,
    };
  }
}

function isCommandEnabled(prefs, cmd) {
  if (!prefs) return true;
  if (cmd === "popup") return !!prefs.allow_popup;
  if (cmd === "open_url") return !!prefs.allow_open_url;
  if (cmd === "image_popup") return !!prefs.allow_image_popup;
  if (cmd === "set_wallpaper") return !!prefs.allow_set_wallpaper;
  return true;
}

function resolveOwnerAndDevicesByPairCode(pairCode) {
  const codeHash = hmac(pairCode);
  const pc = db
    .prepare("SELECT user_id FROM pair_codes WHERE code_hash=?")
    .get(codeHash);
  if (!pc) return null;

  const deviceRows = db
    .prepare("SELECT device_id FROM device_pairs WHERE user_id=?")
    .all(pc.user_id);
  return {
    ownerUserId: pc.user_id,
    deviceIds: deviceRows.map((r) => r.device_id),
  };
}

function getAboutMe(userId) {
  try {
    const row = db
      .prepare(`SELECT about_me FROM users WHERE discord_id=?`)
      .get(userId);
    return String(row?.about_me || "");
  } catch {
    return "";
  }
}

function setAboutMe(userId, text) {
  const clean = String(text || "").slice(0, 500);
  db.prepare(`UPDATE users SET about_me=? WHERE discord_id=?`).run(
    clean,
    userId,
  );
  return clean;
}

function getApiKeyFromReq(req) {
  const h = req.headers["authorization"];
  if (h && typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  const x = req.headers["x-api-key"];
  if (x && typeof x === "string") return x.trim();
  return null;
}

const API_MIN_COMMANDS = 500;

function getCommandsSentTotal(discordId) {
  const r = db
    .prepare(
      `SELECT IFNULL(commands_sent_total, 0) AS n FROM users WHERE discord_id=?`,
    )
    .get(discordId);
  return r ? Number(r.n || 0) : 0;
}

function requireApiKey(req, res, next) {
  const raw = getApiKeyFromReq(req);
  if (!raw) return res.status(401).json({ ok: false, code: "NO_API_KEY" });

  const key_hash = hashApiKey(raw);

  const row = db
    .prepare(
      `
    SELECT
      k.user_id,
      IFNULL(u.commands_sent_total, 0) AS commands_sent_total
    FROM api_keys k
    JOIN users u ON u.discord_id = k.user_id
    WHERE k.key_hash = ?
  `,
    )
    .get(key_hash);

  if (!row) return res.status(401).json({ ok: false, code: "INVALID_API_KEY" });

  if (row.commands_sent_total < API_MIN_COMMANDS) {
    return res.status(403).json({
      ok: false,
      code: "API_LOCKED",
      message: `API requires ${API_MIN_COMMANDS}+ commands sent.`,
      required: API_MIN_COMMANDS,
      have: row.commands_sent_total,
    });
  }

  req.api = { key_hash, user_id: row.user_id };
  next();
}

function enforceDailyQuota(req, res, next) {
  const LIMIT = 10_000;
  const nowUnix = Math.floor(Date.now() / 1000);

  function nextReset() {
    const d = new Date();
    d.setUTCHours(1, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  const key_hash = req.api?.key_hash;
  if (!key_hash)
    return res.status(500).json({ ok: false, code: "API_MISSING_CONTEXT" });

  let row = db
    .prepare(
      `
    SELECT
      IFNULL(requests_today, 0) AS requests_today,
      IFNULL(reset_unix, 0) AS reset_unix
    FROM api_keys
    WHERE key_hash=?
  `,
    )
    .get(key_hash);

  if (!row) return res.status(401).json({ ok: false, code: "INVALID_API_KEY" });

  let used = row.requests_today || 0;
  let resetUnix = row.reset_unix || 0;

  if (resetUnix <= 0 || nowUnix >= resetUnix) {
    resetUnix = nextReset();
    used = 0;
    db.prepare(
      `
      UPDATE api_keys
      SET requests_today=0, reset_unix=?
      WHERE key_hash=?
    `,
    ).run(resetUnix, key_hash);
  }

  let remaining = LIMIT - used;
  if (remaining < 0) remaining = 0;

  res.set("X-RateLimit-Limit", String(LIMIT));
  res.set("X-RateLimit-Remaining", String(remaining));
  res.set("X-RateLimit-Reset", String(resetUnix));

  try {
    const authedUserId = req.apiUserId || req.user?.discord_id || null;
    if (authedUserId) {
      const prev =
        db
          .prepare(`SELECT api_rate_limit FROM users WHERE discord_id=?`)
          .get(authedUserId)?.api_rate_limit || 0;
      const next = Number(used) || 0;
      if (prev !== next) {
        db.prepare(`UPDATE users SET api_rate_limit=? WHERE discord_id=?`).run(
          next,
          authedUserId,
        );
      }
    }
  } catch (e) {}

  if (remaining <= 0) {
    res.set("Retry-After", String(Math.max(0, resetUnix - nowUnix)));
    return res
      .status(429)
      .json({ ok: false, code: "RATE_LIMITED", reset: resetUnix });
  }

  db.prepare(
    `
    UPDATE api_keys
    SET requests_today = requests_today + 1
    WHERE key_hash=?
  `,
  ).run(key_hash);

  res.set("X-RateLimit-Remaining", String(Math.max(0, remaining - 1)));

  next();
}

const sessions = new Map();

function requireDiscord(req, res, next) {
  const sid = req.cookies?.sid;
  if (!sid) return res.redirect("/auth/discord");

  const user = db
    .prepare(
      `
    SELECT users.discord_id, users.username, users.global_name, users.avatar,
          users.discoverable, users.invited_at
    FROM sessions
    JOIN users ON users.discord_id = sessions.discord_id
    WHERE sessions.session_id = ?
  `,
    )
    .get(sid);

  if (!user) return res.redirect("/auth/discord");
  req.user = user;
  next();
}

const wsByDeviceId = new Map();

const HEARTBEAT_INTERVAL_MS = 15_000;

function isDeviceOnline(deviceId) {
  const ws = wsByDeviceId.get(deviceId);
  return !!(ws && ws.readyState === WebSocket.OPEN && ws.isAlive === true);
}

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "./views"));
app.use(express.static(path.join(__dirname, "../public")));
app.use(cookieParser());
app.use(express.json({ strict: true }));
app.use(express.urlencoded({ extended: false }));
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposedHeaders: [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
  }),
);

app.set("trust proxy", 1);

app.use((req, _res, next) => {
  req.viewUser = getLoggedInUser(req);
  req.viewIsAdmin = req.viewUser ? isAdmin(req.viewUser.discord_id) : false;
  next();
});

app.use(inviteGate);

app.use((req, res, next) => {
  const user = req.viewUser || null;
  const isAdmin = req.viewIsAdmin || null;

  res.locals.user = user;
  res.locals.isAdmin = isAdmin;
  res.locals.displayName = user
    ? user.global_name || user.username || user.discord_id
    : null;
  res.locals.avatarUrl = user
    ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.discord_id)}/${encodeURIComponent(user.avatar || "")}.png?size=64`
    : "";
  res.locals.meta = {
    ogTitle: "PlayCtrl.me",
    ogDesc: "Remote play & control",
    ogUrl: "https://playctrl.me",
    ogImage: "https://playctrl.me/favicon-96x96.png",
  };

  res.locals.LISTS = LISTS;

  next();
});

app.use((req, res, next) => {
  const me = req.viewUser;

  if (!me) {
    res.locals.commandsSentTotal = null;
    return next();
  }

  const row = db
    .prepare(`SELECT commands_sent_total FROM users WHERE discord_id=?`)
    .get(me.discord_id);

  res.locals.commandsSentTotal = row?.commands_sent_total ?? 0;
  next();
});

app.use((req, res, next) => {
  res.locals.discordAvatarUrl = discordAvatarUrl;
  next();
});

const api = express.Router();

api.use(
  express.json({
    limit: "32kb",
    type: ["application/json", "application/*+json"],
  }),
);

api.use(requireApiKey);
api.use(enforceDailyQuota);

app.use("/api/v1", api);

function requireNotBanned(req, res, next) {
  const u = req.user || req.viewUser;
  if (!u?.discord_id) return next();

  const banned = db
    .prepare("SELECT discord_id, reason FROM bans WHERE discord_id=?")
    .get(u.discord_id);
  if (!banned) return next();

  return res.status(403).type("html").send(`
    <h1>Access denied</h1>
    <p>Your account is banned.</p>
    ${banned.reason ? `<p>Reason: ${escapeHtml(banned.reason)}</p>` : ""}
  `);
}

function denyIfDisabled(req, res, ownerId, cmd) {
  const prefs = getCommandPrefsForUser(ownerId);
  if (isCommandEnabled(prefs, cmd)) return false;

  const msg = "That command is disabled for this user.";
  if (wantsJson(req)) {
    res
      .status(403)
      .json({ ok: false, reason: "command_disabled", cmd, message: msg });
  } else {
    res
      .status(403)
      .type("html")
      .send(
        `${msg} <a href="/device/${encodeURIComponent(req.params.pairCode)}">Back</a>`,
      );
  }
  return true;
}

app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, reason: "bad_json" });
  }
  next(err);
});

app.get("/", requireNotBanned, (req, res) => {
  renderWithLayout(res, "pages/home", {
    title: "PlayCtrl.me",
  });
});

app.post("/logout", (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) {
    db.prepare("DELETE FROM sessions WHERE session_id=?").run(sid);
  }
  res.clearCookie("sid");
  res.redirect("/");
});

app.use(
  "/upd",
  express.static(path.join(__dirname, "../playctrl-updates"), {
    index: false,
    cacheControl: false,
  }),
);

app.use(
  "/public",
  express.static(path.join(__dirname, "../public"), {
    index: false,
    cacheControl: false,
  }),
);

app.get("/auth/discord", (req, res) => {
  const state = b64url(crypto.randomBytes(16));
  const nextUrl = String(req.query.next || "/").trim();
  res.cookie("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });
  res.cookie("oauth_next", nextUrl, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state,
  });

  res.redirect(`${DISCORD_AUTH}?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.cookies.oauth_state)
    return res.status(400).send("Bad OAuth state");

  const tokenResp = await fetch(DISCORD_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
    }),
  });

  if (!tokenResp.ok) return res.status(500).send("Token exchange failed");
  const token = await tokenResp.json();

  const meResp = await fetch(DISCORD_ME, {
    headers: { authorization: `${token.token_type} ${token.access_token}` },
  });

  if (!meResp.ok) return res.status(500).send("Failed to fetch user");
  const me = await meResp.json();

  const existing = db
    .prepare("SELECT discord_id FROM users WHERE discord_id=?")
    .get(me.id);

  db.prepare(
    `
    INSERT INTO users (discord_id, username, global_name, avatar, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      username=excluded.username,
      global_name=excluded.global_name,
      avatar=excluded.avatar,
      updated_at=excluded.updated_at
  `,
  ).run(me.id, me.username, me.global_name, me.avatar, Date.now(), Date.now());

  logEvent({
    type: existing ? "user_updated" : "user_created",
    actorUserId: me.id,
    targetUserId: me.id,
    req,
    payload: { username: me.username, global_name: me.global_name },
  });

  const sessionId = crypto.randomUUID();

  db.prepare(
    `
    INSERT INTO sessions (session_id, discord_id, created_at)
    VALUES (?, ?, ?)
  `,
  ).run(sessionId, me.id, Date.now());

  res.cookie("sid", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 1000 * 60 * 60 * 24 * 15,
    path: "/",
  });

  const discordId = String(me.id);

  const ageDays = discordAccountAgeDays(discordId);
  if (ageDays !== null && ageDays < 15) {
    banDiscordIdSystem(discordId, req, { rule: "discord_age_lt_15d", ageDays });

    return res.status(403).type("html").send("Access denied.");
  }

  console.log(
    "ID: " +
      me.id +
      " Username: " +
      me.username +
      " Global Name: " +
      me.global_name +
      " Avatar: " +
      me.avatar,
  );

  const nextUrl = req.cookies.oauth_next || "/";
  res.clearCookie("oauth_next");
  res.redirect(nextUrl);
});

app.options("/api/pair", cors());

app.post("/api/pair", (req, res) => {
  try {
    const pairCode = String(req.body?.pairCode || "").trim();
    const deviceId = String(req.body?.deviceId || "").trim();

    console.log("[/api/pair] body=", req.body);

    if (!/^\d{6}$/.test(pairCode) || !deviceId) {
      console.log("[/api/pair] bad_request", { pairCode, deviceId });
      return res.status(400).json({ ok: false, reason: "bad_request" });
    }

    const codeHash = hmac(pairCode);
    console.log("[/api/pair] codeHash=", codeHash);

    const pc = db
      .prepare("SELECT user_id FROM pair_codes WHERE code_hash=?")
      .get(codeHash);
    console.log("[/api/pair] pair_codes row=", pc);

    if (!pc) return res.status(404).json({ ok: false, reason: "invalid_code" });

    const token = crypto.randomBytes(24).toString("base64url");

    db.prepare(
      `
      INSERT INTO devices_v2 (device_id, device_token_hash, created_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        device_token_hash=excluded.device_token_hash,
        last_seen_at=excluded.last_seen_at
    `,
    ).run(deviceId, hmac(token), Date.now(), Date.now());

    db.prepare(
      `
      INSERT INTO device_pairs (device_id, user_id, paired_at)
      VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        user_id=excluded.user_id,
        paired_at=excluded.paired_at
    `,
    ).run(deviceId, pc.user_id, Date.now());

    console.log("[/api/pair] ok userId=", pc.user_id);

    return res.json({ ok: true, deviceToken: token, userId: pc.user_id });
  } catch (e) {
    console.error("[/api/pair] ERROR", e);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

app.get("/invite", requireDiscord, (req, res) => {
  if (req.user.invited_at || isAdmin(req.user.discord_id))
    return res.redirect("/profile");

  res.type("html").send(
    layout({
      title: "Invite Required",
      user: req.viewUser,
      isAdmin: req.viewIsAdmin,
      body: `
      <h1>Invite only</h1>
      <p>This site is currently invite-only. Enter an invite code to continue.</p>

      <form method="POST" action="/invite/redeem" style="margin-top:14px;display:flex;gap:10px;align-items:center;">
        <input name="code" placeholder="Invite code" style="width:320px;padding:10px;" autocomplete="off" />
        <button type="submit">Unlock</button>
      </form>

      <p style="opacity:.7;margin-top:10px;">
        Invite codes are one-time use.
      </p>
    `,
    }),
  );
});

app.post("/invite/redeem", requireDiscord, (req, res) => {
  if (req.user.invited_at || isAdmin(req.user.discord_id))
    return res.redirect("/profile");

  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();
  if (!code || code.length < 6 || code.length > 32) {
    return res
      .status(400)
      .type("html")
      .send(
        layout({
          title: "Invite Required",
          user: req.viewUser,
          isAdmin: req.viewIsAdmin,
          body: `<p>Invalid invite code format.</p><p><a href="/invite">Back</a></p>`,
        }),
      );
  }

  const codeHash = inviteHash(code);

  const inv = db
    .prepare(
      `
    SELECT code_hash, used_at
    FROM invite_codes
    WHERE code_hash = ?
  `,
    )
    .get(codeHash);

  if (!inv || inv.used_at) {
    return res
      .status(403)
      .type("html")
      .send(
        layout({
          title: "Invite Required",
          user: req.viewUser,
          isAdmin: req.viewIsAdmin,
          body: `<p>That invite code is invalid or already used.</p><p><a href="/invite">Try again</a></p>`,
        }),
      );
  }

  const now = Date.now();

  const tx = db.transaction(() => {
    const spent = db
      .prepare(
        `
      UPDATE invite_codes
      SET used_at = ?, used_by = ?
      WHERE code_hash = ? AND used_at IS NULL
    `,
      )
      .run(now, req.user.discord_id, codeHash);

    if (spent.changes !== 1) throw new Error("invite_race_lost");

    db.prepare(
      `
      UPDATE users
      SET invited_at = COALESCE(invited_at, ?)
      WHERE discord_id = ?
    `,
    ).run(now, req.user.discord_id);
  });

  try {
    tx();

    logEvent({
      type: "invite_redeemed",
      actorUserId: req.user.discord_id,
      targetUserId: req.user.discord_id,
      req,
      payload: {},
    });

    return res.redirect("/profile");
  } catch (e) {
    console.error("invite redeem failed:", e);
    return res
      .status(500)
      .type("html")
      .send(
        layout({
          title: "Invite Required",
          user: req.viewUser,
          isAdmin: req.viewIsAdmin,
          body: `<p>Something went wrong redeeming that invite code. Try again.</p><p><a href="/invite">Back</a></p>`,
        }),
      );
  }
});

app.get("/api-docs", (req, res) => {
  const host = `${req.protocol}://${req.get("host")}`;
  const base = `${host}/api/v1`;

  res.locals.base = base;

  renderWithLayout(res, "pages/api_docs", {
    title: "API Docs",
  });
});

app.get("/profile", requireDiscord, requireNotBanned, (req, res) => {
  const code = ensurePairCode(req.user.discord_id);
  res.locals.code = code;
  res.locals.fullControlUrl = `https://playctrl.me/device/${code}`;

  res.locals.catalog = getCatalogItems();
  res.locals.selections = getUserSelections(req.user.discord_id);

  res.locals.isDiscoverOn = !!req.user.discoverable;
  res.locals.prefs = getCommandPrefsForUser(req.user.discord_id);

  const wlRow = db
    .prepare(`SELECT whitelist_enabled FROM users WHERE discord_id=?`)
    .get(req.user.discord_id);
  res.locals.isWhitelistOn = !!wlRow?.whitelist_enabled;
  res.locals.wlList = getWhitelist(req.user.discord_id);

  res.locals.aboutMe = getAboutMe(req.user.discord_id);

  const commandsSentTotal = Number(
    db
      .prepare(
        `SELECT IFNULL(commands_sent_total, 0) AS n FROM users WHERE discord_id=?`,
      )
      .get(req.user.discord_id)?.n || 0,
  );

  const apiEligible = commandsSentTotal >= 500;
  res.locals.apiEligible = apiEligible;

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

app.post("/profile/reset-code", requireDiscord, (req, res) => {
  const userId = req.user.discord_id;

  const deviceIds = unpairAllDevicesForUser(userId);

  const code = gen6();
  db.prepare(
    `
    INSERT INTO pair_codes (user_id, code_hash, code_plain, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      code_hash=excluded.code_hash,
      code_plain=excluded.code_plain,
      updated_at=excluded.updated_at
  `,
  ).run(userId, hmac(code), code, Date.now());

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

  res.redirect("/profile");
});

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
    actorUserId: req.user.discord_id,
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

app.post("/profile/commands", requireDiscord, (req, res) => {
  const cmd = String(req.body?.cmd || "").trim();
  const enabled = String(req.body?.enabled || "0") === "1" ? 1 : 0;

  const col =
    cmd === "popup"
      ? "allow_popup"
      : cmd === "open_url"
        ? "allow_open_url"
        : cmd === "image_popup"
          ? "allow_image_popup"
          : cmd === "set_wallpaper"
            ? "allow_set_wallpaper"
            : null;

  if (!col) {
    if (wantsJson(req))
      return res.status(400).json({ ok: false, message: "Unknown command." });
    return res.status(400).send("Unknown command.");
  }

  db.prepare(`UPDATE users SET ${col}=? WHERE discord_id=?`).run(
    enabled,
    req.user.discord_id,
  );

  logEvent({
    type: "command_pref_updated",
    actorUserId: req.user.discord_id,
    targetUserId: req.user.discord_id,
    req,
    payload: { cmd, enabled },
  });

  if (wantsJson(req)) {
    return res.json({ ok: true, cmd, enabled, message: "Saved" });
  }
  return res.redirect("/profile");
});

app.post("/profile/aboutme", requireDiscord, requireNotBanned, (req, res) => {
  const text = String(req.body?.text || "");
  const saved = setAboutMe(req.user.discord_id, text);

  logEvent({
    type: "about_me_updated",
    actorUserId: req.user.discord_id,
    targetUserId: req.user.discord_id,
    req,
    payload: { len: saved.length },
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
      actorUserId: req.user.discord_id,
      targetUserId: req.user.discord_id,
      req,
      payload: {},
    });

    if (wantsJson(req)) return res.json({ ok: true, enabled });
    return res.redirect("/profile");
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

    db.prepare(
      `
    INSERT OR IGNORE INTO user_whitelist (owner_id, allowed_id, created_at)
    VALUES (?, ?, ?)
  `,
    ).run(req.user.discord_id, allowedId, Date.now());

    logEvent({
      type: "whitelist_added",
      actorUserId: req.user.discord_id,
      targetUserId: allowedId,
      req,
      payload: {},
    });

    if (wantsJson(req)) return res.json({ ok: true });
    return res.redirect("/profile");
  },
);

app.post(
  "/profile/whitelist/remove",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const allowedId = String(req.body?.discord_id || "").trim();

    db.prepare(
      `
    DELETE FROM user_whitelist
    WHERE owner_id=? AND allowed_id=?
  `,
    ).run(req.user.discord_id, allowedId);

    logEvent({
      type: "whitelist_removed",
      actorUserId: req.user.discord_id,
      targetUserId: allowedId,
      req,
      payload: {},
    });

    if (wantsJson(req)) return res.json({ ok: true });
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
    const sent = getCommandsSentTotal(req.user.discord_id);

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
    ).run(req.user.discord_id, key_hash, req.user.discord_id, now, now);

    return res.json({
      ok: true,
      api_key: raw,
      last_reset_at: now,
    });
  },
);

app.get("/device/:pairCode", requireDiscord, requireNotBanned, (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();
  if (!/^\d{6}$/.test(pairCode)) return res.status(400).send("Bad device code");

  const me = req.viewUser?.discord_id || null;

  res.locals.pairCode = pairCode;

  const codeHash = hmac(pairCode);
  const pc = db
    .prepare("SELECT user_id FROM pair_codes WHERE code_hash=?")
    .get(codeHash);
  if (!pc) return res.status(404).send("Unknown code");

  const ownerId = pc.user_id;
  res.locals.ownerId = ownerId;

  const ownerUser = db
    .prepare(
      `
    SELECT discord_id, username, global_name, avatar
    FROM users
    WHERE discord_id=?
  `,
    )
    .get(ownerId);
  res.locals.ownerUser = ownerUser;

  const viewerRow = db
    .prepare(
      `
    SELECT commands_sent_total
    FROM users
    WHERE discord_id=?
  `,
    )
    .get(req.user.discord_id);
  const viewerCommandsSentTotal = Number(viewerRow?.commands_sent_total || 0);
  res.locals.cooldownApplies = viewerCommandsSentTotal < 100;

  res.locals.viewerIsOwner = req.user.discord_id === ownerId;
  res.locals.boardMsgs = getBoardMessages(ownerId, 10);

  const ownerPrefs = getCommandPrefsForUser(ownerId);

  const ownerSelections = getUserSelections(ownerId);
  const catalog = getCatalogItems();

  res.locals.aboutMe = getAboutMe(ownerId);

  res.locals.labelByKey = new Map(catalog.map((it) => [it.key, it.label]));
  res.locals.favKeys = Array.from(ownerSelections.favorites || []);
  res.locals.disKeys = Array.from(ownerSelections.dislikes || []);

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
    .all(ownerId);

  res.locals.anyOnline = devices.some((d) => isDeviceOnline(d.device_id));

  const canPopup = isCommandEnabled(ownerPrefs, "popup");
  const canOpenUrl = isCommandEnabled(ownerPrefs, "open_url");
  const canImage = isCommandEnabled(ownerPrefs, "image_popup");
  const canSetWallpaper = isCommandEnabled(ownerPrefs, "set_wallpaper");

  res.locals.canPopup = canPopup;
  res.locals.canOpenUrl = canOpenUrl;
  res.locals.canImage = canImage;
  res.locals.canSetWallpaper = canSetWallpaper;
  res.locals.anyCommandsEnabled =
    canPopup || canOpenUrl || canImage || canSetWallpaper;

  let isFavorited = false;
  if (me) {
    isFavorited = !!db
      .prepare(
        `
      SELECT 1 FROM favorites
      WHERE user_id = ? AND favorite_user_id = ?
    `,
      )
      .get(me, ownerId);
  }
  res.locals.isFavorited = isFavorited;

  renderWithLayout(res, "pages/control_links/con_main", {
    title: "Control",
    meta: {
      ogTitle: `Control ${ownerUser?.global_name || ownerUser?.username || "User"}'s device!`,
      ogDesc: `Open this control page to send commands.`,
    },
  });
});

api.get("/user/:pairCode", (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();

  const row = db
    .prepare(
      `
    SELECT
      u.discord_id,
      u.username,
      u.global_name,
      u.avatar,
      pc.code_plain,
      IFNULL(u.whitelist_enabled, 0) AS whitelist_enabled,
      IFNULL(u.discoverable, 0) AS discoverable
    FROM pair_codes pc
    JOIN users u ON u.discord_id = pc.user_id
    WHERE pc.code_plain = ?
  `,
    )
    .get(pairCode);

  if (!row) return res.status(404).json({ ok: false, code: "USER_NOT_FOUND" });

  const devs = db
    .prepare(`SELECT device_id FROM device_pairs WHERE user_id=?`)
    .all(row.discord_id);
  const online = devs.some((d) => isDeviceOnline(d.device_id));

  res.json({
    ok: true,
    user: {
      displayName: row.global_name || row.username || row.discord_id,
      username: row.username || null,
      discordId: row.discord_id,
      pairCode: row.code_plain,
      avatarUrl: discordAvatarUrl(row, 128),
      online,
      discoverable: !!row.discoverable,
      whitelistEnabled: !!row.whitelist_enabled,
    },
  });
});

app.get("/discover", (req, res) => {
  function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function windowIdNow10m() {
    return Math.floor(Date.now() / (10 * 60 * 1000));
  }

  const rows = db
    .prepare(
      `
    SELECT
      u.discord_id,
      u.username,
      u.global_name,
      u.avatar,
      pc.code_plain
    FROM users u
    JOIN pair_codes pc ON pc.user_id = u.discord_id
    WHERE u.discoverable = 1 AND IFNULL(u.whitelist_enabled, 0) = 0
    ORDER BY u.global_name COLLATE NOCASE, u.username COLLATE NOCASE
    LIMIT 500
  `,
    )
    .all();

  const onlineByUser = new Map();
  const ids = rows.map((r) => r.discord_id);

  if (ids.length) {
    const placeholders = ids.map((_, i) => `@id${i}`).join(",");
    const args = {};
    ids.forEach((id, i) => (args[`id${i}`] = id));

    const pairs = db
      .prepare(
        `
      SELECT user_id, device_id
      FROM device_pairs
      WHERE user_id IN (${placeholders})
    `,
      )
      .all(args);

    const deviceIdsByUser = new Map();
    for (const p of pairs) {
      if (!deviceIdsByUser.has(p.user_id)) deviceIdsByUser.set(p.user_id, []);
      deviceIdsByUser.get(p.user_id).push(p.device_id);
    }

    for (const userId of ids) {
      const devs = deviceIdsByUser.get(userId) || [];
      const anyOnline = devs.some((did) => isDeviceOnline(did));
      onlineByUser.set(userId, anyOnline);
    }
  }

  let onlineRows = rows.filter((u) => !!onlineByUser.get(u.discord_id));

  const winId = windowIdNow10m();
  onlineRows.sort((a, b) => {
    const ak = fnv1a32(String(winId) + ":" + String(a.code_plain || ""));
    const bk = fnv1a32(String(winId) + ":" + String(b.code_plain || ""));
    return ak - bk;
  });

  res.locals.onlineRows = onlineRows;

  renderWithLayout(res, "pages/discover/dsc_main", {
    title: "Discover",
  });
});

api.get("/discover", (req, res) => {
  const rows = db
    .prepare(
      `
    SELECT
      u.discord_id,
      u.username,
      u.global_name,
      u.avatar,
      pc.code_plain
    FROM users u
    JOIN pair_codes pc ON pc.user_id = u.discord_id
    WHERE u.discoverable = 1
      AND IFNULL(u.whitelist_enabled, 0) = 0
    ORDER BY u.global_name COLLATE NOCASE, u.username COLLATE NOCASE
    LIMIT 500
  `,
    )
    .all();

  const ids = rows.map((r) => r.discord_id);
  const onlineByUser = new Map();

  if (ids.length) {
    const placeholders = ids.map((_, i) => `@id${i}`).join(",");
    const args = {};
    ids.forEach((id, i) => (args[`id${i}`] = id));

    const pairs = db
      .prepare(
        `
      SELECT user_id, device_id
      FROM device_pairs
      WHERE user_id IN (${placeholders})
    `,
      )
      .all(args);

    const deviceIdsByUser = new Map();
    for (const p of pairs) {
      if (!deviceIdsByUser.has(p.user_id)) deviceIdsByUser.set(p.user_id, []);
      deviceIdsByUser.get(p.user_id).push(p.device_id);
    }

    for (const userId of ids) {
      const devs = deviceIdsByUser.get(userId) || [];
      const anyOnline = devs.some((did) => isDeviceOnline(did));
      onlineByUser.set(userId, anyOnline);
    }
  }

  const users = rows.map((u) => {
    const displayName = u.global_name || u.username || u.discord_id;
    const avatarUrl = discordAvatarUrl(u, 128);
    return {
      displayName,
      username: u.username || null,
      discordId: u.discord_id,
      pairCode: u.code_plain,
      avatarUrl,
      online: !!onlineByUser.get(u.discord_id),
    };
  });

  res.json({ ok: true, users });
});

app.get("/favorites", (req, res) => {
  if (!req.viewUser) return res.redirect("/login");
  const me = req.viewUser.discord_id;

  const rows = db
    .prepare(
      `
    SELECT
      f.favorite_user_id AS discord_id,
      f.created_at AS favorited_at,
      u.username,
      u.global_name,
      u.avatar,
      pc.code_plain
    FROM favorites f
    JOIN users u ON u.discord_id = f.favorite_user_id
    LEFT JOIN pair_codes pc ON pc.user_id = u.discord_id
    WHERE f.user_id = ?
    ORDER BY f.created_at ASC
  `,
    )
    .all(me);

  const ids = rows.map((r) => r.discord_id);
  const onlineByUser = new Map();

  if (ids.length) {
    const placeholders = ids.map((_, i) => `@id${i}`).join(",");
    const args = {};
    ids.forEach((id, i) => (args[`id${i}`] = id));

    const pairs = db
      .prepare(
        `
      SELECT user_id, device_id
      FROM device_pairs
      WHERE user_id IN (${placeholders})
    `,
      )
      .all(args);

    const deviceIdsByUser = new Map();
    for (const p of pairs) {
      if (!deviceIdsByUser.has(p.user_id)) deviceIdsByUser.set(p.user_id, []);
      deviceIdsByUser.get(p.user_id).push(p.device_id);
    }

    for (const userId of ids) {
      const devs = deviceIdsByUser.get(userId) || [];
      const anyOnline = devs.some((did) => isDeviceOnline(did));
      onlineByUser.set(userId, anyOnline);
    }
  }

  let onlineRows = rows.filter((u) => !!onlineByUser.get(u.discord_id));
  let offlineRows = rows.filter((u) => !onlineByUser.get(u.discord_id));

  const sortByOldest = (a, b) => {
    const at = Number(a.favorited_at || 0);
    const bt = Number(b.favorited_at || 0);
    if (at !== bt) return at - bt;

    return String(a.discord_id || "").localeCompare(String(b.discord_id || ""));
  };

  onlineRows.sort(sortByOldest);
  offlineRows.sort(sortByOldest);

  res.locals.favUsers = onlineRows.concat(offlineRows);

  renderWithLayout(res, "pages/favorites/fav_main", {
    title: "Favorites",
  });
});

api.get("/favorites", (req, res) => {
  const me = req.api.user_id;

  const rows = db
    .prepare(
      `
      SELECT
        u.discord_id,
        u.username,
        u.global_name,
        u.avatar,
        pc.code_plain
      FROM favorites f
      JOIN users u ON u.discord_id = f.favorite_user_id
      JOIN pair_codes pc ON pc.user_id = u.discord_id
      WHERE f.user_id = ?
      ORDER BY f.created_at ASC
      LIMIT 500
    `,
    )
    .all(me);

  const ids = rows.map((r) => r.discord_id);
  const onlineByUser = new Map();

  if (ids.length) {
    const placeholders = ids.map((_, i) => `@id${i}`).join(",");
    const args = {};
    ids.forEach((id, i) => (args[`id${i}`] = id));

    const pairs = db
      .prepare(
        `
        SELECT user_id, device_id
        FROM device_pairs
        WHERE user_id IN (${placeholders})
      `,
      )
      .all(args);

    const deviceIdsByUser = new Map();
    for (const p of pairs) {
      if (!deviceIdsByUser.has(p.user_id)) deviceIdsByUser.set(p.user_id, []);
      deviceIdsByUser.get(p.user_id).push(p.device_id);
    }

    for (const userId of ids) {
      const devs = deviceIdsByUser.get(userId) || [];
      const anyOnline = devs.some((did) => isDeviceOnline(did));
      onlineByUser.set(userId, anyOnline);
    }
  }

  const users = rows.map((u) => {
    const displayName = u.global_name || u.username || u.discord_id;
    const avatarUrl = discordAvatarUrl(u, 128);

    return {
      displayName,
      username: u.username || null,
      discordId: u.discord_id,
      pairCode: u.code_plain,
      avatarUrl,
      online: !!onlineByUser.get(u.discord_id)
    };
  });

  res.json({ ok: true, users });
});

function resolveDevicesForPairCode(pairCode) {
  const codeHash = hmac(pairCode);
  const pc = db
    .prepare("SELECT user_id FROM pair_codes WHERE code_hash=?")
    .get(codeHash);
  if (!pc) return { ok: false, reason: "invalid_code" };

  const devices = db
    .prepare(
      `
    SELECT device_id FROM device_pairs WHERE user_id=?
  `,
    )
    .all(pc.user_id);

  return {
    ok: true,
    userId: pc.user_id,
    deviceIds: devices.map((r) => r.device_id),
  };
}

function unpairAllDevicesForUser(userId) {
  const deviceRows = db
    .prepare(
      `
    SELECT device_id FROM device_pairs WHERE user_id=?
  `,
    )
    .all(userId);

  const deviceIds = deviceRows.map((r) => r.device_id);

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM device_pairs WHERE user_id=?`).run(userId);

    const invalidate = db.prepare(
      `UPDATE devices_v2 SET device_token_hash=? WHERE device_id=?`,
    );
    for (const deviceId of deviceIds) {
      invalidate.run(
        hmac(crypto.randomBytes(24).toString("base64url")),
        deviceId,
      );
    }
  });

  tx();
  return deviceIds;
}

app.get("/api/presence/discover", (req, res) => {
  const rows = db
    .prepare(
      `
    SELECT u.discord_id, pc.code_plain
    FROM users u
    JOIN pair_codes pc ON pc.user_id = u.discord_id
    WHERE u.discoverable = 1
    LIMIT 500
  `,
    )
    .all();

  if (!rows.length) return res.json({ ok: true, map: {}, ts: Date.now() });

  const ids = rows.map((r) => r.discord_id);
  const placeholders = ids.map((_, i) => `@id${i}`).join(",");
  const args = {};
  ids.forEach((id, i) => (args[`id${i}`] = id));

  const pairs = db
    .prepare(
      `
    SELECT user_id, device_id
    FROM device_pairs
    WHERE user_id IN (${placeholders})
  `,
    )
    .all(args);

  const deviceIdsByUser = new Map();
  for (const p of pairs) {
    if (!deviceIdsByUser.has(p.user_id)) deviceIdsByUser.set(p.user_id, []);
    deviceIdsByUser.get(p.user_id).push(p.device_id);
  }

  const map = {};
  for (const r of rows) {
    const devs = deviceIdsByUser.get(r.discord_id) || [];
    const online = devs.some((did) => isDeviceOnline(did));
    map[String(r.code_plain)] = { online };
  }

  res.json({ ok: true, map, ts: Date.now() });
});

app.get("/api/presence/favorites", (req, res) => {
  if (!req.viewUser)
    return res.status(401).json({ ok: false, error: "not_logged_in" });

  const me = req.viewUser.discord_id;

  const rows = db
    .prepare(
      `
    SELECT u.discord_id, pc.code_plain
    FROM favorites f
    JOIN users u ON u.discord_id = f.favorite_user_id
    JOIN pair_codes pc ON pc.user_id = u.discord_id
    WHERE f.user_id = ?
    ORDER BY f.created_at ASC
    LIMIT 500
  `,
    )
    .all(me);

  if (!rows.length) return res.json({ ok: true, map: {}, ts: Date.now() });

  const ids = rows.map((r) => r.discord_id);
  const placeholders = ids.map((_, i) => `@id${i}`).join(",");
  const args = {};
  ids.forEach((id, i) => (args[`id${i}`] = id));

  const pairs = db
    .prepare(
      `
    SELECT user_id, device_id
    FROM device_pairs
    WHERE user_id IN (${placeholders})
  `,
    )
    .all(args);

  const deviceIdsByUser = new Map();
  for (const p of pairs) {
    if (!deviceIdsByUser.has(p.user_id)) deviceIdsByUser.set(p.user_id, []);
    deviceIdsByUser.get(p.user_id).push(p.device_id);
  }

  const map = {};
  for (const r of rows) {
    const devs = deviceIdsByUser.get(r.discord_id) || [];
    const online = devs.some((did) => isDeviceOnline(did));
    map[String(r.code_plain)] = { online };
  }

  res.json({ ok: true, map, ts: Date.now() });
});

app.get("/api/presence/:pairCode", (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();
  if (!/^\d{6}$/.test(pairCode))
    return res.status(400).json({ ok: false, message: "bad_pair_code" });

  const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
  if (!resolved)
    return res.status(404).json({ ok: false, message: "unknown_code" });

  const deviceIds = resolved.deviceIds || [];

  const onlineCount = deviceIds.reduce(
    (n, id) => n + (isDeviceOnline(id) ? 1 : 0),
    0,
  );

  return res.json({
    ok: true,
    pairCode,
    ownerUserId: resolved.ownerUserId,
    online: onlineCount > 0,
    onlineCount,
    deviceCount: deviceIds.length,
    ts: Date.now(),
  });
});

function apiFail(res, httpStatus, code, extra = {}) {
  return res.status(httpStatus).json({ ok: false, code, ...extra });
}

api.post("/commands", async (req, res) => {
  const body = req.body || {};
  const actorId = req.api.user_id;

  const pairCode = String(body.pairCode || "").trim();
  if (!pairCode) {
    return apiFail(res, 400, "INVALID_PAIRCODE", {
      message: "pairCode is either missing or invalid",
    });
  }

  const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
  if (!resolved) {
    return apiFail(res, 400, "INVALID_PAIRCODE", {
      message: "pairCode is either missing or invalid",
    });
  }

  const ownerId = resolved.ownerUserId;
  const deviceIds = resolved.deviceIds || [];

  if (!isAllowedByWhitelist(ownerId, actorId)) {
    return apiFail(res, 403, "NOT_WHITELISTED");
  }

  const type = String(body.command || "").trim();
  const allowed = new Set(["popup", "open_url", "image_popup", "set_wallpaper"]);
  if (!allowed.has(type)) {
    return apiFail(res, 400, "BAD_REQUEST", { message: "Unknown command type." });
  }

  const paramsObj = body.parameters || {};
  const params = new Set(Object.keys(paramsObj));

  switch (type) {
    case "popup": {
      const msg = String(paramsObj.message || "").trim();
      if (!msg) {
        return apiFail(res, 400, "MISSING_PARAMETER", {
          message: "Required parameter missing: message",
        });
      }
      break;
    }

    case "open_url":
    case "image_popup":
    case "set_wallpaper": {
      const url = String(paramsObj.url || "").trim();
      if (!url) {
        return apiFail(res, 400, "MISSING_PARAMETER", {
          message: "Required parameter missing: url",
        });
      }
      if (!/^https?:\/\//i.test(url)) {
        return apiFail(res, 400, "BAD_URL", { message: "Url must start with http(s)" });
      }

      const policy = enforceUrlPolicy({ db, logEvent }, req, res, url);
      if (!policy.ok) return;

      if (type === "set_wallpaper") {
        const clean = url.split("#")[0].split("?")[0].toLowerCase();
        if (!clean.endsWith(".png") && !clean.endsWith(".jpg") && !clean.endsWith(".jpeg")) {
          return apiFail(res, 400, "BAD_REQUEST", { message: "Invalid file type" });
        }
      }
      break;
    }
  }

  const commandPayload = { type, ...(paramsObj || {}) };

  const commandId = crypto.randomUUID();

  logEvent({
    type: "api_command_" + type,
    actorUserId: actorId,
    targetUserId: ownerId,
    pairCode,
    req,
    payload: {
      commandId,
      command: type,
      parameters: paramsObj,
      deviceCount: deviceIds.length,
    },
  });

  const result = await sendToAllAndWait(commandId, deviceIds, commandPayload, 20000);

  if (!result.ok) {
    return apiFail(res, 409, "DEVICE_OFFLINE", { message: result.error || "No devices online" });
  }

  const anyFail = result.acks.some((a) => !a?.ok);

  incrementCommandsSentTotal({
    senderDiscordId: actorId,
    targetOwnerDiscordId: ownerId,
  });

  return res.json({
    ok: !anyFail,
    message: anyFail ? "Some devices rejected/failed" : "Sent to device",
    sent: result.sent,
    acks: result.acks,
  });
});

app.get(
  "/api/device/:pairCode/board",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode))
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved)
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });

    if (!isAllowedByWhitelist(resolved.ownerUserId, req.user.discord_id)) {
      return res.status(403).json({ ok: false, code: "NOT_WHITELISTED" });
    }

    const messages = getBoardMessages(resolved.ownerUserId, 10);
    const latestCreatedAt = messages.length
      ? Number(messages[0].created_at)
      : 0;

    res.json({
      ok: true,
      ownerUserId: resolved.ownerUserId,
      latest_created_at: latestCreatedAt,
      messages,
    });
  },
);

app.post(
  "/api/device/:pairCode/board",
  requireDiscord,
  requireNotBanned,
  (req, res) => {
    const pairCode = String(req.params.pairCode || "").trim();
    if (!/^\d{6}$/.test(pairCode))
      return res.status(400).json({ ok: false, code: "BAD_PAIR_CODE" });

    const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
    if (!resolved)
      return res.status(404).json({ ok: false, code: "UNKNOWN_CODE" });

    if (req.user.discord_id !== resolved.ownerUserId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER" });
    }

    let body = String(req.body?.body || "").trim();

    if (!body) {
      return res.status(400).json({ ok: false, message: "Message required." });
    }

    if (body.length > 200) {
      body = body.slice(0, 200);
    }

    const createdAt = postBoardMessageTx(resolved.ownerUserId, body);

    logEvent({
      type: "device_board_post",
      actorUserId: req.user.discord_id,
      targetUserId: resolved.ownerUserId,
      pairCode,
      req,
      payload: { body, createdAt },
    });

    const messages = getBoardMessages(resolved.ownerUserId, 10);
    return res.json({ ok: true, createdAt, messages });
  },
);

app.post("/api/device/:pairCode/popup", requireDiscord, async (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();
  const message = String(req.body?.message || "").trim();
  if (!message) return res.send("Missing message");

  const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
  if (!resolved) return res.send("Invalid code");

  if (!isAllowedByWhitelist(resolved.ownerUserId, req.user.discord_id)) {
    return res.send("Not allowed");
  }

  const commandId = crypto.randomUUID();

  logEvent({
    type: "command_message",
    actorUserId: req.user.discord_id,
    targetUserId: resolved.ownerUserId,
    pairCode,
    req,
    payload: { commandId, message, deviceCount: resolved.deviceIds.length }
  });

  const result = await sendToAllAndWait(commandId, resolved.deviceIds, { type: "popup", message }, 15000);

  if (!result.ok) return res.send(result.error || "No devices online");

  const failed = result.acks.some((a) => !a?.ok);
  if (!failed) return res.send("Sent to device");

  return res.send(renderAcks(result.acks));
});

app.post("/api/device/:pairCode/open_url", requireDiscord, async (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();
  const url = String(req.body?.url || "").trim();

  if (!/^https?:\/\//i.test(url)) return res.send("Invalid URL");

  const policy = enforceUrlPolicy({ db, logEvent }, req, res, url);
  if (!policy.ok) return;

  const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
  if (!resolved) return res.send("Invalid code");

  if (!isAllowedByWhitelist(resolved.ownerUserId, req.user.discord_id)) {
    return res.send("Not allowed");
  }

  const commandId = crypto.randomUUID();

  logEvent({
    type: "command_url",
    actorUserId: req.user.discord_id,
    targetUserId: resolved.ownerUserId,
    pairCode,
    req,
    payload: { commandId, url, deviceCount: resolved.deviceIds.length }
  });

  const result = await sendToAllAndWait(commandId, resolved.deviceIds, { type: "open_url", url }, 15000);

  if (!result.ok) return res.send(result.error || "No devices online");

  const failed = result.acks.some((a) => !a?.ok);
  if (!failed) return res.send("Sent to device");

  return res.send(renderAcks(result.acks));
});

app.post("/api/device/:pairCode/image_popup", requireDiscord, async (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();
  const url = String(req.body?.url || "").trim();

  if (!/^https?:\/\//i.test(url)) return res.send("Invalid URL");

  const policy = enforceUrlPolicy({ db, logEvent }, req, res, url);
  if (!policy.ok) return;

  const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
  if (!resolved) return res.send("Invalid code");

  if (!isAllowedByWhitelist(resolved.ownerUserId, req.user.discord_id)) {
    return res.send("Not allowed");
  }

  const commandId = crypto.randomUUID();

  logEvent({
    type: "command_image",
    actorUserId: req.user.discord_id,
    targetUserId: resolved.ownerUserId,
    pairCode,
    req,
    payload: { commandId, url, deviceCount: resolved.deviceIds.length }
  });

  const result = await sendToAllAndWait(commandId, resolved.deviceIds, { type: "image_popup", url }, 20000);

  if (!result.ok) return res.send(result.error || "No devices online");

  const failed = result.acks.some((a) => !a?.ok);
  if (!failed) return res.send("Sent to device");

  return res.send(renderAcks(result.acks));
});

app.post("/api/device/:pairCode/set_wallpaper", requireDiscord, async (req, res) => {
  const pairCode = String(req.params.pairCode || "").trim();
  const url = String(req.body?.url || "").trim();

  if (!/^https?:\/\//i.test(url)) return res.send("Invalid URL");

  const clean = url.split("#")[0].split("?")[0].toLowerCase();
  if (!clean.endsWith(".png") && !clean.endsWith(".jpg") && !clean.endsWith(".jpeg")) {
    return res.send("Invalid file type");
  }

  const policy = enforceUrlPolicy({ db, logEvent }, req, res, url);
  if (!policy.ok) return;

  const resolved = resolveOwnerAndDevicesByPairCode(pairCode);
  if (!resolved) return res.send("Invalid code");

  if (!isAllowedByWhitelist(resolved.ownerUserId, req.user.discord_id)) {
    return res.send("Not allowed");
  }

  const commandId = crypto.randomUUID();

  logEvent({
    type: "command_set_wallpaper",
    actorUserId: req.user.discord_id,
    targetUserId: resolved.ownerUserId,
    pairCode,
    req,
    payload: { commandId, url, deviceCount: resolved.deviceIds.length }
  });

  const result = await sendToAllAndWait(commandId, resolved.deviceIds, { type: "set_wallpaper", url }, 20000);

  if (!result.ok) return res.send(result.error || "No devices online");

  const failed = result.acks.some((a) => !a?.ok);
  if (!failed) return res.send("Sent to device");

  return res.send(renderAcks(result.acks));
});

app.post("/favorites/toggle", requireDiscord, (req, res) => {
  const me = req.viewUser.discord_id;
  const target = String(req.body?.discordId || "");

  if (!target)
    return res.status(400).json({ ok: false, error: "missing_discordId" });
  if (target === me)
    return res.status(400).json({ ok: false, error: "cannot_favorite_self" });

  const exists = db
    .prepare(
      `
    SELECT 1 FROM favorites
    WHERE user_id = ? AND favorite_user_id = ?
  `,
    )
    .get(me, target);

  if (exists) {
    db.prepare(
      `DELETE FROM favorites WHERE user_id = ? AND favorite_user_id = ?`,
    ).run(me, target);
    return res.json({ ok: true, favorited: false });
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO favorites (user_id, favorite_user_id) VALUES (?, ?)`,
    ).run(me, target);
    return res.json({ ok: true, favorited: true });
  }
});

app.use(express.static(path.join(__dirname, "../public")));

function loadCatalogItems() {
  const file = path.join(__dirname, CATALOG);
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  const items = Array.isArray(data.items) ? data.items : [];
  return items
    .map((it) => ({
      key: String(it.key || "").trim(),
      label: String(it.label || "").trim(),
      sort: Number.isFinite(Number(it.sort)) ? Number(it.sort) : 0,
    }))
    .filter((it) => it.key && it.label);
}

function syncCatalogToDb() {
  const items = loadCatalogItems();
  const now = Date.now();

  const upsert = db.prepare(`
    INSERT INTO list_items (key, label, sort_order, created_at)
    VALUES (@key, @label, @sort, @created_at)
    ON CONFLICT(key) DO UPDATE SET
      label=excluded.label,
      sort_order=excluded.sort_order
  `);

  const tx = db.transaction(() => {
    for (const it of items) upsert.run({ ...it, created_at: now });

    if (CATALOG_PRUNE) {
      const delMissing = db.prepare(`
        DELETE FROM list_items
        WHERE key NOT IN (${items.map((_, i) => `@k${i}`).join(",") || "''"})
      `);

      const args = {};
      items.forEach((it, i) => (args[`k${i}`] = it.key));
      delMissing.run(args);
    }
  });

  tx();
  console.log(
    `[catalog] synced ${items.length} items` +
      (CATALOG_PRUNE ? " (prune ON)" : " (prune OFF)"),
  );
}

syncCatalogToDb();

function getCatalogItems() {
  return db
    .prepare(
      `
    SELECT key, label
    FROM list_items
    ORDER BY sort_order ASC, label COLLATE NOCASE ASC
  `,
    )
    .all();
}

function getUserSelections(userId) {
  const rows = db
    .prepare(
      `
    SELECT list_key, item_key
    FROM user_list_items
    WHERE user_id=?
  `,
    )
    .all(userId);

  const out = { favorites: new Set(), dislikes: new Set() };
  for (const r of rows) {
    if (!out[r.list_key]) out[r.list_key] = new Set();
    out[r.list_key].add(r.item_key);
  }
  return out;
}

function setUserItem(userId, listKey, itemKey, enabled) {
  if (!LISTS[listKey]) throw new Error("bad_list_key");

  const exists = db
    .prepare(`SELECT key FROM list_items WHERE key=?`)
    .get(itemKey);
  if (!exists) throw new Error("bad_item_key");

  const otherListKey = listKey === "favorites" ? "dislikes" : "favorites";

  const tx = db.transaction(() => {
    if (enabled) {
      db.prepare(
        `
        DELETE FROM user_list_items
        WHERE user_id=? AND list_key=? AND item_key=?
      `,
      ).run(userId, otherListKey, itemKey);

      db.prepare(
        `
        INSERT OR IGNORE INTO user_list_items (user_id, list_key, item_key, created_at)
        VALUES (?, ?, ?, ?)
      `,
      ).run(userId, listKey, itemKey, Date.now());
    } else {
      db.prepare(
        `
        DELETE FROM user_list_items
        WHERE user_id=? AND list_key=? AND item_key=?
      `,
      ).run(userId, listKey, itemKey);
    }
  });

  tx();
}

app.get("/download/client", requireDiscord, requireNotBanned, (req, res) => {
  const filePath = path.join(
    __dirname,
    "../downloads",
    "PlayCtrl.me Client_0.1.10_x64-setup.exe",
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).type("html").send("Client installer not found.");
  }

  res.download(filePath, "PlayCtrl.me-setup.exe");
});

app.get("/admin", requireDiscord, requireAdmin, (req, res) => {
  renderWithLayout(res, "pages/admin/admin_main", {
    title: "PlayCtrl.me",
  });
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

  const page = Math.max(1, parseIntSafe(req.query.page, 1));
  const q = String(req.query.q || "").trim();
  const typesParam = String(req.query.types || "").trim();
  const selectedTypes = typesParam
    ? typesParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  res.locals.q = q;
  res.locals.selectedTypes = selectedTypes;

  const typeRows = db
    .prepare(
      `
    SELECT type, COUNT(*) as c
    FROM events
    GROUP BY type
    ORDER BY c DESC
    LIMIT 80
  `,
    )
    .all();
  res.locals.allTypes = typeRows.map((r) => r.type);

  const where = [];
  const args = {};

  if (q) {
    where.push(`
      (
        e.type LIKE @q OR
        e.actor_user_id LIKE @q OR
        e.target_user_id LIKE @q OR
        e.pair_code LIKE @q OR
        e.device_id LIKE @q OR
        e.payload LIKE @q OR
        au.username LIKE @q OR
        au.global_name LIKE @q OR
        tu.username LIKE @q OR
        tu.global_name LIKE @q
      )
    `);
    args.q = `%${q}%`;
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
    const avatarUrl = discordAvatarUrl({ discord_id: id, avatar }, 64);
    return `
      <span class="uChip" data-uid="${escapeHtml(id)}">
        <img class="uAv" src="${escapeHtml(avatarUrl)}" alt="" />
        <span class="uNm">${escapeHtml(display)}</span>
        <span class="uId">${escapeHtml(id)}</span>
      </span>
    `;
  }
  res.locals.userChip = userChip;

  res.locals.cards = rows.map((r) => {
    const when = new Date(r.created_at).toISOString();
    const payloadObj = tryJson(r.payload);
    const pretty = payloadObj
      ? JSON.stringify(payloadObj, null, 2)
      : String(r.payload || "");

    let summary = "";
    if (payloadObj && typeof payloadObj === "object") {
      const title = payloadObj.title ? `title="${payloadObj.title}"` : "";
      const msg = payloadObj.message
        ? `message="${String(payloadObj.message).slice(0, 80)}"`
        : "";
      const url = payloadObj.url ? `url="${payloadObj.url}"` : "";
      const cmdId = payloadObj.commandId ? `cmd=${payloadObj.commandId}` : "";
      summary = [cmdId, title, msg, url].filter(Boolean).join(" • ");
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

      when,
      summary,
      pretty,
    };
  });

  function qs(nextPage) {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
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

  const codeHtml = codes
    .map(
      (c) =>
        `<li style="font-family:monospace;font-size:16px;">${escapeHtml(c)}</li>`,
    )
    .join("");

  res.type("html").send(
    layout({
      title: "Invites Generated",
      user: req.viewUser,
      isAdmin: req.viewIsAdmin,
      body: `
      <h1>Invite codes generated</h1>
      <p>Copy these now — you won’t be able to view them again.</p>
      <ol>${codeHtml}</ol>
      <p><a href="/admin/invites">Back to Invites</a></p>
    `,
    }),
  );
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
    api_limit: "COALESCE(u.api_rate_limit, 0)",
  };

  const orderBy = SORT_MAP[sortKey] || SORT_MAP.commands;

  const total = Number(
    db
      .prepare(
        `
    SELECT COUNT(*) AS n
    FROM users u
    LEFT JOIN pair_codes pc
      ON pc.rowid = (
        SELECT MAX(rowid) FROM pair_codes WHERE user_id = u.discord_id
      )
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

  res.locals.rows = db
    .prepare(
      `
    SELECT
      u.discord_id,
      u.username,
      u.global_name,
      u.avatar,
      COALESCE(u.commands_sent_total, 0) AS commands_sent_total,
      COALESCE(u.api_rate_limit, 0) AS api_rate_limit,
      pc.code_plain AS pair_code
    FROM users u
    LEFT JOIN pair_codes pc
      ON pc.rowid = (
        SELECT MAX(rowid) FROM pair_codes WHERE user_id = u.discord_id
      )
    ${whereSql}
    ORDER BY ${orderBy} ${dir}, u.discord_id ASC
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `,
    )
    .all(args);

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
  "/admin/users/set-commands",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    try {
      const targetId = String(req.body?.discord_id || "").trim();
      const nRaw = req.body?.commands_sent_total;
      const n = Number.parseInt(String(nRaw), 10);

      if (!/^\d{10,20}$/.test(targetId)) {
        return res.status(400).json({ ok: false, message: "Bad discord id" });
      }
      if (!Number.isFinite(n) || n < 0) {
        return res
          .status(400)
          .json({ ok: false, message: "Bad commands_sent_total" });
      }

      db.prepare(
        `
      UPDATE users
      SET commands_sent_total = ?
      WHERE discord_id = ?
    `,
      ).run(n, targetId);

      logEvent({
        type: "admin_set_commands_sent",
        actorUserId: req.user.discord_id,
        targetUserId: targetId,
        req,
        payload: { commands_sent_total: n },
      });

      return res.json({ ok: true });
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

function getHostListPage(filePath, { q = "", offset = 0, limit = 200 } = {}) {
  q = String(q || "")
    .trim()
    .toLowerCase();
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.min(500, Math.max(10, Number(limit) || 200));

  const set = loadHostSetCached(
    filePath,
    filePath === ALLOWLIST_PATH ? cacheAllow : cacheBlock,
  );
  let arr = Array.from(set);
  if (q) arr = arr.filter((h) => h.includes(q));
  arr.sort();

  const total = arr.length;
  const page = arr.slice(offset, offset + limit);
  return { total, offset, limit, items: page };
}

app.get(
  "/admin/url-blocklist/list",
  requireDiscord,
  requireAdmin,
  (req, res) => {
    const which = String(req.query.which || "allow").toLowerCase();
    const q = String(req.query.q || "");
    const offset = Number(req.query.offset || 0);
    const limit = Number(req.query.limit || 200);

    const filePath = which === "block" ? BLOCKLIST_PATH : ALLOWLIST_PATH;
    const page = getHostListPage(filePath, { q, offset, limit });
    res.json({ ok: true, which, ...page });
  },
);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  let deviceId = null;

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

    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
      try {
        db.prepare(
          "UPDATE devices_v2 SET last_seen_at=? WHERE device_id=?",
        ).run(Date.now(), deviceId);
      } catch {}
    });

    wsByDeviceId.set(deviceId, ws);
    db.prepare("UPDATE devices_v2 SET last_seen_at=? WHERE device_id=?").run(
      Date.now(),
      deviceId,
    );

    ws.send(JSON.stringify({ type: "hello", deviceId }));

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      handleIncomingAck(msg);
    });

    ws.on("close", () => {
      if (deviceId && wsByDeviceId.get(deviceId) === ws)
        wsByDeviceId.delete(deviceId);
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

app.locals.discordAvatarUrl = discordAvatarUrl;
app.locals.escapeHtml = escapeHtml;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP: http://0.0.0.0:${PORT}`);
  console.log(`WS: ws://0.0.0.0:${PORT}/ws?deviceId=...&secret=...`);
  console.log("Discord ID:", process.env.DISCORD_CLIENT_ID);
});