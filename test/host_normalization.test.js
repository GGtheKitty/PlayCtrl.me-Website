"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeHost } = require("../src/services/host_normalization");

test("normalizes host casing, whitespace, and trailing slashes", () => {
  assert.equal(normalizeHost("  EXAMPLE.COM///  "), "example.com");
  assert.equal(normalizeHost("Example.COM:8080/"), "example.com:8080");
  assert.equal(normalizeHost("example.com"), "example.com");
  assert.equal(normalizeHost("////"), "");
});

test("handles empty and non-string host values", () => {
  assert.equal(normalizeHost(), "");
  assert.equal(normalizeHost(null), "");
  assert.equal(normalizeHost(1234), "1234");
});

test("handles long attacker-controlled slash sequences deterministically", () => {
  const trailingSlashes = "/".repeat(100_000);
  assert.equal(
    normalizeHost(`EXAMPLE.COM${trailingSlashes}`),
    "example.com",
  );
  assert.equal(
    normalizeHost(`EXAMPLE.COM${trailingSlashes}x`),
    `example.com${trailingSlashes}x`,
  );
});
