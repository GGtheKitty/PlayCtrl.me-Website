"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCorsOriginAllowlist,
  normalizeTrustedOrigin,
} = require("../src/services/cors_configuration");

test("builds a deduplicated exact-origin CORS allowlist", () => {
  const allowlist = buildCorsOriginAllowlist(
    "https://playctrl.me/",
    "https://app.playctrl.me, http://localhost:3000,https://playctrl.me",
  );

  assert.deepEqual(allowlist, [
    "https://playctrl.me",
    "https://app.playctrl.me",
    "http://localhost:3000",
  ]);
  assert.equal(Object.isFrozen(allowlist), true);
});

test("rejects values that are not standalone HTTP origins", () => {
  assert.equal(normalizeTrustedOrigin("*"), null);
  assert.equal(normalizeTrustedOrigin("null"), null);
  assert.equal(normalizeTrustedOrigin("javascript:alert(1)"), null);
  assert.equal(normalizeTrustedOrigin("https://user:pass@example.com"), null);
  assert.equal(normalizeTrustedOrigin("https://example.com/path"), null);
  assert.equal(normalizeTrustedOrigin("https://example.com/?query=1"), null);
});

test("normalizes trusted origins before exact matching", () => {
  assert.equal(
    normalizeTrustedOrigin(" HTTPS://EXAMPLE.COM:443/ "),
    "https://example.com",
  );
  assert.equal(
    normalizeTrustedOrigin("http://LOCALHOST:8080/"),
    "http://localhost:8080",
  );
});

test("fails closed when no valid origin is configured", () => {
  assert.throws(
    () => buildCorsOriginAllowlist("not an origin", "*,null"),
    /cors_origin_allowlist_required/,
  );
});
