"use strict";

const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const net = require("net");

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_LENGTH = 1024 * 1024;
const MAX_REDIRECTS = 4;
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
  const decodedEntities = {
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&#x2f;": "/",
    "&#47;": "/",
    "&lt;": "<",
    "&gt;": ">",
  };

  // Replace only entities present in the original string. A single pass keeps
  // nested input such as "&amp;quot;" from being decoded twice into a quote.
  return String(rawValue || "").replace(
    /&(amp|quot|#39|#x2f|#47|lt|gt);/gi,
    (entity) => decodedEntities[entity.toLowerCase()] || entity,
  );
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

function ipv4ToNumber(address) {
  if (net.isIP(address) !== 4) return null;
  return address
    .split(".")
    .reduce((value, octet) => value * 256 + Number(octet), 0);
}

function isIpv4InCidr(address, base, prefixLength) {
  const value = ipv4ToNumber(address);
  const baseValue = ipv4ToNumber(base);
  if (value === null || baseValue === null) return false;
  const blockSize = 2 ** (32 - prefixLength);
  return Math.floor(value / blockSize) === Math.floor(baseValue / blockSize);
}

function expandIpv6(address) {
  if (net.isIP(address) !== 6) return null;

  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...right,
  ];
  if (groups.length !== 8) return null;
  return groups.map((group) => Number.parseInt(group || "0", 16));
}

function ipv6ToBigInt(address) {
  const groups = expandIpv6(address);
  if (!groups) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(group), 0n);
}

function isIpv6InCidr(address, base, prefixLength) {
  const value = ipv6ToBigInt(address);
  const baseValue = ipv6ToBigInt(base);
  if (value === null || baseValue === null) return false;
  const shift = BigInt(128 - prefixLength);
  return value >> shift === baseValue >> shift;
}

function isPublicIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const blockedRanges = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blockedRanges.some(([base, prefix]) =>
      isIpv4InCidr(address, base, prefix),
    );
  }

  if (family === 6) {
    // Only globally routable unicast IPv6 is eligible. Explicit exclusions
    // cover special-use ranges that sit inside 2000::/3.
    if (!isIpv6InCidr(address, "2000::", 3)) return false;
    return ![
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
    ].some(([base, prefix]) => isIpv6InCidr(address, base, prefix));
  }

  return false;
}

function normalizedNetworkHostname(hostname) {
  return String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
}

function validateOutboundUrl(rawUrl) {
  const parsed = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("unsupported_upstream_protocol");
  }
  if (parsed.username || parsed.password) {
    throw new Error("upstream_credentials_not_allowed");
  }

  const expectedPort = parsed.protocol === "https:" ? "443" : "80";
  if (parsed.port && parsed.port !== expectedPort) {
    throw new Error("non_standard_upstream_port");
  }

  const hostname = normalizedNetworkHostname(parsed.hostname);
  if (!hostname) throw new Error("invalid_upstream_hostname");
  return { parsed, hostname };
}

async function resolvePublicAddress(hostname) {
  const literalFamily = net.isIP(hostname);
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });

  if (!records.length || records.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error("non_public_upstream_address");
  }

  return records[0];
}

function createPinnedLookup(record) {
  return (_hostname, options, callback) => {
    let lookupOptions = options;
    let done = callback;
    if (typeof lookupOptions === "function") {
      done = lookupOptions;
      lookupOptions = {};
    }
    if (lookupOptions?.all) {
      done(null, [{ address: record.address, family: record.family }]);
      return;
    }
    done(null, record.address, record.family);
  };
}

async function requestHtmlOnce(rawUrl) {
  const { parsed, hostname } = validateOutboundUrl(rawUrl);
  const address = await resolvePublicAddress(hostname);
  const transport = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        lookup: createPinnedLookup(address),
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent": "PlayCtrlMediaResolver/1.0 (+https://playctrl.me)",
        },
      },
      (response) => {
        const status = Number(response.statusCode || 0);
        const location = String(response.headers.location || "").trim();
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume();
          resolve({ redirectUrl: new URL(location, parsed) });
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`upstream_status_${status}`));
          return;
        }

        const contentType = String(response.headers["content-type"] || "")
          .trim()
          .toLowerCase();
        if (contentType && !contentType.includes("text/html")) {
          response.resume();
          reject(new Error("non_html_response"));
          return;
        }

        const chunks = [];
        let receivedLength = 0;
        response.on("data", (chunk) => {
          receivedLength += chunk.length;
          if (receivedLength > MAX_HTML_LENGTH) {
            response.destroy(new Error("upstream_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const html = Buffer.concat(chunks).toString("utf8");
          if (!html.trim()) {
            reject(new Error("empty_html"));
            return;
          }
          resolve({ html });
        });
        response.on("error", reject);
      },
    );

    request.setTimeout(FETCH_TIMEOUT_MS, () => {
      request.destroy(new Error("upstream_timeout"));
    });
    request.on("error", reject);
    request.end();
  });
}

async function fetchHtmlDocument(url) {
  let currentUrl = new URL(url);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const result = await requestHtmlOnce(currentUrl);
    if (!result.redirectUrl) return result.html;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error("too_many_upstream_redirects");
    }
    currentUrl = result.redirectUrl;
  }

  throw new Error("too_many_upstream_redirects");
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
  decodeHtmlAttribute,
  fetchHtmlDocument,
  isPublicIpAddress,
  validateOutboundUrl,
};
