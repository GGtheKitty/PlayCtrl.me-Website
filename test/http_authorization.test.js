"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { parseBearerToken } = require("../src/services/http_authorization");

test("extracts Bearer credentials without a regular expression", () => {
  assert.equal(parseBearerToken("Bearer device-token"), "device-token");
  assert.equal(parseBearerToken("bearer device-token"), "device-token");
  assert.equal(parseBearerToken("  BEARER   device-token  "), "device-token");
});

test("rejects missing, malformed, and non-Bearer authorization values", () => {
  assert.equal(parseBearerToken(), "");
  assert.equal(parseBearerToken(""), "");
  assert.equal(parseBearerToken("Bearer"), "");
  assert.equal(parseBearerToken("Bearer   "), "");
  assert.equal(parseBearerToken("Basic device-token"), "");
  assert.equal(parseBearerToken("Bearer-device-token"), "");
  assert.equal(parseBearerToken("Bearer\tdevice-token"), "");
});

test("handles long hostile values in linear time", () => {
  const token = " ".repeat(100_000) + "device-token";
  assert.equal(parseBearerToken(`Bearer ${token}`), "device-token");
});
