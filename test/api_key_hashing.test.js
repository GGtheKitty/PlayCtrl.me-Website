"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  API_KEY_HASH_PREFIX,
  createApiKeyHasher,
  isGeneratedApiKey,
} = require("../src/services/api_key_hashing");

const VALID_API_KEY = `pc_${"A".repeat(43)}`;

test("API keys use a deterministic, versioned keyed hash", () => {
  const first = createApiKeyHasher({ pepper: "first-test-pepper" });
  const second = createApiKeyHasher({ pepper: "second-test-pepper" });
  const raw = VALID_API_KEY;

  const firstHash = first.hashApiKey(raw);
  assert.match(firstHash, new RegExp(`^${API_KEY_HASH_PREFIX}[a-f0-9]{64}$`));
  assert.equal(first.hashApiKey(raw), firstHash);
  assert.notEqual(second.hashApiKey(raw), firstHash);
  assert.equal(first.isCurrentApiKeyHash(firstHash), true);
});

test("legacy hashes remain detectable for one-time migration", () => {
  const hasher = createApiKeyHasher({ pepper: "test-pepper" });
  const legacyHash = hasher.legacyApiKeyLookupDigest(VALID_API_KEY);

  assert.match(legacyHash, /^[a-f0-9]{64}$/);
  assert.equal(hasher.isCurrentApiKeyHash(legacyHash), false);
  assert.notEqual(hasher.hashApiKey(VALID_API_KEY), legacyHash);
});

test("legacy migration only hashes generated high-entropy API key formats", () => {
  const hasher = createApiKeyHasher({ pepper: "test-pepper" });

  assert.equal(isGeneratedApiKey(VALID_API_KEY), true);
  assert.equal(isGeneratedApiKey(`pc_${"_".repeat(43)}`), true);
  assert.equal(isGeneratedApiKey("password"), false);
  assert.equal(isGeneratedApiKey(`pc_${"A".repeat(42)}`), false);
  assert.equal(isGeneratedApiKey(`pc_${"A".repeat(42)}!`), false);
  assert.equal(hasher.legacyApiKeyLookupDigest("password"), null);
});

test("API key hashing requires a server-side secret", () => {
  assert.throws(() => createApiKeyHasher(), /api_key_hash_pepper_required/);
});
