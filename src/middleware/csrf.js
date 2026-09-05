"use strict";

const crypto = require("crypto");

const CSRF_COOKIE_NAME = "__Host-playctrl_csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function csrfTokenForSession(sessionId, secret) {
  const sid = String(sessionId || "").trim();
  const key = String(secret || "");
  if (!sid) throw new Error("csrf_session_id_required");
  if (!key) throw new Error("csrf_secret_required");

  return crypto
    .createHmac("sha256", key)
    .update("playctrl.csrf\0", "utf8")
    .update(sid, "utf8")
    .digest("base64url");
}

function csrfTokensEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return (
    leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function requestCsrfToken(req) {
  return String(
    req.headers?.["x-csrf-token"] || req.body?._csrf || "",
  ).trim();
}

function wantsJson(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  const requestedWith = String(
    req.headers?.["x-requested-with"] || "",
  ).toLowerCase();
  return (
    accept.includes("application/json") || requestedWith === "xmlhttprequest"
  );
}

function createCsrfProtection({ secret, secureCookies = true } = {}) {
  const csrfSecret = String(secret || "");
  if (!csrfSecret) throw new Error("csrf_secret_required");

  return function csrfProtection(req, res, next) {
    res.locals = res.locals || {};
    res.locals.csrfToken = "";

    const sessionId = String(req.cookies?.sid || "").trim();
    if (!sessionId || !req.actorUser) return next();

    const expectedToken = csrfTokenForSession(sessionId, csrfSecret);
    const csrfCookie = String(
      req.cookies?.["__Host-playctrl_csrf"] || "",
    ).trim();
    res.locals.csrfToken = expectedToken;
    res.set("Cache-Control", "private, no-store, max-age=0");

    if (!csrfTokensEqual(csrfCookie, expectedToken)) {
      res.cookie("__Host-playctrl_csrf", expectedToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: secureCookies,
        path: "/",
        maxAge: 1000 * 60 * 60 * 24 * 15,
      });
    }

    if (SAFE_METHODS.has(String(req.method || "GET").toUpperCase())) {
      return next();
    }

    const suppliedToken = requestCsrfToken(req);
    if (
      csrfTokensEqual(csrfCookie, expectedToken) &&
      csrfTokensEqual(suppliedToken, expectedToken)
    ) {
      return next();
    }

    if (wantsJson(req)) {
      return res.status(403).json({
        ok: false,
        code: "CSRF_INVALID",
        message: "This request could not be verified. Refresh the page and try again.",
      });
    }

    return res
      .status(403)
      .type("text/plain")
      .send("This request could not be verified. Refresh the page and try again.");
  };
}

module.exports = {
  CSRF_COOKIE_NAME,
  csrfTokensEqual,
  createCsrfProtection,
  csrfTokenForSession,
};
