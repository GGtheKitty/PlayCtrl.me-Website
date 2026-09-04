"use strict";

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_LENGTH = 1024 * 1024;
const MEDIA_COMMAND_TYPES = new Set(["image_popup", "fullscreen_popup"]);
const RESOLVER_SEED_KEY = "media_url_resolver_seed_v3";

const SUPPORTED_MEDIA_URL_RESOLVERS = Object.freeze([
  Object.freeze({
    key: "hypnotube_video_page",
    label: "Hypnotube video pages",
    description:
      "Fetches a Hypnotube page and extracts the direct MP4 URL used by the site player.",
    exampleUrl:
      "https://hypnotube.com/video/femdom-enticed-sissy-cocklust-154.html",
    defaultHosts: ["hypnotube.com", "www.hypnotube.com"],
    allowedOutputHosts: ["media.hypnotube.com"],
    resolveDirectMediaUrl({ html }) {
      const candidates = extractHypnotubeVideoCandidates(html);
      if (!candidates.length) return "";
      candidates.sort((a, b) => {
        const aSize = Number(a.size || 0);
        const bSize = Number(b.size || 0);
        return bSize - aSize;
      });
      return candidates[0].url;
    },
  }),
  Object.freeze({
    key: "redgifs_video_page",
    label: "Redgifs video pages",
    description:
      "Fetches a Redgifs watch page and extracts the direct MP4 URL from its public video metadata.",
    exampleUrl: "https://www.redgifs.com/watch/crazysmoggyarrowana",
    defaultHosts: ["redgifs.com", "www.redgifs.com"],
    allowedOutputHosts: ["media.redgifs.com"],
    resolveDirectMediaUrl({ html }) {
      return extractRedgifsVideoUrl(html);
    },
  }),
]);

const SUPPORTED_MEDIA_URL_RESOLVER_BY_KEY = new Map(
  SUPPORTED_MEDIA_URL_RESOLVERS.map((item) => [item.key, item]),
);

function normalizeResolverHost(rawValue) {
  const raw = String(rawValue || "").trim().toLowerCase();
  if (!raw) return "";

  try {
    const asUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(`https://${raw}`);
    const hostname = String(asUrl.hostname || "").trim().toLowerCase();
    if (!hostname) return "";
    if (!/^[a-z0-9.-]+$/.test(hostname)) return "";
    if (hostname.startsWith(".") || hostname.endsWith(".")) return "";
    if (hostname.includes("..")) return "";
    return hostname;
  } catch {
    return "";
  }
}

function isHttpUrl(rawValue) {
  try {
    const parsed = new URL(String(rawValue || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeHtmlAttribute(rawValue) {
  return String(rawValue || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#47;/gi, "/")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractTagAttribute(tag, attributeName) {
  const match = String(tag || "").match(
    new RegExp(`${attributeName}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i"),
  );
  return match ? decodeHtmlAttribute(match[2]) : "";
}

function parseCandidateSize(rawValue) {
  const match = String(rawValue || "").match(/(\d{3,4})/);
  return match ? Number(match[1]) : 0;
}

function pushUniqueCandidate(list, seen, candidate) {
  const url = String(candidate?.url || "").trim();
  if (!url || seen.has(url)) return;
  seen.add(url);
  list.push({
    url,
    size: Number(candidate?.size || 0),
  });
}

function extractHypnotubeVideoCandidates(html) {
  const source = String(html || "");
  if (!source) return [];

  const candidates = [];
  const seen = new Set();

  for (const match of source.matchAll(/<source\b[^>]*>/gi)) {
    const tag = match[0];
    const url = extractTagAttribute(tag, "src");
    const type = extractTagAttribute(tag, "type");
    if (!isHttpUrl(url)) continue;
    if (type && !/^video\//i.test(type)) continue;

    pushUniqueCandidate(candidates, seen, {
      url,
      size:
        parseCandidateSize(extractTagAttribute(tag, "size")) ||
        parseCandidateSize(extractTagAttribute(tag, "sizes")) ||
        parseCandidateSize(extractTagAttribute(tag, "res")),
    });
  }

  for (const match of source.matchAll(
    /"src"\s*:\s*"([^"]+)"[\s\S]{0,160}?"size"\s*:\s*(\d{3,4})/gi,
  )) {
    const url = decodeHtmlAttribute(match[1]).replace(/\\\//g, "/");
    if (!isHttpUrl(url)) continue;
    pushUniqueCandidate(candidates, seen, {
      url,
      size: Number(match[2] || 0),
    });
  }

  for (const match of source.matchAll(/"src"\s*:\s*"([^"]+)"/gi)) {
    const url = decodeHtmlAttribute(match[1]).replace(/\\\//g, "/");
    if (!isHttpUrl(url)) continue;
    if (!/\.mp4(?:[?#]|$)/i.test(url)) continue;
    pushUniqueCandidate(candidates, seen, {
      url,
      size: 0,
    });
  }

  return candidates;
}

function extractMetaContent(html, attributeName, attributeValue) {
  const source = String(html || "");
  const safeAttributeName = String(attributeName || "").trim();
  const safeAttributeValue = String(attributeValue || "").trim();
  if (!source || !safeAttributeName || !safeAttributeValue) return "";

  for (const match of source.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const value = extractTagAttribute(tag, safeAttributeName);
    if (value !== safeAttributeValue) continue;
    return extractTagAttribute(tag, "content");
  }

  return "";
}

function normalizeExtractedUrl(rawValue) {
  return decodeHtmlAttribute(rawValue).replace(/\\\//g, "/").trim();
}

function extractRedgifsVideoUrl(html) {
  const source = String(html || "");
  const candidates = [
    extractMetaContent(source, "property", "og:video"),
    extractMetaContent(source, "property", "og:video:secure_url"),
  ];

  const contentUrlMatch = source.match(/"contentUrl"\s*:\s*"([^"]+)"/i);
  if (contentUrlMatch) candidates.push(contentUrlMatch[1]);

  for (const candidate of candidates) {
    const url = normalizeExtractedUrl(candidate);
    if (isHttpUrl(url) && /\.mp4(?:[?#]|$)/i.test(url)) {
      return url;
    }
  }

  return "";
}

function findDefaultResolverForHost(host) {
  const normalizedHost = normalizeResolverHost(host);
  if (!normalizedHost) return null;

  return (
    SUPPORTED_MEDIA_URL_RESOLVERS.find((resolver) =>
      (resolver.defaultHosts || [])
        .map(normalizeResolverHost)
        .includes(normalizedHost),
    ) || null
  );
}

async function fetchHtmlDocument(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent":
          "PlayCtrlMediaResolver/1.0 (+https://playctrl.me)",
      },
    });

    if (!response.ok) {
      throw new Error(`upstream_status_${response.status}`);
    }

    const contentType = String(response.headers.get("content-type") || "")
      .trim()
      .toLowerCase();
    if (contentType && !contentType.includes("text/html")) {
      throw new Error("non_html_response");
    }

    const html = await response.text();
    if (!html.trim()) {
      throw new Error("empty_html");
    }

    return html.slice(0, MAX_HTML_LENGTH);
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeResolverForUi(resolver) {
  return {
    key: resolver.key,
    label: resolver.label,
    description: resolver.description,
    exampleUrl: resolver.exampleUrl,
    defaultHosts: Array.from(resolver.defaultHosts || []),
    allowedOutputHosts: Array.from(resolver.allowedOutputHosts || []),
  };
}

function createMediaUrlResolverService({ db, logEvent }) {
  const selectEnabledSiteStmt = db.prepare(`
    SELECT host, resolver_key AS resolverKey, enabled, created_at AS createdAt, updated_at AS updatedAt
    FROM media_url_resolver_sites
    WHERE host=?
      AND enabled=1
    LIMIT 1
  `);
  const listSitesStmt = db.prepare(`
    SELECT host, resolver_key AS resolverKey, enabled, created_at AS createdAt, updated_at AS updatedAt
    FROM media_url_resolver_sites
    ORDER BY enabled DESC, host ASC
  `);
  const selectSiteStmt = db.prepare(`
    SELECT host, resolver_key AS resolverKey, enabled, created_at AS createdAt, updated_at AS updatedAt
    FROM media_url_resolver_sites
    WHERE host=?
    LIMIT 1
  `);
  const upsertSiteStmt = db.prepare(`
    INSERT INTO media_url_resolver_sites (
      host,
      resolver_key,
      enabled,
      created_at,
      updated_at
    )
    VALUES (
      @host,
      @resolverKey,
      @enabled,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT(host) DO UPDATE SET
      resolver_key=excluded.resolver_key,
      enabled=excluded.enabled,
      updated_at=excluded.updated_at
  `);
  const insertDefaultSiteStmt = db.prepare(`
    INSERT OR IGNORE INTO media_url_resolver_sites (
      host,
      resolver_key,
      enabled,
      created_at,
      updated_at
    )
    VALUES (
      @host,
      @resolverKey,
      @enabled,
      @createdAt,
      @updatedAt
    )
  `);
  const repairDefaultSiteResolverStmt = db.prepare(`
    UPDATE media_url_resolver_sites
    SET resolver_key=@resolverKey,
        updated_at=@updatedAt
    WHERE host=@host
      AND resolver_key<>@resolverKey
  `);
  const deleteSiteStmt = db.prepare(`
    DELETE FROM media_url_resolver_sites
    WHERE host=?
  `);
  const readSeedStmt = db.prepare(`
    SELECT value
    FROM site_settings
    WHERE key=?
    LIMIT 1
  `);
  const writeSeedStmt = db.prepare(`
    INSERT INTO site_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);

  function logResolverEvent(event) {
    if (typeof logEvent !== "function") return;
    try {
      logEvent(event);
    } catch {}
  }

  const seedDefaultSites = db.transaction(() => {
    const seeded = readSeedStmt.get(RESOLVER_SEED_KEY);
    if (seeded) return;

    const now = Date.now();
    for (const resolver of SUPPORTED_MEDIA_URL_RESOLVERS) {
      for (const host of resolver.defaultHosts || []) {
        const row = {
          host: normalizeResolverHost(host),
          resolverKey: resolver.key,
          enabled: 1,
          createdAt: now,
          updatedAt: now,
        };
        insertDefaultSiteStmt.run(row);
        repairDefaultSiteResolverStmt.run(row);
      }
    }

    writeSeedStmt.run(RESOLVER_SEED_KEY, String(now));
  });

  seedDefaultSites();

  function listSupportedMediaUrlResolvers() {
    return SUPPORTED_MEDIA_URL_RESOLVERS.map(sanitizeResolverForUi);
  }

  function listMediaUrlResolverSites() {
    return listSitesStmt.all().map((row) => ({
      host: String(row.host || "").trim().toLowerCase(),
      resolverKey: String(row.resolverKey || "").trim(),
      enabled: !!Number(row.enabled || 0),
      createdAt: Number(row.createdAt || 0),
      updatedAt: Number(row.updatedAt || 0),
      resolver:
        sanitizeResolverForUi(
          SUPPORTED_MEDIA_URL_RESOLVER_BY_KEY.get(
            String(row.resolverKey || "").trim(),
          ) || {
            key: String(row.resolverKey || "").trim(),
            label: String(row.resolverKey || "").trim(),
            description: "",
            exampleUrl: "",
            defaultHosts: [],
            allowedOutputHosts: [],
          },
        ),
    }));
  }

  function saveMediaUrlResolverSite({ host, resolverKey = "", enabled = true } = {}) {
    const normalizedHost = normalizeResolverHost(host);
    const safeResolverKey = String(resolverKey || "").trim();
    const explicitResolver = safeResolverKey
      ? SUPPORTED_MEDIA_URL_RESOLVER_BY_KEY.get(safeResolverKey)
      : null;

    if (!normalizedHost) {
      return { ok: false, message: "Host is required." };
    }

    if (safeResolverKey && !explicitResolver) {
      return { ok: false, message: "Unsupported resolver." };
    }

    const inferredResolver = findDefaultResolverForHost(normalizedHost);
    const existingRow = selectSiteStmt.get(normalizedHost);
    const existingResolver = existingRow
      ? SUPPORTED_MEDIA_URL_RESOLVER_BY_KEY.get(
          String(existingRow.resolverKey || "").trim(),
        )
      : null;
    const resolver = explicitResolver || inferredResolver || existingResolver;

    if (!resolver) {
      return { ok: false, message: "Unsupported host." };
    }

    const now = Date.now();
    upsertSiteStmt.run({
      host: normalizedHost,
      resolverKey: resolver.key,
      enabled: enabled ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });

    return {
      ok: true,
      host: normalizedHost,
      resolverKey: resolver.key,
      enabled: !!enabled,
    };
  }

  function deleteMediaUrlResolverSite({ host } = {}) {
    const normalizedHost = normalizeResolverHost(host);
    if (!normalizedHost) {
      return { ok: false, message: "Host is required." };
    }

    deleteSiteStmt.run(normalizedHost);
    return { ok: true, host: normalizedHost };
  }

  async function resolvePopupMediaUrl({
    commandType,
    url,
    actorUserId = null,
    targetUserId = null,
    req = null,
  } = {}) {
    const safeCommandType = String(commandType || "").trim();
    const originalUrl = String(url || "").trim();

    if (!MEDIA_COMMAND_TYPES.has(safeCommandType) || !isHttpUrl(originalUrl)) {
      return {
        ok: true,
        changed: false,
        originalUrl,
        resolvedUrl: originalUrl,
        resolverKey: "",
      };
    }

    const inputUrl = new URL(originalUrl);
    const inputHost = normalizeResolverHost(inputUrl.hostname);
    const siteRow = selectEnabledSiteStmt.get(inputHost);
    if (!siteRow) {
      return {
        ok: true,
        changed: false,
        originalUrl,
        resolvedUrl: originalUrl,
        resolverKey: "",
      };
    }

    const resolverKey = String(siteRow.resolverKey || "").trim();
    const resolver = SUPPORTED_MEDIA_URL_RESOLVER_BY_KEY.get(resolverKey);
    if (!resolver) {
      return {
        ok: true,
        changed: false,
        originalUrl,
        resolvedUrl: originalUrl,
        resolverKey,
      };
    }

    try {
      const html = await fetchHtmlDocument(originalUrl);
      const resolvedUrl = String(
        resolver.resolveDirectMediaUrl({
          url: originalUrl,
          html,
        }) || "",
      ).trim();

      if (!isHttpUrl(resolvedUrl)) {
        logResolverEvent({
          type: "media_url_resolver_failed",
          actorUserId,
          targetUserId,
          req,
          payload: {
            commandType: safeCommandType,
            inputHost,
            resolverKey,
            reason: "no_direct_media_url_found",
          },
        });
        return {
          ok: true,
          changed: false,
          originalUrl,
          resolvedUrl: originalUrl,
          resolverKey,
        };
      }

      const resolvedHost = normalizeResolverHost(new URL(resolvedUrl).hostname);
      const allowedOutputHosts = Array.isArray(resolver.allowedOutputHosts)
        ? resolver.allowedOutputHosts
        : [];
      if (!allowedOutputHosts.includes(resolvedHost)) {
        logResolverEvent({
          type: "media_url_resolver_failed",
          actorUserId,
          targetUserId,
          req,
          payload: {
            commandType: safeCommandType,
            inputHost,
            resolverKey,
            resolvedHost,
            reason: "resolved_host_not_allowed",
          },
        });
        return {
          ok: true,
          changed: false,
          originalUrl,
          resolvedUrl: originalUrl,
          resolverKey,
        };
      }

      const changed = resolvedUrl !== originalUrl;
      if (changed) {
        logResolverEvent({
          type: "media_url_resolver_applied",
          actorUserId,
          targetUserId,
          req,
          payload: {
            commandType: safeCommandType,
            inputHost,
            resolverKey,
            resolvedHost,
          },
        });
      }

      return {
        ok: true,
        changed,
        originalUrl,
        resolvedUrl,
        resolvedUrlHost: resolvedHost,
        resolverKey,
      };
    } catch (error) {
      logResolverEvent({
        type: "media_url_resolver_failed",
        actorUserId,
        targetUserId,
        req,
        payload: {
          commandType: safeCommandType,
          inputHost,
          resolverKey,
          reason: String(error?.message || error || "resolver_failed"),
        },
      });

      return {
        ok: true,
        changed: false,
        originalUrl,
        resolvedUrl: originalUrl,
        resolverKey,
      };
    }
  }

  return {
    deleteMediaUrlResolverSite,
    listMediaUrlResolverSites,
    listSupportedMediaUrlResolvers,
    normalizeResolverHost,
    resolvePopupMediaUrl,
    saveMediaUrlResolverSite,
  };
}

module.exports = {
  createMediaUrlResolverService,
};
