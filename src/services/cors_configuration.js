"use strict";

function normalizeTrustedOrigin(rawOrigin) {
  const value = String(rawOrigin || "").trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildCorsOriginAllowlist(siteOrigin, configuredOrigins = "") {
  const extraOrigins = Array.isArray(configuredOrigins)
    ? configuredOrigins
    : String(configuredOrigins || "").split(",");
  const allowlist = new Set();

  for (const candidate of [siteOrigin, ...extraOrigins]) {
    const origin = normalizeTrustedOrigin(candidate);
    if (origin) allowlist.add(origin);
  }

  if (!allowlist.size) throw new Error("cors_origin_allowlist_required");
  return Object.freeze([...allowlist]);
}

module.exports = { buildCorsOriginAllowlist, normalizeTrustedOrigin };
